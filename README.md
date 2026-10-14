# Teardown

One-page market readouts for new business ideas. This repo is the Next.js (App Router, TypeScript) app: the waitlist site plus the scaffold for the teardown engine.

## Local setup

Requirements: Node 20+ and a Neon Postgres database (the production one from Vercel's Neon integration, or a separate dev branch).

```bash
npm install
cp .env.example .env.local   # then fill in DATABASE_URL and ADMIN_KEY
npm run dev                  # http://localhost:3000
```

To pull the env vars from the linked Vercel project instead, run `vercel env pull .env.local`.

The `signups` table is created on first request if it doesn't exist, and the nullable `ref` column is added to existing tables (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Existing rows are never modified or dropped.

Checks:

```bash
npm run typecheck
npm run lint
npm test                 # unit tests (vitest), no network
npm run build
```

Engine dev run (billable, needs `ANTHROPIC_API_KEY`): `npm run test:ideas` runs intake and research on three test ideas and writes the outputs to `tests/runs/<timestamp>/`. With `DATABASE_URL` set it also stores the teardowns and their sources; pass `-- --no-db` to skip the database. Point `DATABASE_URL` at a Neon dev branch for this, since schema setup runs `ALTER TABLE`.

## Environment variables

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string. |
| `ADMIN_KEY` | Secret for the admin endpoints below. Admin access is disabled if unset. |
| `ANTHROPIC_API_KEY` | Claude API key for the teardown engine. Only the engine needs it; the site runs without it. |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...` outside production): Checkout Sessions and refunds. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_...`) of the Stripe webhook endpoint for `/api/stripe/webhook`. |
| `STRIPE_PRICE_ID` | The one-time Stripe Price a teardown is sold at. |

Never commit `.env*` files. Only `.env.example` is tracked.

## Routes

| Route | Description |
| --- | --- |
| `/` | Waitlist landing page. `?ref=<code>` is stored with the signup. |
| `/privacy`, `/data` | Privacy Policy and Data Policy. |
| `/new` | Intake form (admin-gated). Saves the teardown as `awaiting_payment`, sets its owner cookie and redirects to Stripe Checkout. An admin can tick "skip payment" to queue and run it directly. `?draft=<id>` (Checkout's cancel URL) refills the answers. |
| `/t/[id]` | The report, or a waiting/cooking page (refreshes every 15s) while the teardown has no report. Only its owner cookie or the admin cookie can see it; everyone else gets a "private" page. `/t/sample` is the design fixture and public. |
| `POST /api/stripe/webhook` | Stripe events, signature-checked. `checkout.session.completed` saves the payment intent, queues the teardown once, and starts the run. |
| `GET /api/count` | `{ "count": n }`: the total number of signups and nothing else. Polled every 4s by the home page. |
| `POST /api/subscribe` | `{ email, consent: true, ref? }`. Returns 400 for an invalid email or missing consent, 409 for a duplicate. |
| `GET /api/subscribe?key=ADMIN_KEY` | Admin: list all signups. |
| `DELETE /api/subscribe?key=ADMIN_KEY&email=...` | Admin: delete one signup. |
| `POST /api/teardown` | `{ idea }`. Returns a stub `TeardownReport` (engine not implemented yet). |

Admin examples:

```bash
curl "http://localhost:3000/api/subscribe?key=$ADMIN_KEY"
curl -X DELETE "http://localhost:3000/api/subscribe?key=$ADMIN_KEY&email=someone@example.com"
```

## Layout

- `app/`: pages and API route handlers
- `components/Join.tsx`: waitlist form and live counter (client component)
- `styles/home.css`, `styles/legal.css`: page styles ported verbatim from the static site. Fonts are self-hosted in `public/fonts/`.
- `lib/db.ts`: Neon client and schema setup
- `lib/engine/`: teardown engine. `runTeardown` is still a stub; the first two stages are real:
  - `input.ts`: the intake form's zod schema.
  - `intake.ts`: form input -> `IdeaSpec` (customer, problem, revenue model, category, geography, search queries, ambiguities). One structured-output Claude call. Prompt: `prompts/intake.v1.md`.
  - `research.ts`: `IdeaSpec` -> `SourceStore` (`{id, url, title, retrieved_at, excerpt}`), via Claude with server-side web search. Sources come only from the API's search-result and citation blocks; excerpts are the cited text. Prompt: `prompts/research.v1.md`.
  - `llm.ts`: model, price table and per-stage cost.
  - `store.ts`: teardown rows, the `sources` table and `runStages` (records each stage's prompt version, model, tokens and cost in `teardowns.stage_runs`).
- `scripts/run-test-ideas.ts`, `tests/`: engine dev run and unit tests
