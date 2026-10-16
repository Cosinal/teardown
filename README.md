# Tearitdown

Tearitdown turns a business idea into a nine-section market readout: alternatives, demand evidence, economics, distribution, blockers, the riskiest assumptions, the next tests to run, and a verdict (pursue, test first, or drop). Claims are sourced and fact-checked.

The public site is a waitlist. Tearitdown is **building**, not live: the homepage CTA is waitlist-only, and no price is shown on public pages. Intake, checkout, and paid reports exist behind an admin gate and owner cookies.

This repo is the Next.js (App Router, TypeScript) app. The GitHub repo is `Cosinal/teardown`.

## Stack

- **Next.js** App Router + **TypeScript** (React 19), deployed on **Vercel**.
- **Neon Postgres** via `@neondatabase/serverless` (`lib/db.ts`). Schema is created and extended in `init()`: additive `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` only.
- **Anthropic** Claude (intake, web-search research, section writers, fact-check). Billable.
- **Stripe** Checkout: one-time payment per teardown (no subscription). Test-mode keys outside production.
- **PDF export**: `puppeteer-core` + `@sparticuz/chromium` on `GET /t/[id]/pdf` (Node.js function, `maxDuration` 60). Same owner/admin gate as the report page.
- Vercel Web Analytics and Speed Insights in `app/layout.tsx`.

## Local setup

Requirements: Node 20+ and a Neon Postgres database (the production one from Vercel’s Neon integration, or a separate dev branch).

```bash
npm install
cp .env.example .env.local   # then fill in the names below; never commit values
npm run dev                  # http://localhost:3000
```

To pull env vars from the linked Vercel project instead, run `vercel env pull .env.local`.

`init()` runs on first database request: it creates tables if needed and adds missing columns. Existing signup rows are never modified or dropped.

Checks:

```bash
npm run typecheck
npm run lint
npm test                 # vitest unit tests, no network
npm run build
```

Engine dev run (billable, needs `ANTHROPIC_API_KEY`): `npm run test:ideas` runs the full pipeline on three test ideas and writes output to `tests/runs/<timestamp>/` (gitignored). With `DATABASE_URL` set it also stores the teardowns and their sources; pass `-- --no-db` to skip the database. Point `DATABASE_URL` at a Neon **dev** branch for this, since schema setup runs `ALTER TABLE`. Record per-idea counts and costs in `tests/runs-summary.md`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server. |
| `npm run build` | Production build. |
| `npm start` | Serve the production build. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint. |
| `npm test` | Vitest, once, no network. |
| `npm run test:ideas` | Full engine on the three test ideas (billable). |

Other one-off scripts (run with `npx tsx`): `scripts/cache-hit-rate.ts`, `scripts/stage-timings.ts`, `scripts/factcheck-saved.ts`.

## Environment variables

Names only. Values live in `.env.local` or Vercel. Never commit `.env*` files; only `.env.example` is tracked.

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string. |
| `ADMIN_KEY` | Secret for admin list/delete on `/api/subscribe`, and to unlock `/new` and `/admin` via `?key=…` (sets a cookie). Admin access is disabled if unset. |
| `ANTHROPIC_API_KEY` | Claude API key for the teardown engine. Create it inside an Anthropic workspace; org-level keys without a workspace are rejected. The waitlist site runs without it. |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_…` outside production): Checkout Sessions and refunds. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_…`) of the webhook endpoint for `/api/stripe/webhook`. |
| `STRIPE_PRICE_ID` | The one-time Stripe Price a teardown is sold at. Do not put that amount on public pages. |

## Routes

| Route | Description |
| --- | --- |
| `/` | Waitlist landing page. `?ref=<code>` is stored with the signup. Copy says opening soon / building; no price. |
| `/privacy`, `/data` | Privacy Policy and Data Policy. |
| `/new` | Intake form (**admin-gated**). Saves the teardown as `awaiting_payment`, sets its owner cookie, and redirects to Stripe Checkout. An admin can tick “skip payment” to queue and run it directly. `?draft=<id>` (Checkout’s cancel URL) refills the answers. |
| `/admin` | Admin dashboard (same cookie as `/new`): waitlist, sales, run metrics, first-party traffic. Everyone else gets 404. |
| `/t/[id]` | The report, or a waiting/cooking page (refreshes every 15s) while there is no report. Only its owner cookie or the admin cookie can see it; everyone else gets a private page that points at the waitlist. |
| `/t/sample` | Public design fixture of a finished report. No database. |
| `/t/sample-waiting`, `/t/sample-error` | Public design fixtures for the waiting and failed layouts. |
| `GET /t/[id]/pdf` | Letter-size PDF of a **finished** report. Same owner/admin (or public sample) check as `/t/[id]`. Missing, private, waiting, and failed ids 404. Filename `tearitdown-<idea-slug>.pdf`. |
| `POST /api/stripe/webhook` | Stripe events, signature-checked. `checkout.session.completed` (and `async_payment_succeeded`) saves the payment intent, queues the teardown once, and starts the run. |
| `GET /api/count` | `{ "count": n }`: signup total only. Polled every 4s by the home page. |
| `POST /api/subscribe` | `{ email, consent: true, ref? }`. 400 for invalid email or missing consent, 409 for a duplicate. |
| `GET /api/subscribe?key=ADMIN_KEY` | Admin: list all signups. |
| `DELETE /api/subscribe?key=ADMIN_KEY&email=…` | Admin: delete one signup. |
| `POST /api/event` | First-party page view or checkout start. Always 204. No IP, cookie, or teardown id. |
| `POST /api/teardown` | `{ idea }`. Returns the **sample** report. It must not call the live engine (billable). |

Admin examples:

```bash
curl "http://localhost:3000/api/subscribe?key=$ADMIN_KEY"
curl -X DELETE "http://localhost:3000/api/subscribe?key=$ADMIN_KEY&email=someone@example.com"
```

Unlock `/new` or `/admin` once with `?key=$ADMIN_KEY`. `proxy.ts` sets an httpOnly cookie and redirects so the key leaves the URL.

## Layout

- `app/`: pages and API route handlers.
- `components/`: waitlist form (`Join.tsx`), intake form, report, waiting/private pages, first-party `Track`.
- `styles/`: page-scoped CSS. `home.css` and `legal.css` are verbatim from the original waitlist site (Inter). `report.css` is the five-page readout and waiting card (IBM Plex). `new.css` and `admin.css` match the waitlist look. There is no global CSS; internal links are plain `<a>` so stylesheets never mix.
- `public/fonts/`: self-hosted Inter and IBM Plex. Do not switch waitlist pages to `next/font` (it changes metrics).
- `lib/db.ts`: Neon client and idempotent schema setup (`signups`, `teardowns`, `sources`, `events`).
- `lib/admin.ts`, `lib/payments.ts`, `lib/stripe.ts`, `lib/events.ts`, `lib/waiting.ts`, `lib/admin-metrics.ts`, `lib/teardown.ts`, `lib/pdf.ts`: admin cookie, owner cookie and refunds, Stripe, first-party events, waiting copy, dashboard queries, shared `/t/[id]` load/access, PDF HTML + Chromium render.
- `lib/engine/`: the teardown pipeline. `runTeardown` / `runPipeline` produce a real `TeardownReport`. `startRun` (`lib/engine/run.ts`) is the app entry that runs a queued row (webhook, admin skip-payment, admin re-run).
- `lib/engine/sections/`: one module per report section. `common.ts` is the shared writer (`runWriter`).
- `lib/engine/prompts/`: versioned prompt files; the file name is the prompt version.
- `lib/engine/fixtures/`: public sample report only. The live engine never uses it.
- `proxy.ts`: turns `?key=ADMIN_KEY` on `/new` and `/admin` into the admin cookie (Next.js proxy, not `middleware.ts`).
- `scripts/`, `tests/`: engine dev run and unit tests. Raw `tests/runs/` output is gitignored; numbers go in `tests/runs-summary.md`.
- `design/`: static HTML of the report template (not served).
- `docs/`: waitlist privacy-notice draft.

## Database

Created lazily in `lib/db.ts` `init()`:

- **`signups`**: `email` (unique), `created_at`, `consent`, `policy_version`, `ref` (nullable).
- **`teardowns`**: id, idea, nullable `report` JSONB, `status`, `input`, `idea_spec`, `research_notes`, `sections`, `stage_runs`, `cost_usd`, `error`, payment columns (`payment_intent`, `refunded_at`, `owner_token_hash`, `paid_at`, `amount_cents`, `currency`), timestamps.
- **`sources`**: per-teardown web sources plus fact-check page cache (`page_text`, `page_error`, `page_fetched_at`).
- **`events`**: first-party page views and checkout starts (path, referrer host, optional `ref`/UTM, time). No IP, cookie, or teardown id. Deleted after 90 days.

`POLICY_VERSION` in `lib/db.ts` must match `/privacy` and `/data`. Collecting any new personal data requires updating those pages and bumping the version.

## Deploy

Deployed on Vercel. Set the env vars above on the project. Use Stripe **test** keys outside production.

Stripe webhook: point a Dashboard endpoint at `https://<host>/api/stripe/webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Preview deploys behind Vercel Deployment Protection will 401 Stripe’s POST unless you bypass protection for that URL.

The engine runs in one Vercel function with `maxDuration = 300` (Hobby cap) on `/new`, `/t/[id]`, and the webhook. A run that fails after payment is refunded once.

`GET /t/[id]/pdf` is a separate Node.js function (`maxDuration = 60`). It unpacks `@sparticuz/chromium` (~64MB brotli in the bundle) into `/tmp` on cold start, then prints the five letter sheets with `page.pdf` (`printBackground`, no header/footer). Expect a slower first download (Chromium inflate); warm invocations skip the extract. The function needs the default 1024MB+ memory.

For local Checkout, `stripe listen --forward-to localhost:3000/api/stripe/webhook` and put that listener’s `whsec_…` in `.env.local`.
