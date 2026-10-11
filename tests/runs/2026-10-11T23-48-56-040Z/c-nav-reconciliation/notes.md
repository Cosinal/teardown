# Research notes: private-markets NAV reconciliation software for Canadian and US pension fund ops teams

**What I couldn't find:**
- **Blockers:** I ran out of searches before covering this. I have no sources on licences, rules or vendor-risk requirements (for example OSFI third-party risk guidance, SOC 2 expectations, or US public-pension procurement rules).
- **Public prices:** none for Canoe, Fund Recs, Arch, Alkymi, Accelex or Nasdaq Solovis.
- **Customer reviews:** no review-site complaints about any tool.
- **Pension case studies:** no named pension fund customer case study for any of these vendors.
- **Canadian plan count:** I found member counts but not the number of plans.

## Alternatives

**1. Canoe Intelligence (canoeintelligence.com).** This is the most direct LP-side competitor. One comparison calls it the LP-side market leader in document extraction for alternatives [S4], and says it processes 1.6M+ documents per month, extracting over 200M data points. [S4] Canoe excels at helping allocators and institutional investors process the documents they receive from GPs. [S4] However, the analytics and downstream data governance sit with partners like Confluence and PrimePlus rather than being native to the platform. [S4]
- **Pricing structure:** this comes from an ILPA vendor factsheet with data as of April 2021, so it may be out of date. Canoe offers an annual licensing fee driven by total volume of unique commitments and subscriptions (line items) with tiering thresholds at certain volumes. As the volume of line items increases, the effective unit costs decrease. The license fee is also impacted by the number of investor portal connections desired. [S18] In addition, there is a one-time onboarding fee that covers hands-on implementation, training and platform configuration. [S18]
- **Users and data:** the factsheet literally says "Canoe does limit the number of users, data points or historical data." [S18] It then says all of this is included in the quoted annual rate, so "does limit" is probably a typo for "does not limit". Treat this as unclear.
- **Public price:** none. G2 says Canoe Intelligence has not provided pricing information for this product or service. [S20]

**2. Fund Recs (fundrecs.com).** This is the closest match to the exact NAV-reconciliation job. Fund Recs automates the reconciliation of private equity holdings across administrators, GP statements, and internal records. [S2] Its matching engine can compare commitments, NAV, unfunded amounts, distributions, and investment-level movements across all sources. [S2] It also offers flexible rules and tolerances [S2] and lets users assign, comment, and resolve breaks directly in the platform. [S2] No public pricing found.

**3. Alkymi.** A comparison article calls Alkymi and Accelex the only two like-for-like substitutes for Canoe. It describes Alkymi as configurable, customer-owned extraction IP, per-fund pricing [S3]. Another review lists these limits: a bundle-based approach may not cover all document types firms encounter [S4], and it is a newer entrant with less track record than Canoe [S4]. I found no website or price figures in the results.

**4. Accelex, now part of Carta (carta.com).** Accelex was acquired by Carta in late 2025, signalling that extraction is becoming a feature of larger platforms rather than a standalone category. [S4] Carta's own LP blog says by automating data acquisition and extraction, LPs can significantly reduce the operational burden associated with private markets investing. [S14] No public pricing found.

**5. Arch (arch.co).** Arch digitally manages private investment operations for investors and investment advisors. [S21] It is used by more than 180 family offices [S23] and raised a $52M Series B. In 2021 it said it plans future platform expansions to support Foundations, Endowments, Pension Funds, and Sovereign Wealth Funds [S22]. I found no evidence that it now serves pension funds, and no public pricing.

**6. Limina (limina.com).** This is a broader LP investment management system, and the only one in the set with public pricing.
- Limina says it is the only LP platform with transparent public pricing: $70,000-$379,200/year, usage-based not AUM-based. [S5]
- Pricing-page examples: Example A $12.8k/m, 5 Users, 3 Funds, 10k Trades per year [S8], and Example B at $31.6k/m for 20 users and 20 funds.
- Add-ons and enterprise: Operations Hub is priced separately as $1,200 per user per year. [S8] The pricing model is only applicable up to $400,000 per year fees. Above that we apply enterprise pricing. [S8]
- Setup: Limina will set up managed integrations at $ 5,000 - $ 10,000. [S8] Implementation takes 3 weeks to 4 months depending on portfolio complexity. [S5]
- Reconciliation: Limina says reconciliation ensures the result (positions & cash balances) matches with the fund administrator and custodian. [S9]

**7. Nasdaq Solovis.** This is an enterprise LP portfolio platform. Limina's guide lists it as Implementation: 3-6 months typical. Pricing: Annual SaaS (custom) [S5]. The same guide also lists Chronograph LP. I found no website or price figures for either.

**8. Manual workaround: spreadsheets and PDFs.** Nasdaq says many organizations managing multi-billion-dollar alternative portfolios still rely on quarterly PDFs, fragmented GP portals, and spreadsheets. [S15] Analysts will typically review quarterly fund reports delivered as PDFs, then will extract key figures by hand and consolidate them into spreadsheets. It's a process they have to do for dozens of fund companies, four times per year [S15].

**Other adjacent platforms mentioned.** Masttro, Addepar and FundCount are LP-side platforms aimed mainly at family offices. Masttro advertises fixed pricing [S6]. FundCount's own reviews say Addepar and Allvue pricing is quote-based [S7]. eFront, now part of BlackRock (Aladdin Alternatives), is described as strongest as an enterprise private-markets platform connected to whole-portfolio management. [S7]

## Customers

Buyers are institutional LPs and allocators, but many vendor sources target family offices rather than pension funds.
- **Pain points:**
  - Data arrives from a multitude of sources – various GPs and investor portals – creating a fragmented and siloed overview. Each GP may use different terminology, provide varying levels of detail in their metric sets, and present data in a variety of formats. [S14]
  - Masttro says manual re-keying is where reconciliation errors are born. [S1]
  - Nasdaq says inconsistencies and human error can degrade trust in the data before it even reaches an investment committee. [S15]
  - FundGuard notes that a misbooked distribution or a stale private valuation can sit in the books for weeks before anyone notices. [S10]
- **Industry survey:** in a CFA Institute survey, thirty-seven percent of global investment professionals said that frequency and accuracy of valuation reporting in private markets had "substantial problems or even market failures," [S16]
- **Canoe testimonial:** one customer on Canoe's homepage reports up to a 75% reduction in time spent on managing an even larger volume of alternative investments with the same resources [S19].
- **Named customers:** Canoe's 2021 sample clients were wealth and advisory firms plus Hamilton Lane and Prime Buchholz. No pension funds were named.
- **Complaints about the tools themselves:** none found on review sites.

## Demand

- **US public pension systems:** the Census Bureau says there were 304 state-administered funds and 4,632 locally-administered defined benefit public pension systems [S25]. In 2025, state and local governments invested $6.49 trillion in short- and long-term assets in pension plans, up 8.46% from $5.98 trillion in 2024. [S24]
- **US private pensions:** no count of corporate pension plans found.
- **Canada membership:** StatCan's figure as of January 1, 2025 is 7,352,686 active registered pension plan members. The number of plans was not in the results.
- **Canada concentration:**
  - Mordor Intelligence says Canada's pension ecosystem is concentrated, with the Maple Eight controlling a significant share of the assets. [S13]
  - It ranks CPPIB leads at CAD 714.4 billion, followed by CDPQ at CAD 473 billion and OTPP at CAD 247.5 billion. [S13]
  - Another source says CPP Investments has large in-house teams investing directly in PE, real assets, and credit globally, with over 50% of the portfolio in private markets. [S12]
- **Private-markets exposure:** a UMass PERI working paper says pension funds alone currently account for $2.7 trillion in committed funds to private financial markets [S11].
- **Spending on the problem:** this is Canoe's own estimate, so it is a vendor claim. Medium-sized firms, a group that includes pension funds, can ingest and process between 11,000 to 56,000 documents each month, extract between 1,080,000 and 5,400,000 key data points, and spend between $315,000 to $900,000 annually managing this process. [S17]

## Blockers

No sources found.
