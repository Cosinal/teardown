# Teardown

## Product

Teardown turns a business idea into a one-page market readout: competitors (direct and adjacent), what they charge and how the offer is structured, who buys and why, and where demand is underserved. The readout is built for a go/no-go decision in minutes. Pricing will be a single payment of $5–10 per teardown, with no subscription. Today the live site is a waitlist; the first 10 signups get a free teardown at launch in exchange for feedback.

## Stack

- Next.js App Router + TypeScript, deployed on Vercel.
- Neon Postgres via `@neondatabase/serverless` (`lib/db.ts`). Table `signups`: `email` (unique), `created_at`, `consent`, `policy_version`, `ref` (nullable).
- Env: `DATABASE_URL`, `ADMIN_KEY` (see `.env.example`). Never commit secrets.

## Conventions

- The waitlist pages (`/`, `/privacy`, `/data`) are pixel-ported from the original static site. `styles/home.css` and `styles/legal.css` are deliberately page-scoped and verbatim. There is no global CSS, and internal links are plain `<a>` (full page loads), so the two stylesheets never mix. Keep it that way, or scope the CSS first.
- Schema changes must be additive and idempotent (`ADD COLUMN IF NOT EXISTS`). Never drop or rewrite signup data.
- Collecting any new personal data requires updating `/privacy` and `/data` and bumping `POLICY_VERSION` in `lib/db.ts`.
- Fonts are self-hosted Inter in `public/fonts/`. Don't switch to `next/font` on the existing pages: it changes metrics.
- `/new` (the intake form) is gated behind `ADMIN_KEY` until `/privacy` and `/data` cover intake data: open `/new?key=ADMIN_KEY` once to set a cookie; without it the page and its server action return 404 (`lib/admin.ts`, `proxy.ts`). Remove the gate only together with the policy update.
- Engine models are set per stage in `STAGE_MODELS` (`lib/engine/llm.ts`). Every model used needs a row in `PRICES` there.
- `npm run test:ideas` writes raw output to `tests/runs/` (gitignored). Record the per-idea counts and costs in `tests/runs-summary.md`.
- Run `npm run typecheck` and `npm run build` before considering work done.

## MVP build order

1. **Engine:** implement `runTeardown(idea)` in `lib/engine/` so it returns a real `TeardownReport` (competitors with name/url/pricing/target_customer, pricing_summary, customer_segments, market_gaps, sources). `/api/teardown` already returns the stub.
2. **Test it on Teardown itself:** run the engine on Teardown's own idea and check the output against what we know about this market. Iterate until the report is accurate, sourced and useful.
3. **Results page:** render a `TeardownReport` as the one-page readout, in the same visual language as the waitlist site.
4. **Payments:** a single $5–10 payment per teardown, no subscription. Gate `/api/teardown` behind payment (or auth) before the engine does real, billable work. It is currently public because it only returns a stub.
