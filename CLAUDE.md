# Tearitdown

Guidance for AI coding agents working in this repo (`Cosinal/teardown`). Product name **Tearitdown**. Public copy says **building**, not live.

## Product

Tearitdown is a **paid idea-teardown report**: a founder describes an idea; the engine returns a nine-section, sourced, fact-checked readout for a go/no-go decision.

The **public CTA is waitlist only**. `/` says “Opening soon”. Do not put a price on `/`, `/privacy`, `/data`, the waiting/private pages, or any other public surface. Do not promise a free teardown to early signups. Intake (`/new`) and checkout exist but stay admin-gated until a deliberate public launch; privacy and data pages already describe intake, Stripe, and the owner cookie.

Payment is a **one-time** Stripe Checkout charge per teardown (`STRIPE_PRICE_ID`, `mode: "payment"`), no subscription. The amount is not public copy. A paid run that fails is refunded once (`lib/payments.ts`).

## Stack

- Next.js App Router + TypeScript, deployed on Vercel.
- Neon Postgres via `@neondatabase/serverless` (`lib/db.ts`).
- Anthropic Claude for the engine. Stripe for Checkout and refunds.
- Env (names only; see `.env.example`): `DATABASE_URL`, `ADMIN_KEY`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`. Use Stripe test keys outside production. Never commit secrets.
- PDF of a finished report: `puppeteer-core` + `@sparticuz/chromium` in `GET /t/[id]/pdf` (`lib/pdf.ts`). Access is `canViewTeardown` in `lib/teardown.ts` — the same owner/admin check as the HTML page.

## Pipeline

`runPipeline` in `lib/engine/pipeline.ts` (also exported as `runTeardown` in `lib/engine/index.ts`). Status on the row: `awaiting_payment` → `queued` → `intake` → `research` → `section_research` → `writing` ↔ `factcheck` → `done`, or `failed` at any step. `drafted` is leftover from older rows.

The app never calls the pipeline except through `startRun(id)` in `lib/engine/run.ts` (Stripe webhook, admin skip-payment, admin re-run). `runStages` in `lib/engine/store.ts` claims a `queued` row in one `UPDATE … RETURNING` so two callers cannot both run it.

Order:

1. **Intake** (`lib/engine/intake.ts`, prompt `intake.v2`): form answers (`lib/engine/input.ts`) → `IdeaSpec`. One structured-output call. Default model: Opus (`STAGE_MODELS` in `lib/engine/llm.ts`).
2. **Shared research** (`lib/engine/research.ts`, `research.v2`): `IdeaSpec` → `SourceStore` (`S1…Sn` with url, title, quoted excerpt). Claude with server-side web search (`web_search_20250305`). Sources come only from the API’s search-result and citation blocks, never from URLs the model writes. Default 6 searches.
3. **Section research** (in parallel, then merged in a fixed order): only **Existing Alternatives**, **Demand Evidence**, and **Economics** search (`lib/engine/sections/config.ts`: 6 / 4 / 4 searches). The other six sections have `searches: 0`.
4. **Writers** for those three, from one cached shared context (`writerContext` in `lib/engine/sections/common.ts`). A `max_tokens: 0` warm-up writes the prefix so all three can start together.
5. **Fact-check** of each searching section, one at a time, so each sees page quotes the previous added (`lib/engine/factcheck.ts`, Haiku, `factcheck.v3`). Cited-as-found claims are judged against the search excerpt, then the fetched page (`lib/engine/fetch.ts`). Unsupported claims are rewritten, re-tagged as estimates, or dropped. A page cache lives on `sources.page_text` (30 days for successful fetches).
6. **Idea, Distribution, and Blockers** together, from the same cached context plus the finished, fact-checked sections (`laterContext`). Distribution and Blockers are fact-checked against web sources. Idea is checked against the founder’s spec; if the checker disagrees, the writer revises once (skipped past the soft time limit).
7. **Riskiest Assumptions**, ranked by the scorecard (the first must rest on a lowest-rated row). Internal fact-check + optional one revision.
8. **Next Tests**: each checks an assumption by rank; the first checks the riskiest. Cost/time caps are enforced in code (`MAX_TEST_COST` 500, `MAX_TEST_DAYS` 13).
9. **Verdict last**, with the page-2–4 summaries. It may only restate the other eight sections. No `pursue` while any scorecard row is weak or demand is thin.

Time budget (`Budget` in `lib/engine/llm.ts`), measured from `runStages`: past **240 s** skip optional fact-check revisions; at **275 s** abort in-flight calls so the run can mark `failed` and refund before Vercel’s **300 s** `maxDuration`. Non-search calls time out at 60 s per attempt.

Admin “Re-run from saved answers” reuses spec/sources when those stages already finished (`loadResume`), and never charges again.

## Writer contract

Section writers return **JSON as text**, not structured output, so they can share one cached prefix (`writer-shared.v1` plus spec, sources, notes). Parsers in each section module validate. Extra text after a complete object is ignored; if several objects appear, the last one that parses wins (`jsonValues` / `jsonObjects` in `lib/engine/sections/common.ts`).

Character caps are **hard** (`LEN` / `LIMITS` in `lib/engine/validate.ts`, plus per-section rules). `runWriter`:

- Structural errors (missing fields, wrong types, citation rules, invented figures): up to `WRITE_ATTEMPTS` (**3**) calls, then fail the run.
- Display-text **length overruns**: an overrun of at most **50%** over the cap (`TRIM_OVERRUN_RATIO = 0.5`) is trimmed at a word boundary when that is safe. Larger overruns get up to **two** repair calls (`LENGTH_REPAIR_ATTEMPTS = 2`) within those 3 attempts; then a safe trim, or fail.
- **Cited text** (`*.text` with a source id) and **figure fields** (`value`, `unit`, `amount`, `key_figure`) are **never trimmed**. If the writer cannot shorten them, the run fails.
- Repair spends is included in `cost_usd` and recorded as `repair_cost_usd` on the stage run.

All section writers must share one model and effort (currently Sonnet, `medium`) or they stop sharing the cached prefix.

## `buildReport` is not AI

`buildReport` in `lib/engine/report.ts` is plain code. It turns section drafts (which cite SourceStore ids like `S12`, or estimate methods) into a `TeardownReport` with **1-based** `sources` indices, then `parseReport` enforces page limits. Found URLs come from the store, never from the model. Throws `ReportError` if limits break. There is no model call here.

## Report storage and `/t/[id]`

Neon table **`teardowns`**: `report` JSONB (nullable until `done`), `sections` JSONB (drafts keyed by name), `idea_spec`, `research_notes`, `stage_runs`, `cost_usd`, `status`, payment/owner columns. Table **`sources`**: one row per source per teardown.

Access (`lib/teardown.ts`, used by `app/t/[id]/page.tsx` and `app/t/[id]/pdf/route.ts`):

- **`/t/sample`** (and `sample-waiting`, `sample-error`) are public design fixtures; they never touch the database.
- Every other id is shown only to the **owner cookie** (`td_own_<id>`, hash on the row) or the **admin cookie** (`td_admin`). Everyone else gets the private page (waitlist CTA, “Tearitdown is building.”). No row data.
- A finished report (status effectively `done`, i.e. a stored `report`) shows a **Download PDF** button linking to `/t/[id]/pdf`. Waiting, failed, and private pages do not. The PDF route 404s unless that same viewer would see the HTML report **and** a report exists (`/t/sample` included). Chromium prints five US Letter pages from `components/Report.tsx` + `styles/report.css`; filename `tearitdown-<idea-slug>.pdf`.

`/api/teardown` still returns `SAMPLE_REPORT`. Do **not** call `runTeardown` from that public route.

## Nine report sections

As written by the engine and rendered on five letter-sized pages (`components/Report.tsx`, `styles/report.css`):

| Section | Role |
| --- | --- |
| Idea | Founder’s idea restated (name from intake). |
| Existing Alternatives | Who already serves this need, prices, weaknesses, market gap. |
| Demand Evidence | Checkable signals only; fewer than two after fact-check → “Thin evidence”, rated weak. |
| Economics | Founder’s price; code computes margin and break-even from writer inputs. |
| Distribution | Channels for the first 100 customers; acquisition cost judged in code against Economics. |
| Blockers | Legal / technical / platform; zero is valid. |
| Riskiest Assumptions | Up to three, riskiest first. |
| Next Tests | Cheap tests in rank order. |
| Verdict | Last. `pursue` / `test_first` / `drop`. |

Scorecard rows: alternatives, demand_evidence, economics, distribution, blockers.

## Unsourced figures

Hard rule: **if no source supports a figure, tag it Estimated (with a method) or leave it out.** Do not invent companies, prices, or numbers. Writer prompt: `lib/engine/prompts/writer-shared.v1.md`. Parsers reject a figure that has neither a source id nor an estimate method. Fact-check re-tags unconfirmed found figures as estimates or drops them; later sections (`checkFigures` in `lib/engine/sections/brief.ts`) may only reuse figures already in the report or the founder’s input. “Not public” is the one uncited price allowed, and only for a real competitor whose row still cites a source.

## Cost tracking

- Models per stage in `STAGE_MODELS`; every model used needs a row in `PRICES` (`lib/engine/llm.ts`). Intake: Opus. Research and all section writers: Sonnet. Fact-check: Haiku.
- Each stage records usage (tokens, cache writes/reads, web searches), `cost_usd`, duration in `teardowns.stage_runs`. `teardowns.cost_usd` is the running total. Failed writers still record spend.
- `cacheHitRate` / `cacheReport` for cache accounting. `npm run test:ideas` writes raw output to `tests/runs/` (gitignored); put counts and costs in `tests/runs-summary.md`.

## Conventions

- Waitlist pages (`/`, `/privacy`, `/data`) are pixel-ported. `styles/home.css` and `styles/legal.css` are page-scoped and verbatim. No global CSS. Internal links are plain `<a>` (full page loads) so stylesheets never mix. Keep it that way, or scope the CSS first. Report/waiting pages use `styles/report.css` and IBM Plex; waitlist/new/admin use Inter.
- Fonts are self-hosted in `public/fonts/`. Do not switch the existing waitlist pages to `next/font`: it changes metrics.
- Schema changes must be additive and idempotent (`ADD COLUMN IF NOT EXISTS`). Never drop or rewrite signup data.
- Collecting any new personal data requires updating `/privacy` and `/data` and bumping `POLICY_VERSION` in `lib/db.ts`.
- `/new` and `/admin` are gated: open `?key=ADMIN_KEY` once (`proxy.ts` sets the cookie). The page and its server actions 404 without it (`lib/admin.ts`). Public CTAs go to `/`, never `/new`.
- `proxy.ts` is this Next.js version’s request proxy (not `middleware.ts`).
- Run `npm run typecheck` and `npm run build` before considering work done. Prefer `npm test` and `npm run lint` in the same pass.

## Testing

- `npm test`: Vitest, no network. Mocks cover Anthropic, Neon, and Stripe except webhook signature helpers.
- `npm run lint`, `npm run typecheck`, `npm run build`.
- `npm run test:ideas` is **billable**. Use a Neon **dev** branch if you persist rows.

## Do not

- Do not merge without typecheck, lint, tests, and build passing.
- Do not commit secrets, `.env*` (except `.env.example`), or `tests/runs/` output.
- Do not put a public price, a “live” claim, or a `/new` CTA on waitlist or waiting/private copy.
- Do not call `runTeardown` / `runPipeline` from a public, unpaid route. `/api/teardown` stays a sample stub.
- Do not ungate `/new` as the public product without an explicit launch decision.
- Do not change one section writer’s model or effort independently of the others (breaks the shared cache).
- Do not trim cited text or figure fields to fit a character cap; fail instead.
- Do not invent unsourced figures. Estimated or drop.

## Keep these docs current

Any PR that changes the **pipeline**, **env vars**, **npm scripts**, **schema**, or **routes** must update `README.md` and `CLAUDE.md` in the **same PR**. If a public string, gate, or price rule changes, update both files before merge. Prefer omitting a claim over guessing.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
