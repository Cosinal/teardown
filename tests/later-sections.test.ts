import { describe, expect, it } from "vitest";
import { applyChecks, type CheckResult } from "../lib/engine/factcheck";
import type { IdeaSpec } from "../lib/engine/intake";
import { buildReport, type Drafts } from "../lib/engine/report";
import type { SourceStore } from "../lib/engine/research";
import type { AlternativesSection } from "../lib/engine/sections/alternatives";
import { assumptionsCheck, parseAssumptions, weakestSections, type AssumptionsSection } from "../lib/engine/sections/assumptions";
import { BLOCKER_COUNT_METHOD, blockersCheck, blockersReport, parseBlockers, type BlockersSection } from "../lib/engine/sections/blockers";
import { INTERNAL_NOTE, REPORT_SOURCE, checkFigures, knownFigures, pointsElsewhere, reportBrief, reviseFeedback } from "../lib/engine/sections/brief";
import type { DemandSection } from "../lib/engine/sections/demand";
import {
  PAYBACK_METHOD, cacCeiling, channelCap, distributionCheck, distributionReport, parseDistribution, type DistributionSection,
} from "../lib/engine/sections/distribution";
import { ARITHMETIC_METHOD, UNCONFIRMED_METHOD, type EconomicsSection } from "../lib/engine/sections/economics";
import { parseIdea, type IdeaSection } from "../lib/engine/sections/idea";
import { laterContext } from "../lib/engine/sections/later";
import { parseTests, type TestsSection } from "../lib/engine/sections/tests";
import { parseVerdict, verdictCheck, verdictLimits, verdictPrompt, type VerdictSection } from "../lib/engine/sections/verdict";

const src = (id: string) => ({ id, url: `https://${id.toLowerCase()}.example`, title: `Page ${id}`, retrieved_at: "2026-10-12T00:00:00.000Z", excerpt: `Quote from ${id}` });
const store: SourceStore = ["S1", "S2", "S3", "S4", "S5", "S6"].map(src);
const found = (text: string, source: string) => ({ text, source, estimate: null });
const est = (text: string, estimate: string) => ({ text, source: null, estimate });
const plain = (text: string) => ({ text, source: null, estimate: null });
const result = (id: string, verdict: CheckResult["verdict"], action: CheckResult["action"] = "keep", text: string | null = null, method: string | null = null): CheckResult =>
  ({ id, verdict, reason: `${verdict} because`, action, text, method });

const spec = {
  name: "Halifax mobile dog grooming",
  customer: "Dog owners in Halifax",
  problem: "Grooming without driving to a salon",
  revenue_model: { price: "$80 per groom", billing: "one_time", notes: "Flat price." },
  category: "Mobile dog grooming",
  geography: { scope: "local", places: ["Halifax"] },
  search_queries: [],
  ambiguities: [],
} as IdeaSpec;

const alternatives: AlternativesSection = {
  alternatives: [{
    name: "Salons", examples: "PetSmart, local salons", workaround: false, what_it_does: "Groom dogs in store.",
    price: found("$70-$120 a groom", "S1"), weakness: [plain("The owner drives and waits.")],
  }],
  market_gap: [plain("Nobody local comes to the door.")],
  scorecard: { rating: "mixed", key_figure: { value: "1", unit: "alternatives" }, finding: "Salons only; no one comes to the door.", source: "S1", estimate: null },
};
const demand: DemandSection = {
  signals: [{ kind: "reviews", signal: "Groomer reviews", rating: "mixed", value: "94", detail: found("reviews for one Halifax groomer", "S2") }],
  evidence: "thin",
  scorecard: { rating: "weak", headline: "94", unit: "reviews", finding: "Thin evidence: one review count, no search data." },
};
const economics: EconomicsSection = {
  per: "groom",
  currency: "CAD",
  price: { amount: 80, note: [plain("The founder's price")] , },
  unit_cost: { amount: 62, note: [est("2.5 h labour plus supplies", "Hours per visit × groomer wage, plus supplies")] },
  fixed_costs: { amount: 2000, note: [est("Van, insurance and software", "Van lease plus insurance and software")] },
  break_even_unit: "grooms a month",
  scorecard: { rating: "weak", finding: "Thin margin; break-even needs a full calendar." },
};
// The price note above has no cited part, which parseEconomics would refuse; the drafts here only feed the report builder.
economics.price.note = [est("The founder's price", "The founder's own price, from the idea")];

const base: Partial<Drafts> = { alternatives, demand_evidence: demand, economics };
const ctx = laterContext(spec, store, base, "CONTEXT");

const distribution: DistributionSection = {
  channels: [
    { name: "Neighbourhood Facebook groups", examples: "Halifax dog owner groups", rating: "strong", cac: { low: 5, high: 15, source: null, estimate: "Founder hours per post × wage ÷ bookings" }, reason: [plain("Owners ask for groomers there.")] },
    { name: "Search ads", examples: "Google Ads", rating: "strong", cac: { low: 30, high: 60, source: "S3", estimate: null }, reason: [plain("Paid clicks for local intent.")] },
  ],
  scorecard: { rating: "strong", finding: "Free groups fit what a groom keeps; ads don't." },
};
const blockers: BlockersSection = {
  blockers: [{ type: "Licensing", risk: "Mobile business licence", severity: "high", detail: found("Halifax requires a mobile vendor licence.", "S4") }],
  scorecard: { rating: "strong", finding: "A licence is needed before the first groom." },
};
const idea: IdeaSection = {
  name: spec.name, headline: "Mobile dog grooming at the owner's door", customer: "Dog owners in Halifax",
  problem: "Grooming without the drive to a salon", revenue: "$80 per groom, paid per visit.",
};
const assumptions: AssumptionsSection = {
  assumptions: [
    { statement: "Halifax dog owners will pay $80 for a groom at home.", short: "Dog owners will pay $80 for a groom at home.", if_false: "If false, there is no business.", rests_on: "demand_evidence", evidence: "Demand Evidence found one signal: 94 reviews for one groomer." },
    { statement: "Facebook groups bring bookings.", short: "Facebook groups bring bookings.", if_false: "If false, customers cost more than a groom keeps.", rests_on: "distribution", evidence: "Distribution rates free groups strong." },
  ],
};
const tests: TestsSection = {
  tests: [{
    name: "Deposit page.", description: "Take $20 deposits for a first groom.", summary: "Post a booking page with a $20 deposit to two Halifax dog groups.",
    assumption: 1, proves: "Owners commit money.", cost: 20, days: 10, kill_threshold: "Fewer than 10 deposits from 200 visits.", kill_threshold_short: "Under 10 deposits",
  }],
};
const verdict: VerdictSection = {
  call: "test_first", confidence: "low", summary: "Salons are the only alternative, but demand evidence is thin and each groom keeps $18.",
  page_summaries: { market: "Salons only; demand is thin.", business: "A 23% margin and costly ads.", next_steps: "One licence and one test of deposits." },
};

describe("figures", () => {
  const known = knownFigures("Price $80 a groom. Gross margin 23%, so $18 is kept. Fixed costs $2,000 a month. Chronograph charges $120K.");

  it("allows figures the report already gives, in any of their forms, and small counts", () => {
    expect(() => checkFigures("Each groom keeps $18 at a 23% margin, under $2,000 a month.", known, "x")).not.toThrow();
    expect(() => checkFigures("Platforms cost $120,000 a year; run 3 tests.", known, "x")).not.toThrow();
  });

  it("rejects a new figure and lists the ones it may use", () => {
    expect(() => checkFigures("A $1.98 ceiling on acquisition.", known, "summary")).toThrow(/summary: "\$1.98" is not a figure.*\$80, 23%, \$18/);
    expect(() => checkFigures("A 25% margin.", known, "x")).toThrow(/"25%"/);
  });

  it("leaves out Economics' unrounded break-even", () => {
    const k = knownFigures("Break-even: 3 paying customers. $4,100 fixed costs a month ÷ $1,393 kept a sale = 2.9, rounded up");
    expect(() => checkFigures("Break-even at about 2.9 customers.", k, "x")).toThrow(/"2.9"/);
    expect(() => checkFigures("Break-even at 3 customers, $1,393 kept each.", k, "x")).not.toThrow();
  });

  it("spots text that sends the reader elsewhere", () => {
    expect(pointsElsewhere("See page 3 for the margin.")).toBe(true);
    expect(pointsElsewhere("The test below checks it.")).toBe(true);
    expect(pointsElsewhere("Salons charge more than this.")).toBe(false);
  });
});

describe("later context", () => {
  it("shows the finished sections and their figures, and splits the sources they left", () => {
    expect(ctx.brief).toContain("## Economics (per groom, in CAD)");
    expect(ctx.brief).toContain("Gross margin: 23%");
    expect(ctx.brief).toContain("Thin evidence");
    expect(ctx.finished).toContain("$18");
    // Alternatives, demand and economics cite 6 entries between them.
    expect(ctx.budgets).toEqual({ distribution: 7, blockers: 7 });
  });
});

describe("distribution", () => {
  it("holds acquisition cost against the money one sale keeps", () => {
    expect(cacCeiling(economics, false)).toBe(18);
    expect(cacCeiling(economics, true)).toBe(18 * 12);
    expect(channelCap({ low: 5, high: 15 }, 18)).toBe("strong");
    expect(channelCap({ low: 10, high: 30 }, 18)).toBe("mixed");
    expect(channelCap({ low: 30, high: 60 }, 18)).toBe("weak");
    expect(channelCap({ low: 0, high: 0 }, 0)).toBe("weak");
  });

  it("writes the cost and the comparison itself, and lowers ratings Economics can't pay for", () => {
    const d = distributionReport(distribution, economics, false);
    expect(d.channels[0].reason.slice(0, 2)).toEqual([
      est("$5–$15 to win a customer", "Founder hours per post × wage ÷ bookings"),
      est("vs $18 kept a groom", ARITHMETIC_METHOD),
    ]);
    expect(d.channels.map((c) => c.rating)).toEqual(["strong", "weak"]);
    expect(d.score).toMatchObject({ rating: "strong", key_figure: { value: "$18", unit: "max CAC" } });
  });

  it("shows payback months for a subscription", () => {
    const d = distributionReport(distribution, economics, true);
    expect(d.channels[1].reason[1]).toEqual(est("pays back in 2–4 months", PAYBACK_METHOD));
    expect(d.channels[1].rating).toBe("strong");
    expect(d.score.key_figure.value).toBe("$216");
  });

  it("calls every channel weak when each sale loses money", () => {
    const losing = { ...economics, unit_cost: { ...economics.unit_cost, amount: 90 } };
    const d = distributionReport(distribution, losing, false);
    expect(d.channels.every((c) => c.rating === "weak")).toBe(true);
    expect(d.channels[0].reason[1].text).toBe("while each groom loses money");
    expect(d.score).toMatchObject({ rating: "weak", key_figure: { value: "$0" } });
  });

  it("validates the section, telling the writer how much room the reason has", () => {
    expect(parseDistribution(structuredClone(distribution), ctx)).toEqual(distribution);
    const long = structuredClone(distribution);
    long.channels[0].reason = [plain("x".repeat(80))];
    expect(() => parseDistribution(long, ctx)).toThrow(/reason: 80 characters; .* at most 67/);
    const uncosted = structuredClone(distribution);
    uncosted.channels[0].cac = { low: 5, high: 15, source: null, estimate: null };
    expect(() => parseDistribution(uncosted, ctx)).toThrow(/cac: cite the source/);
  });

  it("re-tags an unconfirmed cost as rough instead of dropping it, and drops an unsupported reason's channel", () => {
    const check = distributionCheck(ctx)(store);
    const withFound = structuredClone(distribution);
    withFound.channels[0].reason = [found("Owners ask for groomers there.", "S5")];
    const claims = check.claims(withFound);
    expect(claims.map((c) => c.id)).toEqual(["channels[0].reason[0]", "channels[1].cac"]);
    const { section, log } = applyChecks(check, withFound, claims, [
      result("channels[0].reason[0]", "unsupported", "drop"),
      result("channels[1].cac", "unsupported", "drop"),
    ]);
    expect(section.channels).toHaveLength(1);
    expect(section.channels[0].cac).toMatchObject({ source: null, estimate: UNCONFIRMED_METHOD });
    expect(log.map((l) => l.action)).toEqual(["dropped", "estimated"]);
  });
});

describe("blockers", () => {
  it("counts high-severity blockers and holds the rating to mixed", () => {
    expect(blockersReport(blockers).score).toMatchObject({ rating: "mixed", key_figure: { value: "1", unit: "high-severity" }, part: { estimate: BLOCKER_COUNT_METHOD } });
    expect(blockersReport({ ...blockers, blockers: [] }).score.key_figure.value).toBe("0");
  });

  it("needs a cited or estimated detail, and drops one its source doesn't support", () => {
    expect(() => parseBlockers({ ...blockers, blockers: [{ ...blockers.blockers[0], detail: plain("A licence.") }] }, ctx)).toThrow(/cite the source/);
    const check = blockersCheck(ctx)(store);
    const { section } = applyChecks(check, blockers, check.claims(blockers), [result("blockers[0]", "unsupported", "drop")]);
    expect(section.blockers).toEqual([]);
  });
});

describe("idea", () => {
  it("takes intake's name and allows only the founder's figures", () => {
    const fields = { headline: idea.headline, customer: idea.customer, problem: idea.problem, revenue: idea.revenue };
    expect(parseIdea(fields, ctx).name).toBe(spec.name);
    expect(() => parseIdea({ ...fields, revenue: "$75 per groom." }, ctx)).toThrow(/revenue: "\$75"/);
  });
});

describe("riskiest assumptions", () => {
  const round2 = laterContext(spec, store, { ...base, idea, distribution, blockers }, "CONTEXT");

  it("ranks first an assumption that rests on the weakest evidence", () => {
    expect(weakestSections(round2)).toEqual(["demand_evidence", "economics"]);
    expect(parseAssumptions(structuredClone(assumptions), round2)).toEqual(assumptions);
    const wrong = structuredClone(assumptions);
    wrong.assumptions.reverse();
    expect(() => parseAssumptions(wrong, round2)).toThrow(/rests_on: .*demand_evidence or economics/);
  });

  it("judges each evidence line against the report but never applies the checker's rewrite", () => {
    const check = assumptionsCheck(round2)();
    const claims = check.claims(assumptions);
    expect(claims[0]).toMatchObject({ source: REPORT_SOURCE, text: assumptions.assumptions[0].evidence });
    expect(claims[0].context).toContain(INTERNAL_NOTE);
    const { section, log } = applyChecks(check, assumptions, claims, [
      result(claims[0].id, "partial", "rewrite", "Demand Evidence found 94 reviews for one groomer."),
      result(claims[1].id, "unsupported", "rewrite", "The report found no reviews."),
    ]);
    expect(section).toEqual(assumptions);
    expect(log.map((l) => l.action)).toEqual(["kept", "unresolved"]);
    const feedback = reviseFeedback(log)!;
    expect(feedback).toContain(`assumptions[1].evidence (unsupported): "${assumptions.assumptions[1].evidence}"`);
    expect(feedback).toContain("assumptions[0].evidence (partial)");
    expect(reviseFeedback([{ ...log[0], verdict: "supported" }])).toBeNull();
  });
});

describe("next tests", () => {
  const round3 = laterContext(spec, store, { ...base, idea, distribution, blockers, riskiest_assumptions: assumptions }, "CONTEXT");

  it("accepts a cheap test under two weeks that checks the riskiest assumption first", () => {
    expect(parseTests(structuredClone(tests), round3)).toEqual(tests);
    const t = (over: Partial<TestsSection["tests"][number]>) => ({ tests: [{ ...tests.tests[0], ...over }] });
    expect(() => parseTests(t({ days: 14 }), round3)).toThrow(/days: .* 1 to 13/);
    expect(() => parseTests(t({ cost: 900 }), round3)).toThrow(/cost/);
    expect(() => parseTests(t({ assumption: 2 }), round3)).toThrow(/checks the riskiest assumption/);
    expect(() => parseTests(t({ summary: null }), round3)).toThrow(/summary/);
    expect(() => parseTests(t({ description: "A $45 offer." }), round3)).toThrow(/"\$45"/);
  });
});

describe("verdict", () => {
  const all: Drafts = { ...base as Pick<Drafts, "alternatives" | "demand_evidence" | "economics">, idea, distribution, blockers, riskiest_assumptions: assumptions, next_tests: tests, verdict };
  const round4 = laterContext(spec, store, { ...all, verdict: undefined }, "CONTEXT");

  it("restates the report's figures only, and stands alone", () => {
    expect(parseVerdict(structuredClone(verdict), round4)).toEqual(verdict);
    expect(() => parseVerdict({ ...verdict, summary: "Each groom keeps $25." }, round4)).toThrow(/"\$25"/);
    expect(() => parseVerdict({ ...verdict, summary: "See page 3 for why." }, round4)).toThrow(/stands alone/);
  });

  it("holds the call to the scorecard", () => {
    expect(() => parseVerdict({ ...verdict, call: "pursue" }, round4)).toThrow(/pursue.*rated weak: demand_evidence, economics/);
    expect(() => parseVerdict({ ...verdict, confidence: "high" }, round4)).toThrow(/thin/);
  });

  it("checks the summaries against the finished sections", () => {
    const check = verdictCheck(round4)();
    const claims = check.claims(verdict);
    expect(claims.map((c) => c.id)).toEqual(["summary", "market", "business", "next_steps"]);
    expect(new Set(claims.map((c) => c.source))).toEqual(new Set([REPORT_SOURCE]));
  });

  it("builds the whole report from the nine sections, with no sample", () => {
    const report = buildReport(all, store, { billing: "one_time", date: "2026-10-13" });
    expect(report.verdict).toEqual({ call: "test_first", confidence: "low", summary: verdict.summary });
    expect(report.page_summaries).toEqual(verdict.page_summaries);
    expect(report.idea.name).toBe(spec.name);
    expect(report.scorecard.distribution.key_figure).toEqual({ value: "$18", unit: "max CAC" });
    expect(report.next_tests[0]).toMatchObject({ cost: "$20", time: "10 days", assumption: 1 });
    expect(report.riskiest_assumptions[0]).not.toHaveProperty("evidence");
    // The arithmetic is one entry whether Economics or Distribution cites it.
    expect(report.sources.filter((s) => s.text === `Estimate. ${ARITHMETIC_METHOD}`)).toHaveLength(1);
    expect(reportBrief(report)).toContain("## Verdict");
  });
});

describe("verdict with no weak row", () => {
  // The same idea with better evidence: two demand signals (not thin), and every row strong or mixed.
  const solid: DemandSection = {
    signals: [demand.signals[0], { kind: "search", signal: "Local searches", rating: "strong", value: "1,900", detail: found("monthly searches for dog grooming in Halifax", "S5") }],
    evidence: "mixed",
    scorecard: { rating: "mixed", headline: "1,900", unit: "searches/mo", finding: "Steady local searches; reviews for one groomer." },
  };
  const drafts: Partial<Drafts> = {
    alternatives, demand_evidence: solid, economics: { ...economics, scorecard: { rating: "mixed", finding: "Fair margin; break-even needs a full calendar." } },
    idea, distribution, blockers, riskiest_assumptions: assumptions, next_tests: tests,
  };
  const round4 = laterContext(spec, store, drafts, "CONTEXT");
  const pursue: VerdictSection = { ...verdict, call: "pursue", confidence: "medium", summary: "Salons are the only alternative, nobody comes to the door, and owners ask for groomers in local groups." };

  it("leaves every call open, so the verdict can be pursue", () => {
    expect(Object.values(round4.report.scorecard!).map((r) => r!.rating)).not.toContain("weak");
    expect(verdictLimits(round4)).toEqual({ noPursue: null, noHigh: null });
    expect(verdictPrompt(round4)).toContain("Every call is open.");
    expect(parseVerdict(structuredClone(pursue), round4)).toEqual(pursue);
  });

  it.each([
    ["alternatives", { alternatives: { ...alternatives, scorecard: { ...alternatives.scorecard, rating: "weak" as const } } }],
    ["demand_evidence", { demand_evidence: { ...solid, scorecard: { ...solid.scorecard, rating: "weak" as const } } }],
    ["economics", { economics: { ...economics, scorecard: { ...economics.scorecard, rating: "weak" as const } } }],
    ["distribution", { distribution: { ...distribution, scorecard: { ...distribution.scorecard, rating: "weak" as const } } }],
    ["blockers", { blockers: { ...blockers, scorecard: { ...blockers.scorecard, rating: "weak" as const } } }],
  ])("still refuses pursue when %s is weak", (name, change) => {
    const weak = laterContext(spec, store, { ...drafts, ...change }, "CONTEXT");
    expect(() => parseVerdict(structuredClone(pursue), weak)).toThrow(new RegExp(`pursue.*rated weak: ${name}`));
  });

  it("still takes the riskiest assumption from the lowest-rated rows", () => {
    const round2 = laterContext(spec, store, { ...drafts, riskiest_assumptions: undefined, next_tests: undefined }, "CONTEXT");
    expect(weakestSections(round2)).not.toContain("distribution");
    expect(weakestSections(round2)).toContain("demand_evidence");
    expect(parseAssumptions(structuredClone(assumptions), round2)).toEqual(assumptions);
    const wrong = structuredClone(assumptions);
    wrong.assumptions.reverse();
    expect(() => parseAssumptions(wrong, round2)).toThrow(/rests_on: the riskiest assumption must rest on the weakest evidence/);
  });
});
