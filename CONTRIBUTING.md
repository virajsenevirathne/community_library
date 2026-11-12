# Contributing to Reading Joey

Thank you for helping little libraries lend books. Contributions of every size
are welcome: a typo, a translation, a bug report, a new feature.

## Before you start

- **Small fixes** (typos, wording, an obvious bug): open a pull request.
- **Anything bigger:** open an issue first and describe what you'd like to
  change, so we can agree on the approach before you spend time on it.
- Issues labelled **good first issue** are a friendly way in.

## Running it on your computer

You need Node.js 24 or later.

```bash
npm install
npm run dev                                   # http://localhost:5173
npm run demo-data -w @community-library/web   # optional: a library with books and families
```

No Cloudflare account is needed: the database is local, and emails (sign-in
codes included) are printed in the terminal instead of being sent. Sign in
with `admin@demo.test` to explore the demo library at `/demo-owls`.

## Checks

```bash
npm run check                                 # lint, types, unit tests, build
npm run e2e -w @community-library/web         # the app in Chrome, with accessibility checks
```

Both run on every pull request. The browser tests need Chrome for Playwright
once: `npx playwright install chromium` (in `apps/web`).

## How the code is organised

| Folder                | What's there                                                                |
| --------------------- | --------------------------------------------------------------------------- |
| `apps/web/src/worker` | The API (Hono on Cloudflare Workers), the hourly job, emails                |
| `apps/web/src/client` | The web app (React)                                                         |
| `packages/core`       | Rules with no I/O: due dates, settings, CSV, codes                          |
| `packages/adapters`   | Email, phone notifications, book lookup, labels ([guide](docs/adapters.md)) |
| `migrations`          | Database changes (D1, SQLite)                                               |

Things that matter here:

- **Every query is scoped to one library.** The database has no row-level
  security, so `access.ts` and the `library_id` filter are the safety net.
  Every API route is listed in `access.test.ts` with who may call it; the
  test fails for a route without a rule.
- **Children's details are never stored.** No children's names, ages or
  photos, anywhere.
- **Plain, friendly English** in everything people read, written for busy
  parents and volunteers. Say what happened and what to do next.
- **Accessible by default:** labels on every control, focus moves to what
  changed, nothing by colour alone, 48 px tap targets, works at 375 px wide
  and in dark mode.
- **Database changes** go in a new migration (`npm run db:generate -w
  @community-library/web` from `schema.ts`). Only add tables and columns:
  rebuilding a table cascades and deletes data.

## Pull requests

- Keep each one to one change, with tests.
- Describe what changes for people, not only the code.
- By contributing, you agree your work is released under the project's licence.

## Reporting a security problem

Please don't open a public issue. Email the maintainer (the address on the
GitHub profile) with the details, and allow time for a fix before sharing.

## Code of conduct

Everyone taking part agrees to the [code of conduct](CODE_OF_CONDUCT.md).
