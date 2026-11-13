# Reading Joey

A free lending library for daycares, schools and other small libraries.
Every book gets a QR sticker; parents scan it with their phone to borrow or return,
and the app sends reminders and gives staff a live list of who has what. A shared
tablet by the shelf can be a kiosk, where families borrow with a personal PIN.

It runs as one Cloudflare Worker with a D1 database, so a small library pays nothing to
host it. One site can hold many libraries, each at its own address (`/little-owls`).

> Status: in use at its first daycare, readingjoey.com.

## Stack

| Part      | Choice                                              |
| --------- | --------------------------------------------------- |
| Hosting   | One Cloudflare Worker (API + static app), free plan |
| API       | [Hono](https://hono.dev)                            |
| Web app   | React + Vite, installable as a home-screen app      |
| Database  | Cloudflare D1 (SQLite)                              |
| Sign-in   | Better Auth: 6-digit email codes and passkeys       |
| Email     | Resend, with Mailjet as fallback                    |
| Reminders | Cloudflare Cron Trigger                             |

## Repository layout

```
apps/web/            The Worker: Hono API (src/worker) and React app (src/client)
packages/core/       Business rules (loan limits, due dates), no UI or database code
packages/adapters/   Email senders, book lookup, label templates
migrations/          D1 SQL migrations
docs/                Guides, such as backups and restoring
```

## Local development

Requires Node.js 24 or later.

```bash
npm install
cp apps/web/.dev.vars.example apps/web/.dev.vars
# Put any long random text after BETTER_AUTH_SECRET= in apps/web/.dev.vars, for example from:
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
npm run db:migrate:local -w @community-library/web   # create the local database
npm run demo-data -w @community-library/web          # optional: a demo library to explore
npm run dev
```

Open the address Vite prints (usually http://localhost:5173). The API is under `/api`,
for example `/api/health`. Local development uses a local D1 database, so no Cloudflare
account is needed. Emails, sign-in codes included, are printed in the terminal.
After a `git pull`, run `npm run db:migrate:local -w @community-library/web` again.

Before opening a pull request:

```bash
npm run check   # lint, typecheck, tests, build
npm run e2e -w @community-library/web   # the app in real browsers, with accessibility checks
```

The browser tests run in Chrome; parents' main flows also run in Safari's engine
(WebKit, as an iPhone) and Firefox. Install them for Playwright once:
`npx playwright install chromium webkit firefox`.

## Deploying your own site

Follow [docs/setup.md](docs/setup.md): a step-by-step guide for non-developers,
from a Cloudflare account to your first library, in about 30 minutes. In short:

1. Create the database near your families (`npx wrangler d1 create community-library --location oc`)
   and put its id, your address and your email sender in `apps/web/wrangler.jsonc`.
2. Set the secrets: `RESEND_API_KEY`, `BETTER_AUTH_SECRET`, `SETUP_CODE` (and optionally
   Mailjet as a backup, and `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` for phone notifications).
3. `npm run deploy -w @community-library/web` builds the site, updates the database and publishes.
4. Open the site, sign in, and enter the setup code: your owner page lists anything still missing.
5. Turn on weekly backups: [docs/backups.md](docs/backups.md).

To deploy from GitHub instead, add the secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` and set the repository variable `DEPLOY_ENABLED` to `true`:
every push to `main` that passes CI then migrates the database and deploys.

## More

- [Setting up your own site](docs/setup.md)
- [Backups and restoring](docs/backups.md)
- [Adapters and webhooks](docs/adapters.md): email, phone notifications, book lookup, signed webhooks
- [Contributing](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md)

## Licence

Not chosen yet (tracked in VIR-22).
