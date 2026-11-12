# Setting up your own Reading Joey site

This guide takes you from nothing to a working site for your libraries. You
don't need to be a developer, but you'll copy a few commands into a terminal.
Allow about 30 minutes, plus waiting time for your domain's email checks.

You need:

- A computer with [Node.js](https://nodejs.org) 24 or later.
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account (hosting
  and the database).
- A domain name, such as `library.example.org`, added to Cloudflare. Buying it
  through Cloudflare Registrar is the simplest.
- A free [Resend](https://resend.com) account, for email.

## 1. Get the code

```bash
git clone https://github.com/virajsenevirathne/community_library.git
cd community_library
npm install
npx wrangler login
```

`wrangler login` opens your browser to connect to your Cloudflare account.

## 2. Choose your address, and create the database

Choose the address people will use, and keep it: passkeys (Face ID sign-in)
only work on the address they were saved on.

```bash
cd apps/web
# "oc" puts the database near Australia and New Zealand. Others: wnam, enam, weur, eeur, apac.
npx wrangler d1 create community-library --location oc
```

Open `apps/web/wrangler.jsonc` and change:

| Setting                        | Change it to                                             |
| ------------------------------ | -------------------------------------------------------- |
| `routes` → `pattern`           | your address, such as `library.example.org`              |
| `d1_databases` → `database_id` | the id the command above printed                         |
| `vars` → `APP_URL`             | `https://` and your address                              |
| `vars` → `EMAIL_FROM`          | an address on your domain, such as `library@example.org` |
| `vars` → `LIBRARY_NAME`        | your site's name                                         |
| `vars` → `CONTACT_EMAIL`       | where "Ask for a library" emails go, or leave it empty   |

## 3. Set up email

1. In Resend, add your domain and follow its steps to add the DNS records in
   Cloudflare. Wait until Resend says the domain is verified.
2. Create an API key in Resend, then:

   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```

   Paste the key when asked. (Optional: a free Mailjet account as a backup,
   with `MAILJET_API_KEY` and `MAILJET_API_SECRET`.)

Gmail can't be used: the site sends email through these services' web
interfaces, which Gmail doesn't offer.

## 4. Set the other secrets

```bash
# Signs everyone's sign-in. Any long random text:
openssl rand -base64 32          # copy what it prints, then:
npx wrangler secret put BETTER_AUTH_SECRET

# A one-time code that lets only you set the site up. 16 characters or more:
openssl rand -base64 18          # copy it, then:
npx wrangler secret put SETUP_CODE
```

Keep both in a password manager. Optional, for phone notifications:

```bash
npm run vapid-keys               # prints two keys
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

## 5. Deploy

```bash
npm run deploy
```

This builds the site, brings the database up to date and publishes it. Run the
same command whenever you update the code.

## 6. Set up the site, then your first library

1. Open your address and sign in with your email. The site asks for the
   setup code from step 4: you become the site's owner.
2. Your owner page shows a **Site checklist**. Anything marked "To do" says
   what to set.

   ![The owner page, with the site checklist](images/owner-checklist.png)

3. Create a library and invite its admin (that can be you). The admin opens
   the email and signs in. The library first asks how returns work and for the
   terms to be accepted; everything else (loan length, books per family, closed
   days, its colour) is in **Settings**.

   ![A library's settings](images/settings.png)

4. The admin adds books (scan the barcode on the back), prints the QR stickers
   (Labels), and shares the sign-up link or poster with families.

Families then scan a sticker with their phone camera to borrow:

![A book's page on a phone](images/phone-book.png)

## 7. Before families join

- [ ] In Cloudflare, under your domain's **SSL/TLS › Edge Certificates**, turn
  on **Always Use HTTPS**.
- [ ] Turn on the weekly backups: [backups.md](backups.md).
- [ ] Read the privacy notice and terms at `/privacy` and `/terms`, and have
  them checked for your country before you rely on them.

## Updating

```bash
git pull
npm install
cd apps/web && npm run deploy
```

## If something goes wrong

- **Nobody gets a sign-in code:** the checklist's "Email can be sent" item, and
  in Resend, check the domain is verified.
- **Passkeys stop working:** the address changed. Use the address in
  `APP_URL`; passkeys saved elsewhere need saving again.
- **Reminders stop:** each library's dashboard warns when the hourly job
  hasn't run. Check **Workers › your Worker › Triggers** in
  Cloudflare.
