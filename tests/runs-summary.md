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
