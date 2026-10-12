import { describe, expect, it } from "vitest";
import { ZERO_USAGE, addUsage, costUsd } from "../lib/engine/llm";
import type Anthropic from "@anthropic-ai/sdk";

describe("costUsd", () => {
  it("prices tokens and web searches for Opus 5.5", () => {
    // 1M input ($4) + 100k output ($2) + 200k cache read ($0.04) + 3 searches ($0.03)
    const u = { ...ZERO_USAGE, input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 200_000, web_search_requests: 3 };
    expect(costUsd("claude-opus-5-5", u)).toBe(6.07);
  });

  it("prices Sonnet 5.5 with cache writes by TTL", () => {
    // 1M input ($2) + 100k output ($1) + 400k 5m writes ($1) + 100k 1h writes ($0.40) + 1M cache read ($0.20) + 6 searches ($0.06)
    const u = {
      ...ZERO_USAGE, input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 500_000,
      cache_creation_1h_input_tokens: 100_000, cache_read_input_tokens: 1_000_000, web_search_requests: 6,
    };
    expect(costUsd("claude-sonnet-5-5", u)).toBe(4.66);
  });

  it("prices runs recorded before the 1h field existed at the 5-minute rate", () => {
    const old = { ...ZERO_USAGE, cache_creation_input_tokens: 1_000_000 } as Partial<typeof ZERO_USAGE>;
    delete old.cache_creation_1h_input_tokens;
    expect(costUsd("claude-sonnet-5-5", old as typeof ZERO_USAGE)).toBe(2.5);
  });

  it("prices Haiku 5.5, used for fact-check", () => {
    // 1M input ($0.10) + 1M output ($0.50) + 1M cache read ($0.01)
    const u = { ...ZERO_USAGE, input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
    expect(costUsd("claude-haiku-5-5", u)).toBe(0.61);
  });

  it("throws for a model without a price", () => {
    expect(() => costUsd("claude-unknown", ZERO_USAGE)).toThrow(/No price/);
  });
});

describe("addUsage", () => {
  it("sums responses and treats null fields as zero", () => {
    const a = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: 2, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } as Anthropic.Usage;
    const b = {
      input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 4, cache_read_input_tokens: null, server_tool_use: null,
      cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 3 },
    } as Anthropic.Usage;
    expect(addUsage(addUsage(ZERO_USAGE, a), b)).toEqual({
      input_tokens: 11, output_tokens: 6, cache_creation_input_tokens: 4, cache_creation_1h_input_tokens: 3, cache_read_input_tokens: 2, web_search_requests: 1,
    });
  });
});
