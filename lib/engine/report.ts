import sample from "./fixtures/sample.json";
import type { SourceStore, Source as StoreSource } from "./research";
import type { AlternativesSection, Part } from "./sections/alternatives";
import { PRICE_NOT_PUBLIC, type Alternative, type Claim, type Rich, type ScoreEntry, type Source, type TeardownReport } from "./types";
import { LIMITS, ReportError, parseReport } from "./validate";

// Turns section output, which cites SourceStore ids ("S12") or estimate
// methods, into a TeardownReport, which cites 1-based indices into its own
// `sources`. Sections not yet produced by the engine come from a base report
// (the sample), with the sources they cite carried over and renumbered.

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

/** The base report without the parts the alternatives section replaces. */
function baseRest(base: TeardownReport): Record<string, unknown> & { scorecard: Record<string, unknown> } {
  const rest = { ...base, scorecard: { ...base.scorecard } } as Record<string, unknown> & { scorecard: Record<string, unknown> };
  for (const k of ["alternatives", "market_gap", "sources"]) delete rest[k];
  delete rest.scorecard.alternatives;
  return rest;
}

/** Base-report sources still cited once the alternatives section is replaced, in order. */
function baseSourcesInUse(base: TeardownReport): number[] {
  const used = new Set<number>();
  mapCites(baseRest(base), (c) => (used.add(c.source as number), c));
  return [...used].sort((a, b) => a - b);
}

/** How many distinct sources the alternatives section may cite and still fit LIMITS.sources. */
export function liveSourceBudget(base: TeardownReport = SAMPLE_REPORT): number {
  return LIMITS.sources - baseSourcesInUse(base).length;
}

/**
 * Builds a report with the live alternatives section and every other section
 * from `base`. Found citations take their URL from the SourceStore, never from
 * the model. Throws ReportError if the result breaks the report's limits.
 */
export function buildReport(
  section: AlternativesSection,
  store: SourceStore,
  { base = SAMPLE_REPORT, date = new Date().toISOString().slice(0, 10) }: { base?: TeardownReport; date?: string } = {},
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

  const alternatives: Alternative[] = section.alternatives.map((a, i) => {
    const p = `alternatives[${i}]`;
    return {
      name: a.name,
      ...(a.workaround ? { workaround: true } : { examples: a.examples ?? "" }),
      what_it_does: a.what_it_does,
      price: isNotPublic(a.price) ? PRICE_NOT_PUBLIC : claim(a.price, `${p}.price`),
      weakness: rich(a.weakness, `${p}.weakness`),
    };
  });
  const market_gap = rich(section.market_gap, "market_gap");
  const sc = section.scorecard;
  const { basis, source } = claim({ text: sc.finding, source: sc.source, estimate: sc.estimate }, "scorecard.alternatives");
  const score: ScoreEntry = { rating: sc.rating, key_figure: sc.key_figure, finding: sc.finding, basis, source };

  // The base's other sections follow, with their sources renumbered after the live ones.
  const renumber = new Map(baseSourcesInUse(base).map((n) => [n, sources.push(base.sources[n - 1])]));
  const rest = mapCites(baseRest(base), (c) => ({ ...c, source: renumber.get(c.source as number) })) as ReturnType<typeof baseRest>;

  return parseReport({
    ...rest,
    date,
    sources_retrieved: retrieved ? retrieved.slice(0, 10) : date,
    scorecard: { ...rest.scorecard, alternatives: score },
    alternatives,
    market_gap,
    sources,
  });
}
