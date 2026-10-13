import type { IdeaSpec } from "./intake";
import type { SourceStore, Source as StoreSource } from "./research";
import type { AlternativesSection, Part } from "./sections/alternatives";
import { assumptionsReport, type AssumptionsSection } from "./sections/assumptions";
import { blockersReport, type BlockersSection } from "./sections/blockers";
import { demandScore, type DemandSection } from "./sections/demand";
import { distributionReport, type DistributionSection } from "./sections/distribution";
import { economicsReport, type EconomicsSection } from "./sections/economics";
import type { IdeaSection } from "./sections/idea";
import { testsReport, type TestsSection } from "./sections/tests";
import type { VerdictSection } from "./sections/verdict";
import { PRICE_NOT_PUBLIC, type Alternative, type Claim, type DemandSignal, type Figure, type Rich, type ScoreEntry, type Source, type TeardownReport, type Working } from "./types";
import { LIMITS, ReportError, parsePartialReport, parseReport, type PartialReport } from "./validate";

// Turns section drafts, which cite SourceStore ids ("S12") or estimate
// methods, into a TeardownReport, which cites 1-based indices into its own
// `sources`. Every section comes from the engine; a partial report (some
// sections only) is validated against the same page limits while the engine
// is still writing.
//
// The sections share the report's source limit. The first three each get a
// fixed budget of distinct sources (estimate methods count too); Distribution
// and Blockers split whatever is left once those three are written.

const SOURCE_TEXT_MAX = 100;

/** Fixed budgets for the three sections that do their own research. */
export const SOURCE_BUDGETS: Readonly<Record<"alternatives" | "demand_evidence" | "economics", number>> = { alternatives: 7, demand_evidence: 4, economics: 5 };

/** Distribution and Blockers split the sources the first three sections left unused, Distribution taking the odd one. */
export function laterBudgets(used: number): { distribution: number; blockers: number } {
  const left = Math.max(0, LIMITS.sources - used);
  return { distribution: Math.ceil(left / 2), blockers: Math.floor(left / 2) };
}

/** Every section as the engine writes it, citing SourceStore ids. */
export interface Drafts {
  alternatives: AlternativesSection;
  demand_evidence: DemandSection;
  economics: EconomicsSection;
  idea: IdeaSection;
  distribution: DistributionSection;
  blockers: BlockersSection;
  riskiest_assumptions: AssumptionsSection;
  next_tests: TestsSection;
  verdict: VerdictSection;
}

export interface BuildOptions {
  /** ISO date the report was produced. Defaults to today. */
  date?: string;
  /** The founder's billing, from the idea spec: Distribution judges acquisition cost by payback for a subscription. */
  billing?: IdeaSpec["revenue_model"]["billing"];
}

/** True for an uncited "Not public" price, in any case. */
export function isNotPublic(p: Part): boolean {
  return !p.source && !p.estimate && p.text.trim().toLowerCase() === PRICE_NOT_PUBLIC.toLowerCase();
}

/** A found source's line on the sources page: the page title, cut to fit. */
export function sourceText(s: StoreSource): string {
  const t = s.title.trim() || s.url;
  return t.length > SOURCE_TEXT_MAX ? `${t.slice(0, SOURCE_TEXT_MAX - 1)}…` : t;
}

/** The report fields for the drafts given, unvalidated. */
function assemble(drafts: Partial<Drafts>, store: SourceStore, { date = new Date().toISOString().slice(0, 10), billing }: BuildOptions): Record<string, unknown> {
  const byId = new Map(store.map((s) => [s.id, s]));
  const sources: Source[] = [];
  const index = new Map<string, number>();
  let retrieved = "";

  const add = (key: string, source: () => Source) => {
    if (!index.has(key)) index.set(key, sources.push(source()));
    return index.get(key)!;
  };

  const part = (p: Part, path: string): string | Claim => {
    if (p.source) {
      const s = byId.get(p.source);
      if (!s) throw new ReportError(`${path}: unknown source id ${p.source}`);
      if (s.retrieved_at > retrieved) retrieved = s.retrieved_at;
      return { text: p.text, basis: "found", source: add(s.id, () => ({ basis: "found", text: sourceText(s), url: s.url })) };
    }
    if (p.estimate) {
      const method = p.estimate.trim();
      return { text: p.text, basis: "estimated", source: add(`estimate:${method}`, () => ({ basis: "estimated", text: `Estimate. ${method}` })) };
    }
    return p.text;
  };

  const claim = (p: Part, path: string): Claim => {
    const c = part(p, path);
    if (typeof c === "string") throw new ReportError(`${path}: needs a source id or an estimate method`);
    return c;
  };

  const rich = (parts: Part[], path: string): Rich =>
    parts.length === 1 ? part(parts[0], path) : parts.map((p, i) => part(p, `${path}[${i}]`));

  const score = (s: { rating: ScoreEntry["rating"]; key_figure: ScoreEntry["key_figure"]; finding: string; part: Part }, path: string): ScoreEntry => {
    const { basis, source } = claim(s.part, path);
    return { rating: s.rating, key_figure: s.key_figure, finding: s.finding, basis, source };
  };

  // Cited sections in page order, so sources are numbered as the reader meets them.
  const out: Record<string, unknown> = {};
  const scores: Record<string, ScoreEntry> = {};
  const { alternatives: section, demand_evidence: demand, economics, distribution, blockers } = drafts;
  if (section) {
    out.alternatives = section.alternatives.map((a, i): Alternative => {
      const p = `alternatives[${i}]`;
      return {
        name: a.name,
        ...(a.workaround ? { workaround: true } : { examples: a.examples ?? "" }),
        what_it_does: a.what_it_does,
        price: isNotPublic(a.price) ? PRICE_NOT_PUBLIC : claim(a.price, `${p}.price`),
        weakness: rich(a.weakness, `${p}.weakness`),
      };
    });
    out.market_gap = rich(section.market_gap, "market_gap");
    const sc = section.scorecard;
    scores.alternatives = score({ ...sc, part: { text: sc.finding, source: sc.source, estimate: sc.estimate } }, "scorecard.alternatives");
  }
  if (demand) {
    out.demand_evidence = demand.signals.map((s, i): DemandSignal => (
      { signal: s.signal, rating: s.rating, value: s.value, detail: claim(s.detail, `demand_evidence[${i}].detail`) }
    ));
    scores.demand_evidence = score(demandScore(demand), "scorecard.demand_evidence");
  }
  if (economics) {
    const e = economicsReport(economics);
    const figure = (f: { value: string; label: string; note: Part[] }, path: string): Figure => ({ value: f.value, label: f.label, note: rich(f.note, `${path}.note`) });
    out.economics = {
      per: e.per,
      currency: e.currency,
      unit: {
        price: figure(e.unit.price, "economics.unit.price"),
        cost_to_serve: figure(e.unit.cost_to_serve, "economics.unit.cost_to_serve"),
        margin: figure(e.unit.margin, "economics.unit.margin"),
        break_even: figure(e.unit.break_even, "economics.unit.break_even"),
      },
      workings: e.workings.map((w, i): Working => figure(w, `economics.workings[${i}]`)),
    };
    scores.economics = score(e.score, "scorecard.economics");
  }
  if (distribution) {
    if (!economics) throw new ReportError("distribution: needs the economics section");
    const d = distributionReport(distribution, economics, billing === "subscription");
    out.distribution = d.channels.map((c, i) => ({ ...c, reason: rich(c.reason, `distribution[${i}].reason`) }));
    scores.distribution = score(d.score, "scorecard.distribution");
  }
  if (blockers) {
    const b = blockersReport(blockers);
    out.blockers = b.blockers.map((x, i) => ({ ...x, detail: claim(x.detail, `blockers[${i}].detail`) }));
    scores.blockers = score(b.score, "scorecard.blockers");
  }
  if (drafts.riskiest_assumptions) out.riskiest_assumptions = assumptionsReport(drafts.riskiest_assumptions);
  if (drafts.next_tests) out.next_tests = testsReport(drafts.next_tests);
  if (drafts.idea) out.idea = drafts.idea;
  if (drafts.verdict) {
    const { page_summaries, ...verdict } = drafts.verdict;
    out.verdict = verdict;
    out.page_summaries = page_summaries;
  }

  return {
    ...out,
    date,
    sources_retrieved: retrieved ? retrieved.slice(0, 10) : date,
    ...(Object.keys(scores).length && { scorecard: scores }),
    sources,
  };
}

/**
 * Builds the report from every section. Found citations take their URL from
 * the SourceStore, never from the model. Throws ReportError if the result
 * breaks the report's limits.
 */
export function buildReport(drafts: Drafts, store: SourceStore, options: BuildOptions = {}): TeardownReport {
  return parseReport(assemble(drafts, store, options));
}

/**
 * Builds and validates the sections given, e.g. to check one section's draft
 * against the page limits before the rest exist. Distribution needs Economics.
 */
export function buildPartialReport(drafts: Partial<Drafts>, store: SourceStore, options: BuildOptions = {}): PartialReport {
  return parsePartialReport(assemble(drafts, store, options));
}

/** How many entries the sources page has for the drafts given. */
export function sourcesUsed(drafts: Partial<Drafts>, store: SourceStore, options: BuildOptions = {}): number {
  return buildPartialReport(drafts, store, options).sources.length;
}
