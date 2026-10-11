import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5-5";

// USD, from https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-11).
// Web search is billed per search on top of tokens; its result tokens count as input.
const PRICES: Record<string, { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
};
const WEB_SEARCH_USD = 10 / 1000;

/** The billable parts of an API response's `usage`. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_search_requests: number;
}

/** One stage's run, recorded on the teardown row. */
export interface StageRun {
  stage: "intake" | "research";
  prompt_version: string;
  model: string;
  usage: TokenUsage;
  cost_usd: number;
  started_at: string;
  duration_ms: number;
}

export const ZERO_USAGE: TokenUsage = {
  input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0,
};

export function addUsage(total: TokenUsage, u: Anthropic.Usage): TokenUsage {
  return {
    input_tokens: total.input_tokens + u.input_tokens,
    output_tokens: total.output_tokens + u.output_tokens,
    cache_creation_input_tokens: total.cache_creation_input_tokens + (u.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: total.cache_read_input_tokens + (u.cache_read_input_tokens ?? 0),
    web_search_requests: total.web_search_requests + (u.server_tool_use?.web_search_requests ?? 0),
  };
}

/** Cost in USD, rounded to 1/10,000 of a dollar. Cache writes are priced at the 5-minute rate (the API default). */
export function costUsd(model: string, u: TokenUsage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for model ${model}`);
  const tokens =
    u.input_tokens * p.input +
    u.output_tokens * p.output +
    u.cache_creation_input_tokens * p.cacheWrite5m +
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
