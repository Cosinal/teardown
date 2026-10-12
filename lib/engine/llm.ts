import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
} as const;

export type Stage = "intake" | "research" | "alternatives" | "factcheck";

/**
 * Default model per stage. Intake runs on Opus: it costs 1-3 cents, and on
 * Sonnet its queries stopped naming known competitors, which research then
 * missed (tests/runs-summary.md). Research is search work and runs on Sonnet,
 * as do sections (their own searches plus a writer call). All section writers
 * must share one model and effort, or they stop sharing the cached sources
 * prefix (lib/engine/sections/writer.ts). Fact-check reads only the cited
 * excerpts, so it needs no shared cache and runs on Haiku.
 * Each stage function also takes a `model` option to override this.
 */
export const STAGE_MODELS: Record<Stage, string> = {
  intake: MODELS.opus,
  research: MODELS.sonnet,
  alternatives: MODELS.sonnet,
  factcheck: MODELS.haiku,
};

// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-11).
// Cache writes cost 1.25x input (5-minute TTL) or 2x (1-hour TTL).
// Web search is billed per search on top of tokens; its result tokens count as input.
// Haiku 5.5's rates apply to prompts up to 100K tokens (double above that); fact-check prompts stay far below.
const PRICES: Record<string, { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
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
  /** For a section: "research" (its own searches) or "write". */
  step?: "research" | "write";
  prompt_version: string;
  model: string;
  usage: TokenUsage;
  cost_usd: number;
  started_at: string;
  duration_ms: number;
  /** Fact-check only: the verdict and action for each cited claim. */
  claims?: ClaimCheck[];
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
