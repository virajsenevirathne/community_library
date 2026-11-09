# Community Library

A free, open-source lending library for daycares, schools and other small libraries.
Every book gets a QR sticker; parents scan it with their phone to borrow or return,
and the app sends reminders and gives staff a live list of who has what.

It runs as one Cloudflare Worker with a D1 database, so a small library pays nothing to host it.

> Status: early development. The first version is being built for one daycare.

## Stack

| Part      | Choice                                                                 |
| --------- | ---------------------------------------------------------------------- |
| Hosting   | One Cloudflare Worker (API + static app), free plan                    |
| API       | [Hono](https://hono.dev)                                               |
| Web app   | React + Vite, installable as a home-screen app                         |
| Database  | Cloudflare D1 (SQLite)                                                 |
| Sign-in   | Better Auth: 6-digit email codes and passkeys (coming in VIR-7, VIR-8) |
| Email     | Resend, with Mailjet as fallback (coming in VIR-24)                    |
| Reminders | Cloudflare Cron Trigger                                                |

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
```

## Deploying

1. Create the database and copy its id into `apps/web/wrangler.jsonc`:
   `npx wrangler d1 create community-library`
2. Attach your domain to the Worker. Choose the final address before launch:
   passkeys are tied to it.
3. In GitHub, add the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`,
   and set the repository variable `DEPLOY_ENABLED` to `true`.
   Every push to `main` that passes CI then migrates the database and deploys.

A one-click deploy button and setup wizard are planned for Phase 3.

## Licence

Not chosen yet (tracked in VIR-22).
