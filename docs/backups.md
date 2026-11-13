# Backups and restoring

> **For library admins:** you don't need to do any of this yourself. Ask
> whoever set up and runs the site. The steps below are for them.

The library's data lives in one Cloudflare D1 database. There are two safety
nets:

| What               | Covers                                        | How far back                         | Set up        |
| ------------------ | --------------------------------------------- | ------------------------------------ | ------------- |
| **D1 Time Travel** | Mistakes: a wrong bulk change, a bad deploy   | 7 days on the free plan (30 on paid) | Always on     |
| **Weekly export**  | Losing the database or the Cloudflare account | 30 days (4 weekly copies)            | Turn on below |

Both hold families' names and email addresses. The weekly export is encrypted
before it is stored, and it is deleted after 30 days, as the privacy notice says.

## Turning on the weekly export

The export runs from GitHub Actions (`.github/workflows/backup.yml`) every
Sunday at 15:00 UTC, which is early Monday morning in Australia.

1. Create a Cloudflare API token just for backups, with only **D1: Edit**
   permission for your account (exporting needs edit access). Don't reuse the
   deploy token: a backup token that leaks then can't deploy code.
2. In the GitHub repository, open **Settings › Secrets and variables › Actions**
   and add these secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `BACKUP_PASSPHRASE`: a random passphrase of at least 32 characters, made
     with `openssl rand -base64 32` (not one you make up: once the repository
     is public, anyone signed in to GitHub can download the encrypted backups
     and try to guess it). **Keep a copy somewhere safe outside GitHub**, such
     as a password manager. Without it, backups can't be opened.
3. Add the repository variable `BACKUP_ENABLED` with the value `true`.
4. Run it once by hand: **Actions › Backup › Run workflow**. Check that it
   finishes and that a `library-backup-<date>` file appears on the run's page.
   Each run also checks that its backup decrypts and contains the database.

### Keep these too

- **The site's secrets.** Keep a copy of `BETTER_AUTH_SECRET` (and the email
  keys) in the same password manager. A restored database needs the same
  `BETTER_AUTH_SECRET`: without it, kiosk PINs and links in old emails stop
  working.
- **An eye on the runs.** GitHub emails the repository owner when a run fails.
  It also turns off scheduled workflows after 60 days without any activity in
  a public repository: if that email arrives, turn the workflow back on under
  **Actions › Backup**.

## Restoring

### A mistake in the last 7 days: Time Travel

Find a moment from just before the mistake, then restore the database to it.
This replaces everything in the live database with its state at that moment,
including anything families did after it.

```bash
cd apps/web
# What the database looked like at a time (UTC, or with a timezone):
# (replace the date with a moment just before the mistake, such as 2026-03-02T09:00:00+11:00)
npx wrangler d1 time-travel info DB --timestamp "<time before the mistake>"
# Restore it. Wrangler prints a bookmark you can use to undo this restore.
npx wrangler d1 time-travel restore DB --timestamp "<time before the mistake>"
```

### Anything older, or a lost database: the weekly export

1. Download the backup from the run's page (Actions › Backup), or with the
   GitHub CLI: `gh run download <run-id> -n library-backup-<date>`.
2. Decrypt and unpack it:

   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
     -in library-<date>.sql.gz.enc -out library.sql.gz
   gunzip library.sql.gz
   ```

   `openssl` asks for the passphrase.
3. Load it into an **empty** database. Never load it into the live one: it
   would clash with the rows already there.

   ```bash
   cd apps/web
   npx wrangler d1 create community-library-restored
   npx wrangler d1 execute community-library-restored --remote --file ../../library.sql
   ```

4. Point the site at it: in `apps/web/wrangler.jsonc`, set `database_name` and
   `database_id` to the new database (wrangler printed its id), then deploy
   with `npm run deploy`.
5. Delete the decrypted `library.sql` and `library.sql.gz` straight away: they
   aren't encrypted.
6. Everyone signed in at the time of the backup is signed in again. To sign
   everyone out after a restore, run
   `npx wrangler d1 execute DB --remote --command "delete from sessions"`.

The export includes the record of applied migrations, so the restored database
continues with the next migration as usual.

### After any restore

A restore brings back everything as it was at that moment, including accounts
and families deleted since, and sign-ins that have since been signed out. So:

- Ask each library's staff whether anyone left or deleted their account since
  the backup, and remove them again (Families › More › Remove family). The
  privacy notice promises deleted details are gone.
- Books borrowed or returned since the backup are missing: staff can check the
  shelf against the Loans page.

### Trying a restore without touching anything live

Restore into a local database to check that a backup opens and is complete:

```bash
cd apps/web
npx wrangler d1 execute DB --local --persist-to /tmp/restore-check --file ../../library.sql
npx wrangler d1 execute DB --local --persist-to /tmp/restore-check \
  --command "select (select count(*) from libraries) as libraries, (select count(*) from loans) as loans"
```

This guide was tested by exporting a database, encrypting and decrypting the
export, loading it into an empty local database, and comparing the row counts
of every table with the original.
