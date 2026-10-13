import sample from "./fixtures/sample.json";
import type { SourceStore, Source as StoreSource } from "./research";
import type { AlternativesSection, Part } from "./sections/alternatives";
import { demandScore, type DemandSection } from "./sections/demand";
import { economicsReport, type EconomicsSection } from "./sections/economics";
import { PRICE_NOT_PUBLIC, type Alternative, type Claim, type DemandSignal, type Figure, type Rich, type ScoreEntry, type Source, type TeardownReport, type Working } from "./types";
import { LIMITS, ReportError, parseReport } from "./validate";

// Turns section output, which cites SourceStore ids ("S12") or estimate
// methods, into a TeardownReport, which cites 1-based indices into its own
// `sources`. Sections not yet produced by the engine come from a base report
// (the sample), with the sources they cite carried over and renumbered.
//
// The live sections share the report's source limit, so each gets its own
// budget of distinct sources (estimate methods count too).

/** The design's sample report (Teardown's own idea), validated once at load. */
export const SAMPLE_REPORT: TeardownReport = parseReport(sample);

const SOURCE_TEXT_MAX = 100;

/** True for an uncited "Not public" price, in any case. */
export function isNotPublic(p: Part): boolean {
  return !p.source && !p.estimate && p.text.trim().toLowerCase() === PRICE_NOT_PUBLIC.toLowerCase();
}

/** A found source's line on the sources page: the page title, cut to fit. */
export function sourceText(s: StoreSource): string {
  const t = s.title.trim() || s.url;
  return t.length > SOURCE_TEXT_MAX ? `${t.slice(0, SOURCE_TEXT_MAX - 1)}…` : t;
}

type Cited = { basis: unknown; source: unknown };
const isCite = (v: object): v is Cited => "basis" in v && typeof (v as Cited).source === "number";

/** Calls `fn` on every citation object inside `v` and returns a copy with the results. */
function mapCites(v: unknown, fn: (c: Cited) => Cited): unknown {
  if (Array.isArray(v)) return v.map((x) => mapCites(x, fn));
  if (typeof v !== "object" || v === null) return v;
  const copy = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapCites(x, fn)]));
  return isCite(copy) ? fn(copy) : copy;
}

export type LiveSection = "alternatives" | "demand_evidence" | "economics";
const LIVE: LiveSection[] = ["alternatives", "demand_evidence", "economics"];
/** The report fields each live section replaces. */
const FIELDS: Record<LiveSection, string[]> = { alternatives: ["alternatives", "market_gap"], demand_evidence: ["demand_evidence"], economics: ["economics"] };

/** The base report without the parts the given live sections replace. */
function baseRest(base: TeardownReport, live: LiveSection[]): Record<string, unknown> & { scorecard: Record<string, unknown> } {
  const rest = { ...base, scorecard: { ...base.scorecard } } as Record<string, unknown> & { scorecard: Record<string, unknown> };
  delete rest.sources;
  for (const name of live) {
    for (const k of FIELDS[name]) delete rest[k];
    delete rest.scorecard[name];
  }
  return rest;
}

/** Base-report sources still cited once the given live sections are replaced, in order. */
function baseSourcesInUse(base: TeardownReport, live: LiveSection[] = LIVE): number[] {
  const used = new Set<number>();
  mapCites(baseRest(base, live), (c) => (used.add(c.source as number), c));
  return [...used].sort((a, b) => a - b);
}

/** Fixed budgets for the two smaller sections: four signals plus a count, and three inputs plus the arithmetic. */
const BUDGET = { demand_evidence: 4, economics: 5 } as const;

/** How many distinct sources each live section may cite, so that all of them together fit LIMITS.sources. */
export function liveSourceBudgets(base: TeardownReport = SAMPLE_REPORT): Record<LiveSection, number> {
  const total = LIMITS.sources - baseSourcesInUse(base).length;
  return { alternatives: total - BUDGET.demand_evidence - BUDGET.economics, ...BUDGET };
}

/** The Existing Alternatives section's share of liveSourceBudgets. */
export function liveSourceBudget(base: TeardownReport = SAMPLE_REPORT): number {
  return liveSourceBudgets(base).alternatives;
}

/**
 * Builds a report with the live sections given and every other section from
 * `base`; null alternatives also come from `base`. Found citations take their
 * URL from the SourceStore, never from the model. Throws ReportError if the
 * result breaks the report's limits.
 */
export function buildReport(
  section: AlternativesSection | null,
  store: SourceStore,
  { base = SAMPLE_REPORT, date = new Date().toISOString().slice(0, 10), demand, economics }: {
    base?: TeardownReport; date?: string; demand?: DemandSection; economics?: EconomicsSection;
  } = {},
): TeardownReport {
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

  // Live sections in page order, so sources are numbered as the reader meets them.
  const live: Record<string, unknown> = {};
  const scores: Record<string, ScoreEntry> = {};
  if (section) {
    live.alternatives = section.alternatives.map((a, i): Alternative => {
      const p = `alternatives[${i}]`;
      return {
        name: a.name,
        ...(a.workaround ? { workaround: true } : { examples: a.examples ?? "" }),
        what_it_does: a.what_it_does,
        price: isNotPublic(a.price) ? PRICE_NOT_PUBLIC : claim(a.price, `${p}.price`),
        weakness: rich(a.weakness, `${p}.weakness`),
      };
    });
    live.market_gap = rich(section.market_gap, "market_gap");
    const sc = section.scorecard;
    scores.alternatives = score({ ...sc, part: { text: sc.finding, source: sc.source, estimate: sc.estimate } }, "scorecard.alternatives");
  }
  if (demand) {
    live.demand_evidence = demand.signals.map((s, i): DemandSignal => (
      { signal: s.signal, rating: s.rating, value: s.value, detail: claim(s.detail, `demand_evidence[${i}].detail`) }
    ));
    scores.demand_evidence = score(demandScore(demand), "scorecard.demand_evidence");
  }
  if (economics) {
    const e = economicsReport(economics);
    const figure = (f: { value: string; label: string; note: Part[] }, path: string): Figure => ({ value: f.value, label: f.label, note: rich(f.note, `${path}.note`) });
    live.economics = {
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

  // The base's other sections follow, with their sources renumbered after the live ones.
  const replaced = LIVE.filter((n) => n in scores);
  const renumber = new Map(baseSourcesInUse(base, replaced).map((n) => [n, sources.push(base.sources[n - 1])]));
  const rest = mapCites(baseRest(base, replaced), (c) => ({ ...c, source: renumber.get(c.source as number) })) as ReturnType<typeof baseRest>;

  return parseReport({
    ...rest,
    ...live,
    date,
    sources_retrieved: retrieved ? retrieved.slice(0, 10) : date,
    scorecard: { ...rest.scorecard, ...scores },
    sources,
  });
}
