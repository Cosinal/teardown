// The teardown report, one field per section of the 5-page design
// (Verdict, Market, Business, Next steps, Sources).
//
// Citation rule: every number or factual claim carries `basis` plus `source`,
// the 1-based index of its entry in `sources`. "found" means taken from a cited
// source. "estimated" means our own calculation or inference, with the method
// stated in the source entry. Commentary and figures taken from the idea itself
// (e.g. its own price) are plain strings.

export type Basis = "found" | "estimated";

export interface Cite {
  basis: Basis;
  /** 1-based index into `TeardownReport.sources`. */
  source: number;
}

/** A sentence or figure that is always cited. */
export interface Claim extends Cite {
  text: string;
}

/**
 * Prose that may cite some of its parts, e.g.
 * [{ text: "$0.50 card fee", basis: "found", source: 8 }, { text: "and $0.55 to run", basis: "estimated", source: 12 }].
 * Parts are joined with a space; each Claim renders its tag right after its text.
 */
export type Rich = string | Claim | (string | Claim)[];

export type VerdictCall = "pursue" | "test_first" | "drop";
export type Level = "low" | "medium" | "high";
export type Rating = "strong" | "mixed" | "weak";

export interface Verdict {
  call: VerdictCall;
  confidence: Level;
  /** One or two sentences that justify the call. */
  summary: string;
}

export interface Idea {
  /** Short name, shown in every page header. */
  name: string;
  /** The idea in one line, shown as the page-1 title. */
  headline: string;
  customer: string;
  problem: string;
  revenue: string;
}

export interface ScoreEntry extends Cite {
  rating: Rating;
  key_figure: { value: string; unit: string };
  /** One line. Also shown next to the section heading on pages 2 to 4. */
  finding: string;
}

export interface Scorecard {
  alternatives: ScoreEntry;
  demand_evidence: ScoreEntry;
  economics: ScoreEntry;
  distribution: ScoreEntry;
  blockers: ScoreEntry;
}

/** Price shown for a real competitor that publishes no pricing. Uncited: absence can't be sourced. */
export const PRICE_NOT_PUBLIC = "Not public";

export interface Alternative {
  name: string;
  /** Who offers it, e.g. "ChatGPT, Claude, Gemini". Ignored when `workaround` is true. */
  examples?: string;
  /** A manual workaround rather than a product. */
  workaround?: boolean;
  what_it_does: string;
  price: Claim | typeof PRICE_NOT_PUBLIC;
  weakness: Rich;
}

export interface DemandSignal {
  /** e.g. "Search interest". */
  signal: string;
  rating: Rating;
  /** The headline number, e.g. "6,600". */
  value: string;
  /** What the number counts, cited, e.g. "US searches a month". */
  detail: Claim;
}

export interface Figure {
  value: string;
  label: string;
  note: Rich;
}

/** One line of the arithmetic behind the unit economics, e.g. "Gross margin", "71%", "($80 − $23) ÷ $80". */
export interface Working {
  label: string;
  value: string;
  note: Rich;
}

export interface Economics {
  /** Bottom-up sizing: inputs are multiplied together to give `result`. Optional: the engine leaves it out. */
  market_size?: { inputs: Figure[]; result: Figure };
  /** What one sale is, e.g. "groom" or "customer a month". Shown as "Unit economics, per …". Defaults to "report". */
  per?: string;
  /** Currency of every figure, e.g. "CAD", when it is not obvious. */
  currency?: string;
  /** Four figures: price, cost to serve, margin, and either max CAC (older reports) or break-even. */
  unit: {
    price: Figure;
    cost_to_serve: Figure;
    max_cac?: Figure;
    break_even?: Figure;
    margin: Figure;
  };
  /** The inputs and arithmetic behind `unit`, in reading order. */
  workings?: Working[];
}

export interface Channel {
  name: string;
  examples: string;
  rating: Rating;
  reason: Claim;
}

export interface Blocker {
  /** e.g. "Legal", "Technical", "Platform". */
  type: string;
  risk: string;
  severity: Level;
  detail: Claim;
}

/** Ranked: index 0 is the riskiest. */
export interface Assumption {
  statement: string;
  /** Shorter phrasing for page 1. Falls back to `statement`. */
  short?: string;
  /** What happens if it turns out to be false. */
  if_false: string;
}

/** Ordered: run index 0 first. */
export interface NextTest {
  name: string;
  description: string;
  /** Page-1 pitch for the first test. Falls back to `description`. */
  summary?: string;
  /** 1-based rank of the assumption in `riskiest_assumptions` this test checks. */
  assumption: number;
  proves: string;
  cost: string;
  time: string;
  kill_threshold: string;
  /** Shorter phrasing for page 1. Falls back to `kill_threshold`. */
  kill_threshold_short?: string;
}

export interface Source {
  basis: Basis;
  /** For found sources: who and what. For estimates: the method. */
  text: string;
  url?: string;
}

export interface TeardownReport {
  /** ISO date the report was produced, e.g. "2026-10-11". */
  date: string;
  /** ISO date the web sources were retrieved. */
  sources_retrieved: string;
  verdict: Verdict;
  idea: Idea;
  scorecard: Scorecard;
  /** One-paragraph dek at the top of pages 2, 3 and 4. */
  page_summaries: { market: string; business: string; next_steps: string };
  alternatives: Alternative[];
  /** Where the open position sits among the alternatives. */
  market_gap: Rich;
  demand_evidence: DemandSignal[];
  economics: Economics;
  distribution: Channel[];
  blockers: Blocker[];
  riskiest_assumptions: Assumption[];
  next_tests: NextTest[];
  sources: Source[];
}
