import { describe, expect, it } from "vitest";
import { applyChecks, type CheckResult } from "../lib/engine/factcheck";
import { SAMPLE_REPORT } from "../lib/engine/fixtures/sample";
import { SOURCE_BUDGETS, buildPartialReport, laterBudgets } from "../lib/engine/report";
import type { SourceStore } from "../lib/engine/research";
import { COUNT_METHOD, demandCheck, parseDemand, settleDemand, type DemandSection } from "../lib/engine/sections/demand";
import {
  ARITHMETIC_METHOD, UNCONFIRMED_METHOD, computeEconomics, economicsCheck, economicsReport, money, parseEconomics, type EconomicsSection,
} from "../lib/engine/sections/economics";
import { LIMITS, parseReport } from "../lib/engine/validate";

const src = (id: string) => ({ id, url: `https://${id.toLowerCase()}.example`, title: `Page ${id}`, retrieved_at: "2026-10-12T00:00:00.000Z", excerpt: `Quote from ${id}` });
const store: SourceStore = ["S1", "S2", "S3", "S4", "S5"].map(src);
const found = (text: string, source: string) => ({ text, source, estimate: null });
const est = (text: string, estimate: string) => ({ text, source: null, estimate });
const plain = (text: string) => ({ text, source: null, estimate: null });
const result = (id: string, verdict: CheckResult["verdict"], action: CheckResult["action"] = "keep", text: string | null = null, method: string | null = null): CheckResult =>
  ({ id, verdict, reason: `${verdict} because`, action, text, method });

const demand: DemandSection = {
  signals: [
    { kind: "search", signal: "Search interest", rating: "mixed", value: "1,900", detail: found("Halifax searches a month", "S1") },
    { kind: "reviews", signal: "Competitor reviews", rating: "strong", value: "212", detail: found("Google reviews for one groomer", "S2") },
  ],
  evidence: "mixed",
  scorecard: { rating: "mixed", headline: "212", unit: "reviews", finding: "People already pay local groomers." },
};

const econ: EconomicsSection = {
  per: "groom",
  currency: "CAD",
  price: { amount: 80, note: [plain("The founder's price,"), found("salons charge $70-$120", "S3")] },
  unit_cost: { amount: 23, note: [found("$0.30 + 2.9% card fee", "S4"), est("+ $20 supplies and fuel", "Supplies and fuel per visit")] },
  fixed_costs: { amount: 2500, note: [est("$1,500 van lease, $1,000 insurance and software", "Monthly van lease plus insurance, from cited guides")] },
  break_even_unit: "grooms a month",
  scorecard: { rating: "mixed", finding: "Good margin; break-even needs steady bookings." },
};

describe("source budgets", () => {
  it("give the searching sections fixed budgets and split what they leave between Distribution and Blockers", () => {
    expect(SOURCE_BUDGETS).toEqual({ alternatives: 7, demand_evidence: 4, economics: 5 });
    // At their maximum, the first three leave 4.
    expect(laterBudgets(16)).toEqual({ distribution: 2, blockers: 2 });
    expect(laterBudgets(13)).toEqual({ distribution: 4, blockers: 3 });
    expect(laterBudgets(16).distribution + laterBudgets(16).blockers + 16).toBe(LIMITS.sources);
  });
});

describe("parseDemand", () => {
  it("accepts checkable signals", () => {
    expect(parseDemand(structuredClone(demand), store)).toEqual(demand);
  });

  it("rejects a signal that is estimated rather than cited", () => {
    const d = structuredClone(demand);
    d.signals[0].detail = est("Halifax searches a month", "Population × search rate");
    expect(() => parseDemand(d, store)).toThrow(/must cite the source/);
  });

  it("rejects a store id in the detail text", () => {
    const d = structuredClone(demand);
    d.signals[0].detail = found("Halifax searches a month (S19)", "S1");
    expect(() => parseDemand(d, store)).toThrow(/do not put source ids/);
  });

  it("requires thin evidence below two signals, rated weak and said plainly", () => {
    const one = { ...structuredClone(demand), signals: [demand.signals[0]] };
    expect(() => parseDemand(one, store)).toThrow(/"thin"/);
    expect(() => parseDemand({ ...one, evidence: "thin" }, store)).toThrow(/Thin evidence/);
    expect(parseDemand({ ...one, evidence: "thin", scorecard: { rating: "weak", headline: null, unit: "", finding: "Thin evidence: search data only." } }, store).evidence).toBe("thin");
  });

  it("allows zero signals", () => {
    const none: DemandSection = { signals: [], evidence: "thin", scorecard: { rating: "weak", headline: null, unit: "", finding: "Thin evidence: nothing checkable found." } };
    expect(parseDemand(none, store).signals).toEqual([]);
    const report = buildPartialReport({ demand_evidence: none }, store);
    expect(report.demand_evidence).toEqual([]);
    expect(report.scorecard!.demand_evidence).toMatchObject({ key_figure: { value: "0", unit: "signals" }, basis: "estimated" });
    expect(report.sources.find((s) => s.text === `Estimate. ${COUNT_METHOD}`)).toBeDefined();
  });

  it("keeps figures out of the finding and holds the headline to a signal", () => {
    expect(() => parseDemand({ ...demand, scorecard: { ...demand.scorecard, finding: "212 reviews show demand." } }, store)).toThrow(/no figures/);
    expect(() => parseDemand({ ...demand, scorecard: { ...demand.scorecard, headline: "999" } }, store)).toThrow(/headline/);
  });
});

describe("demand fact-check", () => {
  const check = demandCheck(store);
  const claims = check.claims(demand);

  it("checks the figure together with what it counts", () => {
    expect(claims.map((c) => [c.id, c.text])).toEqual([["signals[0]", "1,900 Halifax searches a month"], ["signals[1]", "212 Google reviews for one groomer"]]);
  });

  it("drops an unsupported signal rather than rewording it, and the verdict turns to thin evidence", () => {
    const { section, log } = applyChecks(check, demand, claims, [result("signals[0]", "supported"), result("signals[1]", "unsupported", "rewrite", "Some reviews")]);
    expect(section.signals.map((s) => s.value)).toEqual(["1,900"]);
    expect(section.evidence).toBe("thin");
    expect(section.scorecard).toMatchObject({ rating: "weak", headline: null, finding: "Thin evidence: only one checkable signal found." });
    expect(log[1]).toMatchObject({ action: "dropped" });
  });

  it("keeps a partial signal as it is", () => {
    const { section, log } = applyChecks(check, demand, claims, [result("signals[0]", "partial", "rewrite", "1,000 searches"), result("signals[1]", "supported")]);
    expect(section).toEqual(demand);
    expect(log[0]).toMatchObject({ action: "kept" });
  });

  it("leaves a thin finding that already says so", () => {
    const thin = settleDemand({ ...demand, evidence: "thin", scorecard: { ...demand.scorecard, finding: "Thin evidence: reviews only." } });
    expect(thin.scorecard).toMatchObject({ rating: "weak", finding: "Thin evidence: reviews only." });
  });
});

describe("economics arithmetic", () => {
  it("formats money to fit the figure boxes", () => {
    expect([80, 7.5, 3500, 12500, 125000, 1250000, -4].map(money)).toEqual(["$80", "$7.50", "$3,500", "$12.5K", "$125K", "$1.3M", "-$4"]);
  });

  it("computes margin and break-even from the inputs", () => {
    expect(computeEconomics(econ)).toEqual({ kept: 57, margin: 57 / 80, breakEven: 44 });
    expect(computeEconomics({ ...econ, unit_cost: { ...econ.unit_cost, amount: 90 } }).breakEven).toBeNull();
  });

  it("shows the arithmetic, tagged as an estimate", () => {
    const r = economicsReport(econ);
    expect(r.unit.margin).toEqual({ value: "71%", label: "Gross margin", note: [est("($80 − $23) ÷ $80", ARITHMETIC_METHOD)] });
    expect(r.unit.break_even).toMatchObject({ value: "44", label: "Break-even, grooms a month", note: [est("$2,500 fixed ÷ $57 kept a sale", ARITHMETIC_METHOD)] });
    expect(r.workings.map((w) => [w.label, w.value])).toEqual([
      ["Price", "$80 a groom"], ["Unit cost", "$23"], ["Fixed costs", "$2,500 a month"], ["Gross margin", "71%"], ["Break-even", "44 grooms a month"],
    ]);
    expect(r.workings[4].note[0].text).toBe("$2,500 fixed costs a month ÷ $57 kept a sale = 43.9, rounded up");
    expect(r.score).toMatchObject({ key_figure: { value: "71%", unit: "gross margin" }, part: { estimate: ARITHMETIC_METHOD } });
  });
});

describe("parseEconomics", () => {
  it("accepts tagged inputs", () => {
    expect(parseEconomics(structuredClone(econ), store)).toEqual(econ);
  });

  it("rejects a figure that is neither sourced nor estimated", () => {
    const e = structuredClone(econ);
    e.unit_cost.note[1] = plain("+ $20 supplies");
    expect(() => parseEconomics(e, store)).toThrow(/every figure must cite/);
  });

  it("rejects a store id in a note or estimate method", () => {
    const e = structuredClone(econ);
    e.unit_cost.note[1] = est("+ $20 supplies and fuel", "(S19 median rate) for fuel");
    expect(() => parseEconomics(e, store)).toThrow(/do not put source ids/);
  });

  it("rejects a note with nothing tagged, a bad currency and figures in the finding", () => {
    expect(() => parseEconomics({ ...econ, price: { amount: 80, note: [plain("The founder's price")] } }, store)).toThrow(/at least one part/);
    expect(() => parseEconomics({ ...econ, currency: "dollars" }, store)).toThrow(/currency/);
    expect(() => parseEconomics({ ...econ, scorecard: { rating: "mixed", finding: "A 71% margin." } }, store)).toThrow(/no figures/);
  });

  it("counts the arithmetic against the source budget", () => {
    expect(() => parseEconomics(structuredClone(econ), store, 4)).toThrow(/limit is 4/);
  });
});

describe("economics fact-check", () => {
  const check = economicsCheck(store);
  const claims = check.claims(econ);
  const all = (overrides: CheckResult[]) => {
    const byId = new Map(overrides.map((r) => [r.id, r]));
    return claims.map((c) => byId.get(c.id) ?? result(c.id, "supported"));
  };

  it("lists the cited benchmarks with the input they support", () => {
    expect(claims.map((c) => c.id)).toEqual(["price.note[1]", "unit_cost.note[0]"]);
    expect(claims[1].context).toContain("unit cost input ($23 CAD per groom)");
  });

  it("re-tags an unconfirmed figure as a rough estimate instead of hiding it", () => {
    const { section, log } = applyChecks(check, econ, claims, all([result("unit_cost.note[0]", "unsupported", "drop")]));
    expect(section.unit_cost.note[0]).toEqual(est("$0.30 + 2.9% card fee", UNCONFIRMED_METHOD));
    expect(log[1]).toMatchObject({ action: "estimated", result: UNCONFIRMED_METHOD });
  });

  it("never lets a rewrite change the numbers", () => {
    const { section: same } = applyChecks(check, econ, claims, all([result("price.note[1]", "partial", "rewrite", "salons charge $50-$90")]));
    expect(same).toEqual(econ);
    const { section: narrowed } = applyChecks(check, econ, claims, all([result("price.note[1]", "partial", "rewrite", "Halifax salons charge $70-$120")]));
    expect(narrowed.price.note[1]).toEqual(found("Halifax salons charge $70-$120", "S3"));
  });

  it("takes the checker's own method when it gives one", () => {
    const { section } = applyChecks(check, econ, claims, all([result("price.note[1]", "unsupported", "estimate", null, "Typical salon range in Atlantic Canada")]));
    expect(section.price.note[1]).toEqual(est("salons charge $70-$120", "Typical salon range in Atlantic Canada"));
  });
});

describe("buildPartialReport with the demand and economics sections", () => {
  const report = buildPartialReport({ demand_evidence: demand, economics: econ }, store, { date: "2026-10-12" });

  it("builds demand and economics, with the arithmetic cited once", () => {
    expect(report.demand_evidence!.map((d) => d.value)).toEqual(["1,900", "212"]);
    expect(report.scorecard!.demand_evidence).toMatchObject({ key_figure: { value: "212", unit: "reviews" }, basis: "found" });
    expect(report.economics).toMatchObject({ per: "groom", currency: "CAD", unit: { margin: { value: "71%" }, break_even: { value: "44" } } });
    expect(report.economics!.market_size).toBeUndefined();
    expect(report.economics!.unit.max_cac).toBeUndefined();
    expect(report.scorecard!.economics).toMatchObject({ key_figure: { value: "71%", unit: "gross margin" }, basis: "estimated" });
    expect(report.sources.filter((s) => s.text === `Estimate. ${ARITHMETIC_METHOD}`)).toHaveLength(1);
  });

  it("still parses older reports with market size and max CAC", () => {
    expect(parseReport(structuredClone(SAMPLE_REPORT)).economics.unit.max_cac?.value).toBe("$1.98");
    const both = structuredClone(SAMPLE_REPORT) as unknown as { economics: { unit: Record<string, unknown> } };
    both.economics.unit.break_even = both.economics.unit.max_cac;
    expect(() => parseReport(both)).toThrow(/either max_cac or break_even/);
  });
});
