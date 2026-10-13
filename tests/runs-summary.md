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

- ~~a: "ChatGPT … Free or $20 a month" is cited to a WorthBuild comparison table that doesn't mention ChatGPT pricing.~~ Wrong: the excerpt does contain "ChatGPT | … | Free / $20/mo" (found when calibrating fact-check; I had read a cut-off copy).
- c: the workaround's "$315K to $900K a year" is cited to a page about small firms' processing costs. Plausible but loosely supported.
- Citation accuracy still depends on the writer. Nothing checks that a cited excerpt states the claim (that is the fact-check stage, out of scope here).

## Fact-check calibration (2026-10-12, `factcheck.v1`, offline on the saved runs above)

`scripts/factcheck-saved.ts` re-ran the checker on the saved sections, with no new searches or writing.

| Run | Haiku 5.5: supported / partial / unsupported | Cost |
|---|---|---|
| v1 c (18-00-11) | 2 / 6 / 5 of 13 | $0.0025 |
| v2 a, b, c (18-04-33) | 2/8/0 of 10, 5/2/2 of 9, 5/2/1 of 8 | $0.002 each |

Against my manual spot check of v1 idea c, Haiku flagged every absence claim ("no public price", "Canoe and Alkymi publish no price"), the BNY "aimed at fund managers" claim, and the $50K lower bound. It missed one: "3–6 month setup" from Limina's page, cited as a weakness of the Solovis/Allvue/Chronograph row, was called supported. Sonnet 5.5 on the same 13 claims gave nearly the same verdicts (2/7/4), also did not flag that row, and cost 10× more ($0.025). Fact-check stays on Haiku. On v2 it caught the c workaround's "$315K to $900K a year" (unsupported) and correctly called the ChatGPT price supported.

## 2026-10-12T21-52-32 — section config, shared writer cache, Haiku fact-check (`writer-shared.v1` + `alternatives-write.v3`, `factcheck.v1`), database on

Pipeline: intake (Opus) → research (Sonnet, 6 searches) → alternatives research (Sonnet, up to 6 searches) → alternatives writer (Sonnet, shared cached context) → fact-check (Haiku). Teardown rows `R1aiY-g6B824`, `qyQbnL-ER900` and `OUCdBep-MLjr` are in Neon with status `drafted`; their `stage_runs` include the fact-check run with one entry per claim.

| Idea | Intake | Research | Alt research | Alt write | Fact-check | **Total** | **Projected, 9 sections** |
|---|---|---|---|---|---|---|---|
| a-teardown | $0.023 | $0.240 | $0.241 | $0.070 | $0.002 | **$0.575** | **$1.22** |
| b-dog-grooming | $0.024 | $0.241 | $0.195 | $0.074 | $0.002 | **$0.534** | **$1.17** |
| c-nav-reconciliation | $0.023 | $0.224 | $0.227 | $0.079 | $0.001 | **$0.554** | **$1.25** |

Support rate (share of found citations the checker called supported; "after" is a fresh check of the fixed section, test-only, under $0.002 per idea):

| Idea | Claims | Before | Partial / unsupported before | Fixes | After |
|---|---|---|---|---|---|
| a-teardown | 10 | 4/10 (40%) | 5 / 1 | 6 rewritten | 9/10 (90%) |
| b-dog-grooming | 9 | 5/9 (56%) | 4 / 0 | 3 rewritten | 8/9 (89%) |
| c-nav-reconciliation | 6 | 3/6 (50%) | 0 / 3 | 3 dropped (2 rows) | 2/3 (67%) |

**Shared writer cache.** The writer context (rules, spec, every source with its quote, all notes) is 13.4k–14.3k tokens. A second request with a different section prompt and `max_tokens: 0` read all of it from cache and wrote nothing, in all three ideas. So each further section writer pays about $0.003 for the context instead of $0.035 to write it. Each writer needed one retry this run (written once, read on the retry).

**Why section research wrote ~52k cache tokens but read ~8k.** Web search inserts a cache write after each batch of results, so cache writes are the search results themselves (~8k tokens a search), paid once. Reads only happen when the model samples again after reading results. In b and c the model issued all searches in one round, so the only read was the ~8k request prefix. In a it ran a second round after reading the first results (5 searches, then 1), so that step re-read the whole ~47k context: 54k written, 55k read. Removing breakpoints would not help: with one round, no caching costs about the same (the results are billed as input either way), and with two rounds it costs more. The levers are the number of searches (results volume) and the notes the model writes (output). The projection assumes 6 searches for alternatives and 4 each for demand evidence and economics (`sections/config.ts`).

**Projection method** (`projectReport` in the script): measured intake and research; each searching section costs the alternatives research scaled by its configured searches; the writer context grows by what alternatives research added, scaled the same way (~19k tokens with three searching sections), written once and read by the other 8 writers; each writer's own input and output (retry included) equals the alternatives writer's; verdict and page summaries read ~3k tokens of other sections; fact-check × 9. The unbuilt sections may write more or less than alternatives; this is an estimate, not a measurement.

Rows after fact-check:

- **a**: AI idea validators (WorthBuild, DimeADozen) from $5 a report; business-plan software (LivePlan, Upmetrics); freelance researchers (Fiverr); do it by hand.
- **b**: HRM mobile groomers (GoGo! Grooming, Suds Up Pup); solo in-home groomers; chain and local salons; self-serve dog wash; groom it yourself.
- **c**: statement extraction tools (Canoe, Alkymi, Tamarix), price "Not public"; custodian-run service (Principal), "Not public"; spreadsheets and analysts.

**Idea c competitors: 1/5 in the section (Canoe), 1/5 in sources.** The draft had five rows, including broader platforms (Clearwater Analytics) and portfolio monitoring (Chronograph LP, "$120K–$650K a year"). Fact-check dropped both rows. Their quotes didn't support the claims: the Chronograph citation's quote stops at the header of a pricing table, and the Clearwater quote is a page header. The rule kept two real competitors with "Not public" pricing (Canoe/Alkymi/Tamarix and Principal) instead of dropping them.

**Limit found:** a web-search citation quotes about 150 characters, so every excerpt the checker sees is short (no excerpt in this run came near the 1,200-character cap). A true claim whose evidence sits outside the quoted 150 characters is judged unsupported and dropped. That is the right bar for a sourced readout, but it costs coverage for enterprise vendors whose figures sit in tables. Possible fix: fetch the cited page (web fetch) for the claims the checker cannot confirm.

## Fact-check v2 re-applied to the 21-52-32 drafts (`factcheck.v2` + `factcheck-gap.v1`)

Same drafts as the run above, re-checked with `npx tsx scripts/factcheck-saved.ts tests/runs/2026-10-12T21-52-32-911Z --apply` (no new research or writing). Changes from v1:
- When rows are dropped, a scorecard that counted rows is corrected. c's was still "5 alternatives" with 3 rows left.
- When a market-gap claim changes, one Haiku call repairs the rest of the paragraph. It can only keep parts or add plain text without figures, and it can't remove a cited part that was supported. c's gap had kept "$24,000 a year, below that" after "that" was dropped.
- `factcheck.v2` tells the checker to rewrite rather than drop when the quote is about the same product.

| Idea | Supported before | After | Fixes | Rows left | Fact-check cost |
|---|---|---|---|---|---|
| a-teardown | 5/10 (50%) | 6/9 (67%) | 4 rewritten, 1 dropped (the workaround row) | 3 | $0.0024 |
| b-dog-grooming | 5/9 (56%) | 6/9 (67%) | 3 rewritten | 5 | $0.0019 |
| c-nav-reconciliation | 2/6 (33%) | 1/3 (33%) | 1 rewritten, 3 dropped (2 rows) | 3 | $0.0012 |

- **c after v2:** statement extraction tools (Canoe, Alkymi, Tamarix), Not public; custodian-run service (Principal), Not public; spreadsheets and analysts. The scorecard now says 3 alternatives. The gap no longer refers to the dropped figure. **Key competitors: 1/5 (Canoe).**
- **Clearwater still dropped.** The v2 rule did not change the checker's choice: the row's only cited weakness was unsupported, so the row went.
- **Variance.** The checker is not deterministic. On identical drafts, "before" moved between runs: a 40% → 50%, b 56% → 44% → 56%, c 50% → 17% → 33%. Read the rates as ±15 points.
- **"After"** is the same Haiku checker grading the fixed section, so it is not an independent measure. Its remaining partials are mostly framing ("the text states the figure but not that it is a weakness") and quotes cut off at about 150 characters.
- **a's workaround row was dropped.** Its price "Free to $20 a month" was really ChatGPT's plan prices, which the checker rightly called unsupported for doing it by hand. With no priced fallback, the row went, so the section lost its do-it-yourself row this time.
- **Not checked:** estimates are never fact-checked. c's workaround price "Analyst time, no price found" is the kind of non-estimate `writer-shared.v1` forbids, and it got through.
- **Writers retried in all three ideas.** The reason was not logged then; `StageRun.retries` now records it. The projection counts every writer as retrying once, so it errs high.

## 2026-10-12T22-35-41 — fact-check against fetched pages (`factcheck.v3`), database on

Fact-check now judges each claim in its own Haiku call (thinking off), first against the search excerpt. Any claim the excerpt doesn't fully support is re-judged against the cited page, fetched server-side (`lib/engine/fetch.ts`, readable text, ~6k tokens per claim taken from up to 100k characters of page, cached by URL in `sources.page_text`). The page check runs twice unless the first answer is "unsupported", and the stricter verdict stands. Support found on the page only counts with a passage that appears on the page word for word; that passage is added to the source's excerpt. A page check never drops a claim the excerpt partly supported; a page rewrite still applies.

Temperature 0 isn't possible: Haiku 5.5 returns a 400 for any `temperature` ("deprecated for this model"), as do the other Claude 5 models. One call per claim, thinking off, two page runs with the stricter verdict kept, and the verbatim-quote requirement stand in for it.

Full pipeline run (rows `VKeQLDk7dRjA`, `pNh954ST07FB`, `Cm3-9fEVdnY5`). After two late fixes (quote matching that ignores table punctuation, and the no-drop floor), fact-check was re-applied to the same drafts with `factcheck-saved.ts --apply`; the support and row figures below are from that re-apply, the costs from the pipeline run.

| Idea | Total | Projected, 9 sections | Fact-check (of which re-checks) | Excerpt → with pages → after | Rows kept | Pages ok / failed |
|---|---|---|---|---|---|---|
| a-teardown | $0.486 | $1.00 | $0.0104 ($0.0075) | 2/10 → 5/10 → 8/8 (100%) | 3 of 4 | 3 / 3 |
| b-dog-grooming | $0.516 | $0.98 | $0.0090 ($0.0063) | 3/9 → 3/9 → 9/9 (100%) | 4 of 4 | 4 / 1 |
| c-nav-reconciliation | $0.535 | $1.24 | $0.0102 ($0.0077) | 4/9 → 5/9 → 7/9 (78%) | 5 of 5 | 2 / 1 |

Same code re-applied to the 21-52-32 drafts (the ones fact-check v1/v2 cut down):

| Idea | Excerpt → with pages → after | Rows kept | Fact-check (re-checks) |
|---|---|---|---|
| a-teardown | 3/10 → 4/10 → 9/10 (90%) | 4 of 4 | $0.0123 ($0.0094) |
| b-dog-grooming | 6/9 → 6/9 → 9/9 (100%) | 5 of 5 | $0.0056 ($0.0029) |
| c-nav-reconciliation | 1/6 → 4/6 → 6/6 (100%) | 5 of 5 | $0.0101 ($0.0082) |

- **Idea c, Chronograph and Clearwater.** On the 21-52-32 draft both rows come back: Clearwater's "Illiquid fund accounting still maturing" is on its cited page word for word, and Chronograph's "$120K-$650K" is in the cited page's vendor table (the excerpt had stopped at the table header). In the fresh 22-35-41 run, Chronograph is in the section ($120K to $650K a year, page-checked) and Clearwater wasn't cited. In a 22-32-15 run, neither was cited and 4 of 5 rows were kept.
- **Targets.** "After" (a fresh check of the fixed section, same pages) is 90–100% on a and b. The page stage itself is lower (a 40–50%, b 33–67%): what's left is mostly honest "partial" (a range assembled from two vendors' prices, a qualifier the page doesn't state) and pages behind bot walls. "After" leaves out dropped claims and grades against excerpts that now include the checker's verified quotes, so read it next to rows kept.
- **Fetching.** 14 of 20 cited pages fetched on the 21-52-32 drafts. Failures are bot walls (Fiverr, Capterra, Yelp, Trustpilot, Pet Valu, StartupSavant: 403), one 429 and one timeout. Without a page, a partial verdict is asked once more on the excerpt and the stricter stands.
- **Stability.** Three checks of each draft: excerpt verdicts changed for 1 of 25 claims (21-52-32) and 0 of 28 (22-35-41); final verdicts for 1 of 25 and 2 of 28, all between supported and partial. Support rates moved at most 10 points between runs, against ±15–33 points for the single batched call before.
- **Cost.** Fact-check is $0.006–0.016 per section, up from ~$0.002; the page re-checks are $0.003–0.012 of it. At 9 sections that adds about $0.05–0.10 a report. Projections stay at $0.98–1.24, under $1.50.
- **a's "Do it by hand" row** went on the fresh draft: its price was ChatGPT's plans and its weakness ("takes 2-3 days") isn't on the cited page.
- **Writer failures.** In a first full run (22-30-24), a and c failed in the writer on length limits (`alternatives[1].name` over 26 characters, `what_it_does` over 64) after its retry. Unrelated to fact-check; a and c were re-run.

## 2026-10-13T01-01-13 — Demand Evidence and Economics live (`demand-*.v1`, `economics-*.v1`), database on

Pipeline: intake → research → three section researches in parallel (alternatives up to 6 searches, demand and economics up to 4 each), merged in a fixed order → alternatives writer (writes the shared cache), then demand and economics writers (read it) → fact-check of each section in turn, one page cache. Teardown rows `cXUaF3kuElkK`, `d89uSve7bE0W`, `wmqnO2NRKwPa`.

| Idea | Total so far | Projected, 9 sections | Searches (shared + alt + demand + econ) | Section research (alt / demand / econ) | Writers | Fact-check |
|---|---|---|---|---|---|---|
| a-teardown | $0.969 | **$1.19** | 5 + 6 + 3 + 4 | $0.264 / $0.126 / $0.180 | $0.158 | $0.013 |
| b-dog-grooming | $0.903 | **$1.04** | 6 + 6 + 3 + 3 | $0.261 / $0.128 / $0.137 | $0.103 | $0.009 |
| c-nav-reconciliation | $0.936 | **$1.16** | 6 + 5 + 3 + 4 | $0.210 / $0.120 / $0.184 | $0.156 | $0.010 |

The projection is now mostly measured. Every searching section has run, so only the 6 remaining writers (cached context read plus the measured writers' average own tokens, retries included) and 6 more fact-checks (the measured average) are projected.

Support rate (found claims the checker called supported: excerpt → with pages → fresh re-check of the fixed section):

| Idea | Alternatives | Demand | Economics | All |
|---|---|---|---|---|
| a-teardown | 5/13 → 6/13 → 10/11 | 1/1 → 1/1 → 1/1 | 2/2 → 2/2 → 2/2 | 50% → 56% → 93% |
| b-dog-grooming | 5/10 → 6/10 → 8/10 | 1/1 → 1/1 → 1/1 | 1/2 → 2/2 → 2/2 | 54% → 69% → 85% |
| c-nav-reconciliation | 3/7 → 4/7 → 5/7 | none cited | 0/2 → 1/2 → 1/2 | 33% → 56% → 67% |

Demand and Economics carry few found claims (0–2 each). Demand writes few signals, and most economics figures are estimates, which fact-check doesn't check. Their support rates are too small a sample to mean much.

Section verdicts:

- **a Demand**: thin. One signal: 590 monthly searches for "business idea validation". **a Economics**: strong. $7.50 − $1.50 = 80% margin; $20 a month fixed, so break-even is 4 reports a month. The $1.50 unit cost assumes AI cost per report. This run measured about $0.91–0.97 for three sections and projects $1.04–1.19 for nine, so the true unit cost is closer to $1.60–1.75 with the card fee (≈77% margin).
- **b Demand**: thin. One signal: 94 Google reviews for one Halifax mobile groomer; no Halifax search or forum data. **b Economics**: weak. $80 − $62 = 23% margin (2.5 h of groomer time at the NS average wage, plus fees and supplies); $2,000 a month fixed, so break-even is 112 grooms a month, more than one groomer can do.
- **c Demand**: thin. No checkable signal at all; the page shows the empty state. **c Economics**: strong. $2,000 − $355 = 82% margin; $4,000 a month fixed (SOC 2 and tools, estimated), so break-even is 3 customers. Its price benchmark ("below $50K–$500K tools") is only partly supported.

Run notes:

- **Writer retries.** Writers missed character limits or source budgets often: 1/0/2, 0/1/0 and 1/0/2 retries (alternatives/demand/economics). In an earlier attempt (00-56-15) all three ideas failed after one retry, each on a different length limit. Writers now get two retries (`WRITE_ATTEMPTS = 3`), and validation errors now say the actual length. A run at 00-58-24 lost c to a Neon connection error; the run above is the first complete one on the final prompts.
- **Unit cost and labour.** The 00-58-24 run put b's unit cost at $10 (fees and supplies, no groomer time, 88% margin). `economics-write.v1` now requires per-sale labour at a cited or estimated wage.
- **Demand padding.** The first run listed "1 Trustpilot review" and "2 ratings" as signals. The prompt now rules out single-digit counts. a's 00-58-24 run still offered "5.2M members of r/Entrepreneur", a generic forum size rather than evidence for this idea. The verdict was still thin, but this kind of stretch is worth watching.
- **Source budgets.** The report's 20-source page now has three live sections: alternatives 7, demand 4, economics 5, plus the 4 the sample's remaining sections cite. Alternatives' writer asked for 8–9 in most runs and was cut back on retry.
- **Layout.** b's and c's reports were rendered locally. Page 3 (workings table plus the four unit figures) and page 2 with zero demand signals both fit their sheets.

## 2026-10-13T21-05-18 — every section live (`idea`, `distribution`, `blockers`, `assumptions`, `tests`, `verdict` `-write.v1`), database on

No section comes from the sample any more. After the three searching sections are written and fact-checked, the six with `searches: 0` are written from the same cached writer context plus a second cached block, the finished sections so far as text with every figure in them: Idea, Distribution and Blockers together, then Riskiest Assumptions, then Next Tests, then Verdict (with the three page summaries) last. Teardown rows `89Nzo5Yk5Kx0`, `xd_zLbC6o2Kd`, `prwgV0IKJPnq`; each now ends `done` with its report saved.

| Idea | Full report | Later writers (incl. revisions) | Fact-check | Web claims supported: excerpt → pages → fresh re-check | Internal checks | Contradictions (between / within sections) |
|---|---|---|---|---|---|---|
| a-teardown | **$1.08** | $0.20 | $0.013 | 82% → 94% (16/17) → 88% (15/17) | 9/11 | 0 / 1 |
| b-dog-grooming | **$1.14** | $0.18 | $0.014 | 50% → 56% (9/16) → 88% (14/16) | 10/11 | 0 / 0 |
| c-nav-reconciliation | **$1.18** | $0.20 | $0.009 | 75% → 83% (10/12) → 100% (12/12) | 9/11 | 0 / 1 |

Verdicts, all "test first, low confidence":

- **a:** "Margins are high at $7.50 a report, but demand is weak and WorthBuild already sells at $5. Test whether founders pay before building."
- **b:** "Mobile rivals already work Halifax and demand evidence is thin. The margin is thin too, so test whether owners pay $80 before building."
- **c:** "Extraction tools are strong and the reconciliation niche looks open, but demand evidence is thin. First test: ask pension ops leads for a paid pilot."

How the numbers are held together:

- **Figures.** Idea, Assumptions, Tests (money only) and Verdict may use only figures that appear in the finished sections or the founder's input, written the same way; anything else fails validation and the writer is told the allowed list. Economics' unrounded break-even ("= 2.9, rounded up") is excluded: c's business summary said "about 2.9 customers" next to a verdict saying 3.
- **Distribution vs Economics.** Each channel gives a rough cost to win a customer; code writes it next to the money one sale keeps (one-time) or the payback months (subscription, 12 months at most), and lowers the rating when a sale can't pay for it. The key figure, "max CAC", is computed from Economics: a $6.10, b $33, c $16.8K (12 × $1,400). The sample's "$1.98 ceiling" beside b's own economics can't happen now.
- **Weakest evidence first.** The first assumption must rest on a lowest-rated scorecard row (demand in all three), and the first test must check it. Tests take 1–13 days and $0–500; code writes cost and time.
- **Verdict.** "Pursue" is refused when any row is weak or demand is thin, "high" confidence when demand is thin, and the summary may not point to other pages.

Fact-check:

- **Web-cited claims** in Distribution and Blockers go through the same per-claim check as the other sections. "Support rate after fact-check" above counts only these (all five web-cited sections), as before.
- **Internal checks.** Idea is judged against intake's reading of the founder's idea, each assumption's evidence line and the four summaries against the finished sections, with the same checker. In the first run the checker's own rewrites made things worse (c: "the report found no third-party price", when it does; c's market summary became "both serve managers"), so these checks now only judge. When a claim isn't fully supported, the writer revises once with the checker's reasons, and the revision stands if it checks at least as well. Revisions ran in a (idea, assumptions, verdict), b (assumptions) and c (assumptions, verdict).
- **Contradictions** are counted by a test-only audit on Opus that reads the whole report (about $0.03, not in the totals), and by reading each report. Both agree: none between sections. Within sections: a's Existing Alternatives prices the WorthBuild/DimeADozen row at "$9 to $129" while its own market gap says WorthBuild charges $5. c's test 2 sets up 3 calls but its kill threshold counts "5 interested funds". The tests prompt already asks for the same sample; it happened in two runs of three.

Earlier runs of the same branch:

- **20-54-08** (first): $0.95 / $1.04 / $1.15, all complete. Found b's assumption saying "each groom loses money" when Economics keeps $32 a groom, and the two checker rewrites above. Fixed in the prompts and by judge-only internal checks.
- **20-59-14**: a and b failed, both one character over a limit after two retries (a channel name at 35 of 34, a verdict at 161 of 160). Retries were common in every writer: the Idea writer always first answered with cited-part objects, because the shared rules say every text part is one. Writers now get three retries, and the six later prompts say their fields are plain strings and to aim under each limit. The final run had 0–2 retries per writer and no failures.

Cost: the six later writers add $0.18–0.20 a report, revisions included, and their checks under a cent. The full report is $1.08–1.18, under the $1.50 target; Economics' unit-cost estimate for idea a ($1.40) is now close to that.
