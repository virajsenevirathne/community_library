# Backups and restoring

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

1. Create a Cloudflare API token with **D1: Edit** permission for your account.
   You can reuse the deploy token if it has that permission.
2. In the GitHub repository, open **Settings › Secrets and variables › Actions**
   and add these secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `BACKUP_PASSPHRASE`: a long random passphrase (at least 16 characters),
     for example from `openssl rand -base64 32`. **Keep a copy somewhere safe
     outside GitHub**, such as a password manager. Without it, backups can't be
     opened.
3. Add the repository variable `BACKUP_ENABLED` with the value `true`.
4. Run it once by hand: **Actions › Backup › Run workflow**. Check that it
   finishes and that a `library-backup-<date>` file appears on the run's page.

## Restoring

### A mistake in the last 7 days: Time Travel

Find a moment from just before the mistake, then restore the database to it.
This replaces everything in the live database with its state at that moment,
including anything families did after it.

```bash
cd apps/web
# What the database looked like at a time (UTC, or with a timezone):
npx wrangler d1 time-travel info DB --timestamp "2026-11-20T09:00:00+11:00"
# Restore it. Wrangler prints a bookmark you can use to undo this restore.
npx wrangler d1 time-travel restore DB --timestamp "2026-11-20T09:00:00+11:00"
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
5. Delete the unpacked `library.sql` once you're done, since it isn't encrypted.

The export includes the record of applied migrations, so the restored database
continues with the next migration as usual.

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
