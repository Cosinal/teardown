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

Superseded by `alternatives-write.v2` (next section), which fixes the citation issues listed at the end of this one.

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

### Spot check: idea c's found claims against their source excerpts (v1)

Of 12 found claims, about half are supported by the cited excerpt: Canoe quote-only pricing, Canoe's volume-based licence with an onboarding fee, and GPs following no standard template. "$50K to $500K a year" is partly supported (the excerpt shows Allvue at $150–500K). "3–6 month setup" comes from Limina's page about Limina but is cited as a weakness of Solovis, Allvue and Chronograph. The rest are unsupported absence claims ("no public price", "Canoe and Alkymi publish no price", where the TrustRadius page covers Canoe only), plus "aimed at fund managers" cited to a BNY page that doesn't say so.

## 2026-10-12T18-04-33 — Existing Alternatives with `alternatives-write.v2` (research prompt unchanged), database off

v2 rules: an estimate must be a calculation or inference that produces the figure; absence claims are plain text, never cited; "Quote only" only when the cited page says pricing is by quote, otherwise use a priced row; no first person. Each writer call passed validation first time.

| Idea | Research searches | Alt searches | Sources | Intake | Research | Alternatives | Total | Alt time |
|---|---|---|---|---|---|---|---|---|
| a-teardown | 5 | 6 | 45 | $0.020 | $0.203 | $0.277 | **$0.501** | 41s |
| b-dog-grooming | 6 | 5 | 34 | $0.024 | $0.247 | $0.253 | **$0.523** | 36s |
| c-nav-reconciliation | 6 | 6 | 51 | $0.025 | $0.228 | $0.370 | **$0.623** | 59s |

Rows written:

- **a**: AI idea-report tools (WorthBuild, DimeADozen); free AI validators (ValidatorAI); Fiverr freelancers; ChatGPT and free prompts; do it by hand. Gap: "not clearly different from WorthBuild at $5".
- **b** (4 rows): Halifax mobile groomers (priced from a Canadian mobile-grooming range, with "no Halifax mobile prices found" as plain text); salons and pet chains; self-serve dog wash; groom at home.
- **c** (4 rows): LP monitoring platforms (Chronograph, Cobalt LP); document extraction (Canoe); AI and Excel tools (Copilot, extraction add-ins); do it by hand.

Idea c key competitors: **1/5 in the section (Canoe), 1/5 in sources or notes (Canoe)**. Three product clusters plus the workaround, but no reconciliation or fund-ops cluster this time. Section research did search outsourced administration and custodians ("State Street Northern Trust private markets data aggregation…"). The writer dropped that row, most likely under v2's rule to replace a row it cannot price. Across the two runs, idea c showed more than one cluster both times, and the reconciliation cluster once.

Still seen in v2:

- a: "ChatGPT … Free or $20 a month" is cited to a WorthBuild comparison table that doesn't mention ChatGPT pricing.
- c: the workaround's "$315K to $900K a year" is cited to a page about small firms' processing costs. Plausible but loosely supported.
- Citation accuracy still depends on the writer. Nothing checks that a cited excerpt states the claim (that is the fact-check stage, out of scope here).
