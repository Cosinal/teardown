import {
  PRICE_NOT_PUBLIC,
  type Alternative, type Assumption, type Basis, type Blocker, type Channel, type Claim, type DemandSignal, type Figure,
  type Level, type NextTest, type Rating, type Rich, type ScoreEntry, type Source, type TeardownReport,
} from "./types";

// Every page of the report is a fixed US Letter sheet, so content has hard
// limits. These caps are sized so a report at the maximum still fits each
// sheet (checked with a max-content fixture); the engine must stay within them.
export const LIMITS = {
  alternatives: 5,
  demand_evidence: 4,
  market_inputs: 3,
  distribution: 3,
  blockers: 3,
  riskiest_assumptions: 3,
  next_tests: 3,
  sources: 20,
} as const;

// Max characters per kind of text. Big-number fields are nowrap, so they
// overflow sideways rather than wrapping.
const LEN = { big: 6, tag: 14, label: 32, line: 100, sentence: 160, para: 240, long: 400 } as const;

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
  if (v.length > max) fail(path, `longer than ${max} characters`);
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

export function parseReport(input: unknown): TeardownReport {
  const r = obj(input, "report");

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
      if (total > max) fail(p, `longer than ${max} characters`);
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
      finding: str(o.finding, `${p}.finding`, 56),
      ...cite(o, p),
    };
  };

  const figure = (valueMax: number) => (x: unknown, p: string): Figure => {
    const o = obj(x, p);
    return { value: str(o.value, `${p}.value`, valueMax), label: str(o.label, `${p}.label`, LEN.label), note: rich(60)(o.note, `${p}.note`) };
  };

  const verdict = obj(r.verdict, "verdict");
  const idea = obj(r.idea, "idea");
  const sc = obj(r.scorecard, "scorecard");
  const ps = obj(r.page_summaries, "page_summaries");
  const econ = obj(r.economics, "economics");
  const size = obj(econ.market_size, "economics.market_size");
  const unit = obj(econ.unit, "economics.unit");

  const assumptions = list<Assumption>(r.riskiest_assumptions, "riskiest_assumptions", 1, LIMITS.riskiest_assumptions, (x, p) => {
    const o = obj(x, p);
    return {
      statement: str(o.statement, `${p}.statement`, 90),
      ...(o.short !== undefined && { short: str(o.short, `${p}.short`, LEN.line) }),
      if_false: str(o.if_false, `${p}.if_false`, LEN.line),
    };
  });

  return {
    date: isoDate(r.date, "date"),
    sources_retrieved: isoDate(r.sources_retrieved, "sources_retrieved"),
    verdict: {
      call: oneOf(verdict.call, "verdict.call", ["pursue", "test_first", "drop"] as const),
      confidence: oneOf<Level>(verdict.confidence, "verdict.confidence", LEVELS),
      summary: str(verdict.summary, "verdict.summary", LEN.sentence),
    },
    idea: {
      name: str(idea.name, "idea.name", 70),
      headline: str(idea.headline, "idea.headline", 64),
      customer: str(idea.customer, "idea.customer", 90),
      problem: str(idea.problem, "idea.problem", 90),
      revenue: str(idea.revenue, "idea.revenue", 90),
    },
    scorecard: {
      alternatives: score(sc.alternatives, "scorecard.alternatives"),
      demand_evidence: score(sc.demand_evidence, "scorecard.demand_evidence"),
      economics: score(sc.economics, "scorecard.economics"),
      distribution: score(sc.distribution, "scorecard.distribution"),
      blockers: score(sc.blockers, "scorecard.blockers"),
    },
    page_summaries: {
      market: str(ps.market, "page_summaries.market", LEN.sentence),
      business: str(ps.business, "page_summaries.business", LEN.sentence),
      next_steps: str(ps.next_steps, "page_summaries.next_steps", LEN.sentence),
    },
    alternatives: list<Alternative>(r.alternatives, "alternatives", 1, LIMITS.alternatives, (x, p) => {
      const o = obj(x, p);
      const workaround = o.workaround === true;
      return {
        name: str(o.name, `${p}.name`, 26),
        ...(workaround ? { workaround } : { examples: str(o.examples, `${p}.examples`, 30) }),
        what_it_does: str(o.what_it_does, `${p}.what_it_does`, 64),
        price: o.price === PRICE_NOT_PUBLIC ? PRICE_NOT_PUBLIC : claim(30)(o.price, `${p}.price`),
        weakness: rich(90)(o.weakness, `${p}.weakness`),
      };
    }),
    market_gap: rich(LEN.long)(r.market_gap, "market_gap"),
    demand_evidence: list<DemandSignal>(r.demand_evidence, "demand_evidence", 1, LIMITS.demand_evidence, (x, p) => {
      const o = obj(x, p);
      return {
        signal: str(o.signal, `${p}.signal`, 26),
        rating: oneOf<Rating>(o.rating, `${p}.rating`, RATINGS),
        value: str(o.value, `${p}.value`, LEN.big),
        detail: claim(50)(o.detail, `${p}.detail`),
      };
    }),
    economics: {
      market_size: marketSize(
        list(size.inputs, "economics.market_size.inputs", 2, LIMITS.market_inputs, figure(7)),
        figure(7)(size.result, "economics.market_size.result"),
      ),
      unit: {
        price: figure(LEN.big)(unit.price, "economics.unit.price"),
        cost_to_serve: figure(LEN.big)(unit.cost_to_serve, "economics.unit.cost_to_serve"),
        max_cac: figure(LEN.big)(unit.max_cac, "economics.unit.max_cac"),
        margin: figure(LEN.big)(unit.margin, "economics.unit.margin"),
      },
    },
    distribution: list<Channel>(r.distribution, "distribution", 1, LIMITS.distribution, (x, p) => {
      const o = obj(x, p);
      return {
        name: str(o.name, `${p}.name`, 34),
        examples: str(o.examples, `${p}.examples`, 46),
        rating: oneOf<Rating>(o.rating, `${p}.rating`, RATINGS),
        reason: claim(110)(o.reason, `${p}.reason`),
      };
    }),
    blockers: list<Blocker>(r.blockers, "blockers", 0, LIMITS.blockers, (x, p) => {
      const o = obj(x, p);
      return {
        type: str(o.type, `${p}.type`, 12),
        risk: str(o.risk, `${p}.risk`, 36),
        severity: oneOf<Level>(o.severity, `${p}.severity`, LEVELS),
        detail: claim(LEN.line)(o.detail, `${p}.detail`),
      };
    }),
    riskiest_assumptions: assumptions,
    next_tests: list<NextTest>(r.next_tests, "next_tests", 1, LIMITS.next_tests, (x, p) => {
      const o = obj(x, p);
      const assumption = o.assumption;
      if (typeof assumption !== "number" || !Number.isInteger(assumption) || assumption < 1 || assumption > assumptions.length) {
        fail(`${p}.assumption`, `expected an assumption rank from 1 to ${assumptions.length}`);
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
    }),
    sources,
  };
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
