import {
  PRICE_NOT_PUBLIC,
  type Alternative, type Assumption, type Basis, type Blocker, type Channel, type Claim, type DemandSignal, type Figure,
  type Level, type NextTest, type Rating, type Rich, type ScoreEntry, type Source, type TeardownReport, type Working,
} from "./types";

// Every page of the report is a fixed US Letter sheet, so content has hard
// limits. These caps are sized so a report at the maximum still fits each
// sheet (checked with a max-content fixture); the engine must stay within them.
export const LIMITS = {
  alternatives: 5,
  demand_evidence: 4,
  market_inputs: 3,
  workings: 5,
  distribution: 3,
  blockers: 3,
  riskiest_assumptions: 3,
  next_tests: 3,
  sources: 20,
} as const;

// Max characters per kind of text. Big-number fields are nowrap, so they
// overflow sideways rather than wrapping. `finding` is the scorecard line.
export const LEN = { big: 6, tag: 14, label: 32, finding: 56, line: 100, sentence: 160, para: 240, long: 400 } as const;

/** The validation message runWriter treats as a display-text length overrun. */
export function overLen(path: string, length: number, max: number): string {
  return `${path}: ${length} characters, at most ${max}`;
}

export class ReportError extends Error {}

type Obj = Record<string, unknown>;

function fail(path: string, msg: string): never {
  throw new ReportError(`${path}: ${msg}`);
}

function obj(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "expected an object");
  return v as Obj;
}

function str(v: unknown, path: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) fail(path, "expected a non-empty string");
  if (v.length > max) fail(path, `${v.length} characters, at most ${max}`);
  return v;
}

function optStr(v: unknown, path: string, max: number): string | undefined {
  return v === undefined ? undefined : str(v, path, max);
}

function oneOf<T extends string>(v: unknown, path: string, options: readonly T[]): T {
  if (!options.includes(v as T)) fail(path, `expected one of ${options.join(", ")}`);
  return v as T;
}

function list<T>(v: unknown, path: string, min: number, max: number, item: (x: unknown, p: string) => T): T[] {
  if (!Array.isArray(v)) fail(path, "expected an array");
  if (v.length < min || v.length > max) fail(path, `expected ${min} to ${max} items, got ${v.length}`);
  return v.map((x, i) => item(x, `${path}[${i}]`));
}

const BASES = ["found", "estimated"] as const;
const LEVELS = ["low", "medium", "high"] as const;
const RATINGS = ["strong", "mixed", "weak"] as const;

/** A report with only some of its sections, e.g. while the engine is still writing. Sources are always present. */
export type PartialReport = Partial<Omit<TeardownReport, "scorecard" | "sources">> & {
  scorecard?: Partial<TeardownReport["scorecard"]>;
  sources: Source[];
};

const SCORE_KEYS = ["alternatives", "demand_evidence", "economics", "distribution", "blockers"] as const;

/** Validates a whole report against the page limits. */
export function parseReport(input: unknown): TeardownReport {
  return parseFields(input, true) as TeardownReport;
}

/**
 * Validates the sections a partial report has, with the same limits as a whole
 * report. Sections it leaves out are not checked; sources are required.
 */
export function parsePartialReport(input: unknown): PartialReport {
  return parseFields(input, false);
}

function parseFields(input: unknown, complete: boolean): PartialReport {
  const r = obj(input, "report");
  const has = (o: Obj, k: string) => complete || o[k] !== undefined;

  // Sources first, so every citation can be checked against them.
  const sources = list<Source>(r.sources, "sources", 1, LIMITS.sources, (x, p) => {
    const s = obj(x, p);
    const url = optStr(s.url, `${p}.url`, 2000);
    if (url && !/^https?:\/\//.test(url)) fail(`${p}.url`, "expected an http(s) URL");
    return { basis: oneOf(s.basis, `${p}.basis`, BASES), text: str(s.text, `${p}.text`, LEN.line), ...(url && { url }) };
  });

  function cite(o: Obj, p: string): { basis: Basis; source: number } {
    const basis = oneOf(o.basis, `${p}.basis`, BASES);
    const source = o.source;
    if (typeof source !== "number" || !Number.isInteger(source) || source < 1 || source > sources.length) {
      fail(`${p}.source`, `expected a source number from 1 to ${sources.length}`);
    }
    if (sources[source - 1].basis !== basis) fail(p, `basis "${basis}" does not match source ${source}`);
    return { basis, source };
  }

  const claim = (max: number) => (x: unknown, p: string): Claim => {
    const o = obj(x, p);
    return { text: str(o.text, `${p}.text`, max), ...cite(o, p) };
  };

  const rich = (max: number) => (x: unknown, p: string): Rich => {
    const part = (y: unknown, q: string) => (typeof y === "string" ? str(y, q, max) : claim(max)(y, q));
    if (Array.isArray(x)) {
      const parts = list(x, p, 1, 4, part);
      const total = parts.reduce((n, y) => n + (typeof y === "string" ? y : y.text).length, 0);
      if (total > max) fail(p, `${total} characters, at most ${max}`);
      return parts;
    }
    return part(x, p);
  };

  const score = (x: unknown, p: string): ScoreEntry => {
    const o = obj(x, p);
    const k = obj(o.key_figure, `${p}.key_figure`);
    // Value and unit share a nowrap 116px column.
    if (String(k.value).length + String(k.unit).length > 16) fail(`${p}.key_figure`, "value and unit longer than 16 characters combined");
    return {
      rating: oneOf(o.rating, `${p}.rating`, RATINGS),
      key_figure: { value: str(k.value, `${p}.key_figure.value`, LEN.big), unit: str(k.unit, `${p}.key_figure.unit`, LEN.tag) },
      finding: str(o.finding, `${p}.finding`, LEN.finding),
      ...cite(o, p),
    };
  };

  const figure = (valueMax: number) => (x: unknown, p: string): Figure => {
    const o = obj(x, p);
    return { value: str(o.value, `${p}.value`, valueMax), label: str(o.label, `${p}.label`, LEN.label), note: rich(60)(o.note, `${p}.note`) };
  };

  const economics = (x: unknown) => {
    const econ = obj(x, "economics");
    const unit = obj(econ.unit, "economics.unit");
    if ((unit.max_cac === undefined) === (unit.break_even === undefined)) fail("economics.unit", "expected either max_cac or break_even");
    return {
      ...(econ.market_size !== undefined && {
        market_size: marketSize(
          list(obj(econ.market_size, "economics.market_size").inputs, "economics.market_size.inputs", 2, LIMITS.market_inputs, figure(7)),
          figure(7)(obj(econ.market_size, "economics.market_size").result, "economics.market_size.result"),
        ),
      }),
      ...(econ.per !== undefined && { per: str(econ.per, "economics.per", 24) }),
      ...(econ.currency !== undefined && { currency: str(econ.currency, "economics.currency", 3) }),
      unit: {
        price: figure(LEN.big)(unit.price, "economics.unit.price"),
        cost_to_serve: figure(LEN.big)(unit.cost_to_serve, "economics.unit.cost_to_serve"),
        ...(unit.max_cac !== undefined && { max_cac: figure(LEN.big)(unit.max_cac, "economics.unit.max_cac") }),
        ...(unit.break_even !== undefined && { break_even: figure(LEN.big)(unit.break_even, "economics.unit.break_even") }),
        margin: figure(LEN.big)(unit.margin, "economics.unit.margin"),
      },
      ...(econ.workings !== undefined && {
        workings: list<Working>(econ.workings, "economics.workings", 1, LIMITS.workings, (y, p) => {
          const o = obj(y, p);
          return { label: str(o.label, `${p}.label`, 16), value: str(o.value, `${p}.value`, 22), note: rich(130)(o.note, `${p}.note`) };
        }),
      }),
    };
  };

  const out: PartialReport = { sources };
  if (has(r, "date")) out.date = isoDate(r.date, "date");
  if (has(r, "sources_retrieved")) out.sources_retrieved = isoDate(r.sources_retrieved, "sources_retrieved");
  if (has(r, "verdict")) {
    const verdict = obj(r.verdict, "verdict");
    out.verdict = {
      call: oneOf(verdict.call, "verdict.call", ["pursue", "test_first", "drop"] as const),
      confidence: oneOf<Level>(verdict.confidence, "verdict.confidence", LEVELS),
      summary: str(verdict.summary, "verdict.summary", LEN.sentence),
    };
  }
  if (has(r, "idea")) {
    const idea = obj(r.idea, "idea");
    out.idea = {
      name: str(idea.name, "idea.name", 70),
      headline: str(idea.headline, "idea.headline", 64),
      customer: str(idea.customer, "idea.customer", 90),
      problem: str(idea.problem, "idea.problem", 90),
      revenue: str(idea.revenue, "idea.revenue", 90),
    };
  }
  if (has(r, "scorecard")) {
    const sc = obj(r.scorecard, "scorecard");
    out.scorecard = Object.fromEntries(SCORE_KEYS.filter((k) => has(sc, k)).map((k) => [k, score(sc[k], `scorecard.${k}`)]));
  }
  if (has(r, "page_summaries")) {
    const ps = obj(r.page_summaries, "page_summaries");
    out.page_summaries = {
      market: str(ps.market, "page_summaries.market", LEN.sentence),
      business: str(ps.business, "page_summaries.business", LEN.sentence),
      next_steps: str(ps.next_steps, "page_summaries.next_steps", LEN.sentence),
    };
  }
  if (has(r, "alternatives")) {
    out.alternatives = list<Alternative>(r.alternatives, "alternatives", 1, LIMITS.alternatives, (x, p) => {
      const o = obj(x, p);
      const workaround = o.workaround === true;
      return {
        name: str(o.name, `${p}.name`, 26),
        ...(workaround ? { workaround } : { examples: str(o.examples, `${p}.examples`, 30) }),
        what_it_does: str(o.what_it_does, `${p}.what_it_does`, 64),
        price: o.price === PRICE_NOT_PUBLIC ? PRICE_NOT_PUBLIC : claim(30)(o.price, `${p}.price`),
        weakness: rich(90)(o.weakness, `${p}.weakness`),
      };
    });
  }
  if (has(r, "market_gap")) out.market_gap = rich(LEN.long)(r.market_gap, "market_gap");
  if (has(r, "demand_evidence")) {
    // Empty when no checkable signal was found; the page says so.
    out.demand_evidence = list<DemandSignal>(r.demand_evidence, "demand_evidence", 0, LIMITS.demand_evidence, (x, p) => {
      const o = obj(x, p);
      return {
        signal: str(o.signal, `${p}.signal`, 26),
        rating: oneOf<Rating>(o.rating, `${p}.rating`, RATINGS),
        value: str(o.value, `${p}.value`, LEN.big),
        detail: claim(50)(o.detail, `${p}.detail`),
      };
    });
  }
  if (has(r, "economics")) out.economics = economics(r.economics);
  if (has(r, "distribution")) {
    out.distribution = list<Channel>(r.distribution, "distribution", 1, LIMITS.distribution, (x, p) => {
      const o = obj(x, p);
      return {
        name: str(o.name, `${p}.name`, 34),
        examples: str(o.examples, `${p}.examples`, 46),
        rating: oneOf<Rating>(o.rating, `${p}.rating`, RATINGS),
        reason: rich(110)(o.reason, `${p}.reason`),
      };
    });
  }
  if (has(r, "blockers")) {
    out.blockers = list<Blocker>(r.blockers, "blockers", 0, LIMITS.blockers, (x, p) => {
      const o = obj(x, p);
      return {
        type: str(o.type, `${p}.type`, 12),
        risk: str(o.risk, `${p}.risk`, 36),
        severity: oneOf<Level>(o.severity, `${p}.severity`, LEVELS),
        detail: claim(LEN.line)(o.detail, `${p}.detail`),
      };
    });
  }
  if (has(r, "riskiest_assumptions")) {
    out.riskiest_assumptions = list<Assumption>(r.riskiest_assumptions, "riskiest_assumptions", 1, LIMITS.riskiest_assumptions, (x, p) => {
      const o = obj(x, p);
      return {
        statement: str(o.statement, `${p}.statement`, 90),
        ...(o.short !== undefined && { short: str(o.short, `${p}.short`, LEN.line) }),
        if_false: str(o.if_false, `${p}.if_false`, LEN.line),
      };
    });
  }
  if (has(r, "next_tests")) {
    const assumptions = out.riskiest_assumptions?.length ?? LIMITS.riskiest_assumptions;
    out.next_tests = list<NextTest>(r.next_tests, "next_tests", 1, LIMITS.next_tests, (x, p) => {
      const o = obj(x, p);
      const assumption = o.assumption;
      if (typeof assumption !== "number" || !Number.isInteger(assumption) || assumption < 1 || assumption > assumptions) {
        fail(`${p}.assumption`, `expected an assumption rank from 1 to ${assumptions}`);
      }
      return {
        name: str(o.name, `${p}.name`, 24),
        description: str(o.description, `${p}.description`, 64),
        ...(o.summary !== undefined && { summary: str(o.summary, `${p}.summary`, LEN.para) }),
        assumption,
        proves: str(o.proves, `${p}.proves`, 40),
        cost: str(o.cost, `${p}.cost`, 10),
        time: str(o.time, `${p}.time`, 10),
        kill_threshold: str(o.kill_threshold, `${p}.kill_threshold`, 70),
        ...(o.kill_threshold_short !== undefined && { kill_threshold_short: str(o.kill_threshold_short, `${p}.kill_threshold_short`, 32) }),
      };
    });
  }
  return out;
}

function isoDate(v: unknown, path: string): string {
  const s = str(v, path, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) fail(path, "expected an ISO date (YYYY-MM-DD)");
  return s;
}

// The sizing values share one row at 42px, so their combined length is capped.
function marketSize(inputs: Figure[], result: Figure) {
  const chars = [...inputs, result].reduce((n, f) => n + f.value.length, 0);
  if (chars > 20) fail("economics.market_size", "values longer than 20 characters combined");
  return { inputs, result };
}
