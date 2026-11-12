# Reading Joey

A free, open-source lending library for daycares, schools and other small libraries.
Every book gets a QR sticker; parents scan it with their phone to borrow or return,
and the app sends reminders and gives staff a live list of who has what. A shared
tablet by the shelf can be a kiosk, where families borrow with a personal code.

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
docs/                Setup and architecture notes
```

## Local development

Requires Node.js 24 or later.

```bash
npm install
npm run dev
```

Open the address Vite prints (usually http://localhost:5173). The API is under `/api`,
for example `/api/health`. Local development uses a local D1 database, so no Cloudflare
account is needed.

Before opening a pull request:

```bash
npm run check   # lint, typecheck, tests, build
npm run e2e -w @community-library/web   # the app in Chrome, with accessibility checks
```

The browser tests need Chrome for Playwright once: `npx playwright install chromium`.

## Deploying

1. Create the database near your families (the location can't be changed later), and
   copy its id into `apps/web/wrangler.jsonc`. For Australia and New Zealand:
   `npx wrangler d1 create community-library --location oc`
   (other hints: `wnam`, `enam`, `weur`, `eeur`, `apac`).
2. Attach your domain to the Worker. Choose the final address before launch:
   passkeys are tied to it.
3. In GitHub, add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`,
   and set the repository variable `DEPLOY_ENABLED` to `true`.
   Every push to `main` that passes CI then migrates the database and deploys.
4. Turn on weekly backups: see [docs/backups.md](docs/backups.md).

A one-click deploy button and setup wizard are planned for Phase 3.

## Licence

Not chosen yet (tracked in VIR-22).
