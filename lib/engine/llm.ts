import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
} as const;

export type Stage =
  | "intake" | "research" | "alternatives" | "demand_evidence" | "economics"
  | "idea" | "distribution" | "blockers" | "riskiest_assumptions" | "next_tests" | "verdict" | "factcheck";

/**
 * Default model per stage. Intake runs on Opus: it costs 1-3 cents, and on
 * Sonnet its queries stopped naming known competitors, which research then
 * missed (tests/runs-summary.md). Research is search work and runs on Sonnet,
 * as do sections (their own searches plus a writer call). All section writers,
 * including the six that write from the others,
 * must share one model and effort, or they stop sharing the cached sources
 * prefix (lib/engine/sections/common.ts). Fact-check reads only the cited
 * excerpts, so it needs no shared cache and runs on Haiku.
 * Each stage function also takes a `model` option to override this.
 */
export const STAGE_MODELS: Record<Stage, string> = {
  intake: MODELS.opus,
  research: MODELS.sonnet,
  alternatives: MODELS.sonnet,
  demand_evidence: MODELS.sonnet,
  economics: MODELS.sonnet,
  idea: MODELS.sonnet,
  distribution: MODELS.sonnet,
  blockers: MODELS.sonnet,
  riskiest_assumptions: MODELS.sonnet,
  next_tests: MODELS.sonnet,
  verdict: MODELS.sonnet,
  factcheck: MODELS.haiku,
};

// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-14).
// Cache writes cost 1.25x input (5-minute TTL) or 2x (1-hour TTL). Cache reads cost
// 0.05x input on Opus 5.5 and Sonnet 5.5, 0.1x on Haiku 5.5.
// Web search is billed per search on top of tokens; its result tokens count as input.
// Haiku 5.5's rates apply to prompts up to 100K tokens (double above that); fact-check prompts stay far below.
const PRICES: Record<string, { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
};
const WEB_SEARCH_USD = 10 / 1000;

/** The billable parts of an API response's `usage`. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  /** All cache writes. The part written with the 1-hour TTL is also in cache_creation_1h_input_tokens. */
  cache_creation_input_tokens: number;
  cache_creation_1h_input_tokens: number;
  cache_read_input_tokens: number;
  web_search_requests: number;
}

/** One stage's run, recorded on the teardown row. */
export interface StageRun {
  stage: Stage;
  /**
   * For a section: "research" (its own searches), "write", "revise" (a rewrite
   * after fact-check), or "warm" (writing the shared writer context to the cache, recorded on alternatives).
   */
  step?: "research" | "write" | "revise" | "warm";
  prompt_version: string;
  model: string;
  usage: TokenUsage;
  cost_usd: number;
  started_at: string;
  duration_ms: number;
  /** Fact-check only: the section it checked. */
  section?: string;
  /** Fact-check only: the verdict and action for each cited claim. */
  claims?: ClaimCheck[];
  /** Fact-check only: each page fetched to re-check a claim, once per URL. */
  pages?: { source: string; url: string; ok: boolean; cached: boolean; chars?: number; error?: string }[];
  /** Fact-check only: what the re-checks after the excerpt pass cost (included in cost_usd). */
  recheck_cost_usd?: number;
  /** Writers only: what length-repair calls cost (included in cost_usd). */
  repair_cost_usd?: number;
  /** Fact-check only: fields rewritten for consistency after claims changed. */
  repairs?: { field: string; before: string; after: string }[];
  /** Writers only: why each retry was needed. */
  retries?: string[];
}

/** One cited claim as fact-checked. */
export interface ClaimCheck {
  /** Where the claim sits, e.g. "alternatives[2].price". */
  id: string;
  text: string;
  source: string;
  verdict: "supported" | "partial" | "unsupported";
  reason: string;
  /** What was done to the section: kept, rewritten, re-tagged as an estimate, dropped, or left as is when no fix fit. */
  action: "kept" | "rewritten" | "estimated" | "dropped" | "unresolved";
  /** The claim after the action, when it changed. */
  result?: string;
  /** What the verdict rests on: the search excerpt, or the fetched page. */
  basis?: "excerpt" | "page";
  /** The verdict against the excerpt alone, when the page changed it. */
  excerpt_verdict?: "supported" | "partial" | "unsupported";
  /** The passage on the page that supports the claim or its rewrite. */
  quote?: string;
  /** Why the page couldn't be used, when it was needed. */
  fetch_error?: string;
  /** True when the model was not asked because the excerpt/page was clearly about something else. */
  skipped?: boolean;
}

export const ZERO_USAGE: TokenUsage = {
  input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_creation_1h_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0,
};

export function addUsage(total: TokenUsage, u: Anthropic.Usage): TokenUsage {
  return {
    input_tokens: total.input_tokens + u.input_tokens,
    output_tokens: total.output_tokens + u.output_tokens,
    cache_creation_input_tokens: total.cache_creation_input_tokens + (u.cache_creation_input_tokens ?? 0),
    // Stage runs recorded before this field existed lack it.
    cache_creation_1h_input_tokens: (total.cache_creation_1h_input_tokens ?? 0) + (u.cache_creation?.ephemeral_1h_input_tokens ?? 0),
    cache_read_input_tokens: total.cache_read_input_tokens + (u.cache_read_input_tokens ?? 0),
    web_search_requests: total.web_search_requests + (u.server_tool_use?.web_search_requests ?? 0),
  };
}

/** Adds two usage totals, e.g. the totals of two calls. */
export function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_creation_1h_input_tokens: (a.cache_creation_1h_input_tokens ?? 0) + (b.cache_creation_1h_input_tokens ?? 0),
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    web_search_requests: a.web_search_requests + b.web_search_requests,
  };
}

/** Cost in USD, rounded to 1/10,000 of a dollar. Cache writes are priced by TTL. */
export function costUsd(model: string, u: TokenUsage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for model ${model}`);
  const write1h = u.cache_creation_1h_input_tokens ?? 0;
  const tokens =
    u.input_tokens * p.input +
    u.output_tokens * p.output +
    (u.cache_creation_input_tokens - write1h) * p.cacheWrite5m +
    write1h * p.cacheWrite1h +
    u.cache_read_input_tokens * p.cacheRead;
  return Math.round((tokens / 1e6 + u.web_search_requests * WEB_SEARCH_USD) * 1e4) / 1e4;
}

/**
 * Share of input tokens read from cache: reads / (uncached input + cache
 * writes + reads). The same measure as the console's cache hit rate.
 */
export function cacheHitRate(u: TokenUsage): number {
  const total = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  return total ? u.cache_read_input_tokens / total : 0;
}

/** Cache hit rate per stage (and step) and for the whole run, with each line's cost. */
export function cacheReport(runs: StageRun[]): { stage: string; runs: number; hit_rate: number; usage: TokenUsage; cost_usd: number }[] {
  const rows = new Map<string, { stage: string; runs: number; usage: TokenUsage; cost_usd: number }>();
  const add = (stage: string, r: StageRun) => {
    const row = rows.get(stage) ?? { stage, runs: 0, usage: ZERO_USAGE, cost_usd: 0 };
    rows.set(stage, { stage, runs: row.runs + 1, usage: sumUsage(row.usage, r.usage), cost_usd: row.cost_usd + r.cost_usd });
  };
  for (const r of runs) add(r.step ? `${r.stage}:${r.step}` : r.stage, r);
  for (const r of runs) add("total", r);
  return [...rows.values()].map((row) => ({ ...row, hit_rate: cacheHitRate(row.usage), cost_usd: Math.round(row.cost_usd * 1e4) / 1e4 }));
}

/** Thrown when a run passes its hard deadline: in-flight calls are aborted and the run fails. */
export class DeadlineError extends Error {}

/**
 * A run's time limits, measured from when it starts. The whole engine runs in
 * one Vercel function capped at 300 s (maxDuration). Past `softMs` the
 * pipeline skips optional work (fact-check revisions) and finishes with what
 * it has. At `hardMs` every call in flight is aborted, so the run fails and is
 * refunded by startRun instead of being killed mid-step, with time left for that.
 */
export class Budget {
  readonly started: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(readonly softMs = 240_000, readonly hardMs = 275_000, private readonly now: () => number = Date.now) {
    this.started = now();
    this.timer = setTimeout(() => this.controller.abort(new DeadlineError(this.message())), hardMs);
  }

  elapsed() {
    return this.now() - this.started;
  }

  /** Past the soft limit: skip anything optional. */
  get overSoft() {
    return this.elapsed() >= this.softMs;
  }

  get expired() {
    return this.controller.signal.aborted || this.elapsed() >= this.hardMs;
  }

  /** Aborted at the hard deadline. */
  get signal() {
    return this.controller.signal;
  }

  message() {
    return `Run passed its ${Math.round(this.hardMs / 1000)} s time budget`;
  }

  /** Throws a DeadlineError once the hard deadline has passed. */
  check() {
    if (this.expired) throw new DeadlineError(this.message());
  }

  /** Stops the deadline timer. Call when the run ends. */
  done() {
    clearTimeout(this.timer);
  }
}

// The current run's budget, per async context, so concurrent runs on one instance never share one.
const budgets = new AsyncLocalStorage<Budget>();

/** Runs `fn` with `budget` as the budget every API call inside it uses. */
export function withBudget<T>(budget: Budget, fn: () => Promise<T>): Promise<T> {
  return budgets.run(budget, fn);
}

export function currentBudget(): Budget | undefined {
  return budgets.getStore();
}

/**
 * Cap on one attempt of a non-search API call. The SDK retries a timed-out
 * attempt (twice by default), so a hung call costs 60 s and then usually
 * succeeds on the next try; the run's hard deadline bounds the total. The
 * slowest normal writer call measured is about 25 s; a few calls took
 * 70-90 s (stage runs of 2026-10-13). Search calls get no cap of their own: a
 * timed-out search would be re-run and billed again.
 */
export const CALL_TIMEOUT_MS = 60_000;

/**
 * Request options for one API call: aborted at the run's hard deadline, and
 * timed out after `capMs` (or when the budget runs out, if sooner).
 */
export function requestOptions(capMs: number | null = CALL_TIMEOUT_MS): Anthropic.RequestOptions {
  const budget = currentBudget();
  if (!budget) return capMs === null ? {} : { timeout: capMs };
  budget.check();
  const left = Math.max(1, budget.hardMs - budget.elapsed());
  return { signal: budget.signal, timeout: capMs === null ? left : Math.min(capMs, left) };
}

let client: Anthropic | undefined;

// Created lazily so importing the engine doesn't require ANTHROPIC_API_KEY.
export function anthropic() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic();
  }
  return client;
}

/** Reads lib/engine/prompts/<name>.md. The file name is the prompt version. */
export function loadPrompt(name: string): string {
  return readFileSync(join(process.cwd(), "lib/engine/prompts", `${name}.md`), "utf8");
}

/** Throws unless the response finished normally. */
export function assertFinished(msg: Anthropic.Message, stage: string) {
  if (msg.stop_reason === "refusal") throw new Error(`${stage}: model refused (${msg.stop_details?.category ?? "no category"})`);
  if (msg.stop_reason === "max_tokens") throw new Error(`${stage}: hit max_tokens`);
}
