# Test-idea runs

`npm run test:ideas` writes raw output to `tests/runs/<timestamp>/`, which is gitignored. This file keeps the numbers. Costs are in USD and cover intake plus research. Token columns are for the research stage only. "Uncached in" is input billed at the full rate.

## 2026-10-11T23-48-56 — Opus 5.5 intake + research, 10 searches, no caching (`research.v1`)

| Idea | Searches | Sources | Uncached in | Cache write | Cache read | Out | Intake | Research | Total | Research time |
|---|---|---|---|---|---|---|---|---|---|---|
| a-teardown | 10 | 30 | 186,657 | 0 | 0 | 5,051 | $0.029 | $0.948 | **$0.976** | 58s |
| b-dog-grooming | 10 | 23 | 205,634 | 0 | 0 | 6,236 | $0.018 | $1.047 | **$1.065** | 63s |
| c-nav-reconciliation | 10 | 25 | 222,589 | 0 | 0 | 5,841 | $0.023 | $1.107 | **$1.131** | 66s |

## 2026-10-12T00-01-21 — Sonnet 5.5 intake + research, max 6 searches, prompt caching (`research.v2`)

| Idea | Searches | Sources | Uncached in | Cache write | Cache read | Out | Intake | Research | Total | Research time |
|---|---|---|---|---|---|---|---|---|---|---|
| a-teardown | 4 | 20 | 8 | 37,596 | 33,393 | 3,702 | $0.011 | $0.178 | **$0.189** | 27s |
| b-dog-grooming | 6 | 23 | 8 | 58,057 | 44,068 | 4,705 | $0.014 | $0.261 | **$0.275** | 34s |
| c-nav-reconciliation | 6 | 30 | 8 | 49,047 | 39,023 | 4,365 | $0.013 | $0.234 | **$0.247** | 31s |

## Idea c across configurations (2026-10-12; only the first two runs used the database)

Key competitors checked: Canoe, FundRecs, Limina, Arcesium, FundGuard. A name counts as found if it appears in any source's URL, title or excerpt, or in the notes.

| Run | Intake / research | Searches | Sources | Total | Key competitors found |
|---|---|---|---|---|---|
| 23-48-56 (old) | Opus / Opus | 10 | 25 | $1.131 | 5/5 (Arcesium and FundGuard: one source each) |
| 00-01-21 | Sonnet / Sonnet | 6 | 30 | $0.247 | 1/5: Limina |
| 00-02-26 (repeat) | Sonnet / Sonnet | 6 | 24 | $0.238 | 2/5: Canoe, Limina |
| 00-02-28 | **Opus** / Sonnet | 6 | 28 | $0.246 | 3/5: Canoe, FundRecs, Limina |
| 00-15-11 | Opus `intake.v2` / Sonnet | 6 | 21 | $0.251 | 2/5: Canoe, FundRecs |
| 00-15-13 | Opus `intake.v2` / Sonnet | 6 | 24 | $0.260 | 1/5: Canoe |

Opus intake writes a query that names a known competitor ("Canoe Intelligence alternatives …"). In this sample, that query is what surfaces the LP-document-automation competitors. Sonnet intake writes only generic category queries.

`intake.v2` (Opus, plus a rule to name the best-known competitor) named Canoe in both runs, and research searched it both times. Research then spent its remaining searches on pricing, customers, demand and the LP data-extraction cluster. Of the other names in sources, the 00-15-11 run found Accelex, Alkymi and Arch, and the 00-15-13 run found Accelex, Alkymi, Chronograph, Burgiss, Allvue, Cobalt and Arch. Limina, Arcesium and FundGuard (reconciliation / fund-ops platforms) dropped out. With 6 searches, the research stage covers one competitor cluster, not both.

Each configuration ran only once or twice, so treat these counts as indicative.

## 2026-10-12T18-00-11 — Existing Alternatives section (`alternatives-research.v1` + `alternatives-write.v1`, Sonnet, max 6 searches)

Intake (Opus, `intake.v2`) → research (Sonnet, `research.v2`, max 6 searches) → alternatives (Sonnet: own searches + one writer call). Database on. Each writer call passed validation first time (no retry). Sources is the merged store (shared research plus the section's new pages).

| Idea | Research searches | Alt searches | Sources | Intake | Research | Alternatives | Total | Alt time |
|---|---|---|---|---|---|---|---|---|
| a-teardown | 5 | 6 | 45 | $0.020 | $0.204 | $0.332 | **$0.556** | 55s |
| b-dog-grooming | 6 | 5 | 42 | $0.024 | $0.243 | $0.331 | **$0.598** | 55s |
| c-nav-reconciliation | 6 | 5 | 53 | $0.026 | $0.228 | $0.324 | **$0.577** | 55s |

Alternatives stage cost, per idea: about 52k cache-write tokens and 4–5k output in section research, 5–6 searches ($0.05–0.06), then a writer call with about 35k uncached input (sources with excerpts plus both sets of notes) and about 3k output.

Rows written (workaround last in every case):

- **a**: AI idea validators (WorthBuild, DimeADozen); chat-style AI advisors (ValidatorAI, IdeaProof); Fiverr freelancers; business planning software (LivePlan); do it by hand. Gap: WorthBuild already sells a $5 full report.
- **b**: Halifax mobile groomers (Suds Up Pup, All 4 Paws); Halifax salons (Jollytails, Naughty Paw); chain salons and daycares (PetSmart, Camp Bow Wow); self-serve dog wash (Pet Valu); groom the dog yourself.
- **c**: four competitor clusters plus the workaround: alts data platforms (Canoe, Alkymi, Accelex); LP portfolio platforms (Solovis, Allvue, Chronograph); generic reconciliation (Xceptor, Duco, Smartstream); outsourced administration (custodians, SS&C, Linedata); do it by hand.

Idea c key competitors (Canoe, FundRecs, Limina, Arcesium, FundGuard): **1/5 named in the section (Canoe)**, 2/5 anywhere in sources or notes (Canoe, Limina). The section now covers more than one cluster, including a reconciliation one, but it reached reconciliation through generic capital-markets vendors (Xceptor, Duco), not the fund-ops platforms named in the brief. Limina's page is cited (for setup time) without Limina being named. Arcesium and FundGuard did not appear.

Issues seen:

- b: the mobile-groomer price "No public price found" is tagged *estimated* with the method "Searched Halifax mobile groomer sites…", and the scorecard cites the same estimate. That is a search note, not an estimate. The writer prompt should require a found citation for "no public price", or drop the price.
- c: "No public price found" for Xceptor/Duco is cited *found* to Xceptor's own page, which only shows the absence of a price.
- Other sections still come from the sample, so each report's sources page also lists the sample's sources (e.g. "Freelance marketplace search…" on the dog-grooming report).

One run per idea; treat these as indicative.
