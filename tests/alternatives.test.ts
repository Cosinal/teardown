import { beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import real from "./fixtures/research-response.json";
import { SAMPLE_REPORT, buildReport, liveSourceBudget } from "../lib/engine/report";
import type { IdeaSpec } from "../lib/engine/intake";
import type { SourceStore } from "../lib/engine/research";
import { mergeSources, parseAlternatives, runAlternatives, type AlternativesSection } from "../lib/engine/sections/alternatives";

const create = vi.fn();
const parse = vi.fn();
vi.mock("../lib/engine/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine/llm")>()),
  anthropic: () => ({ messages: { create, parse } }),
}));

const src = (id: string, url: string, excerpt = `Quote from ${id}`) => ({ id, url, title: `Page ${id}`, retrieved_at: "2026-10-11T12:00:00.000Z", excerpt });

// A store with gaps in the middle, so the section can cite a high id.
const store: SourceStore = [src("S1", "https://a.com/pricing"), src("S2", "https://b.com"), src("S27", "https://fundops.example/pricing")];

const plain = (text: string) => ({ text, source: null, estimate: null });
const found = (text: string, source: string) => ({ text, source, estimate: null });
const est = (text: string, estimate: string) => ({ text, source: null, estimate });

const section: AlternativesSection = {
  alternatives: [
    {
      name: "Fund-ops platforms", examples: "Arcesium, FundGuard", workaround: false,
      what_it_does: "Run the fund back office, reconciliation included.",
      price: found("Quote only", "S27"), weakness: [found("Sold as a whole platform,", "S27"), plain("not a single task.")],
    },
    {
      name: "Doing it by hand", examples: null, workaround: true,
      what_it_does: "Analysts key statements into spreadsheets.",
      price: est("2 to 4 hours a statement", "Analyst time per statement, from sample statements"), weakness: [plain("Slow and error-prone.")],
    },
  ],
  market_gap: [found("Platforms are sold whole.", "S27"), plain("A single-task tool is open.")],
  scorecard: { rating: "mixed", key_figure: { value: "2", unit: "alternatives" }, finding: "Whole platforms above, spreadsheets below.", source: "S1", estimate: null },
};

describe("mergeSources", () => {
  const added: SourceStore = [
    src("S1", "https://B.com/#top", "New quote"),
    src("S2", "https://new.com/x", "Fresh"),
    src("S3", "https://a.com/pricing/", "Quote from S1"),
  ];
  const { sources, changed } = mergeSources(store, added);

  it("keeps existing ids and numbers new pages after the highest id", () => {
    expect(sources.map((s) => [s.id, s.url])).toEqual([
      ["S1", "https://a.com/pricing"], ["S2", "https://b.com"], ["S27", "https://fundops.example/pricing"], ["S28", "https://new.com/x"],
    ]);
  });

  it("adds new quotes to a page already in the store and reports what changed", () => {
    expect(sources[1].excerpt).toBe("Quote from S2 … New quote");
    expect(sources[0].excerpt).toBe("Quote from S1");
    expect(changed.map((s) => s.id)).toEqual(["S2", "S28"]);
  });

  it("does not modify the input store", () => {
    expect(store[1].excerpt).toBe("Quote from S2");
  });

  it("starts at S1 for an empty store", () => {
    expect(mergeSources([], [src("S5", "https://x.com")]).sources[0].id).toBe("S1");
  });
});

describe("buildReport", () => {
  const report = buildReport(section, store, { date: "2026-10-12" });

  it("numbers the cited sources in order of use, with URLs from the store", () => {
    expect(report.sources.slice(0, 3)).toEqual([
      { basis: "found", text: "Page S27", url: "https://fundops.example/pricing" },
      { basis: "estimated", text: "Estimate. Analyst time per statement, from sample statements" },
      { basis: "found", text: "Page S1", url: "https://a.com/pricing" },
    ]);
    expect(report.alternatives[0].price).toEqual({ text: "Quote only", basis: "found", source: 1 });
    expect(report.alternatives[1]).toMatchObject({ workaround: true, price: { basis: "estimated", source: 2 } });
    expect(report.alternatives[1]).not.toHaveProperty("examples");
    expect(report.scorecard.alternatives).toMatchObject({ rating: "mixed", basis: "found", source: 3 });
    expect(report.market_gap).toEqual([{ text: "Platforms are sold whole.", basis: "found", source: 1 }, "A single-task tool is open."]);
  });

  it("keeps the sample's other sections, pointing at the same sources after renumbering", () => {
    const d = report.demand_evidence[0].detail;
    const s = SAMPLE_REPORT.demand_evidence[0].detail;
    expect(report.sources[d.source - 1]).toEqual(SAMPLE_REPORT.sources[s.source - 1]);
    expect(report.sources).toHaveLength(3 + (20 - liveSourceBudget()));
    expect(report.date).toBe("2026-10-12");
    expect(report.sources_retrieved).toBe("2026-10-11");
  });

  it("rejects an unknown id and an uncited price", () => {
    expect(() => buildReport({ ...section, scorecard: { ...section.scorecard, source: "S9" } }, store)).toThrow(/unknown source id S9/);
    const uncited = { ...section, alternatives: [{ ...section.alternatives[0], price: plain("Quote only") }] };
    expect(() => buildReport(uncited, store)).toThrow(/alternatives\[0\]\.price: needs a source/);
  });
});

describe("parseAlternatives", () => {
  it("accepts a valid section", () => {
    expect(parseAlternatives(section, store)).toEqual(section);
  });

  it("rejects ids missing from the store, and source plus estimate together", () => {
    const bad = { ...section, market_gap: [found("Made up.", "S99")] };
    expect(() => parseAlternatives(bad, store)).toThrow(/market_gap\[0\]: S99 is not in the source list/);
    const both = { ...section, market_gap: [{ text: "x", source: "S1", estimate: "y" }] };
    expect(() => parseAlternatives(both, store)).toThrow(/not both/);
  });

  it("applies the report's length limits, naming the field", () => {
    const long = { ...section, alternatives: [{ ...section.alternatives[0], name: "A name that is far too long for the page" }] };
    expect(() => parseAlternatives(long, store)).toThrow(/alternatives\[0\]\.name: longer than 26/);
  });

  it("caps distinct sources at the budget and allows one workaround", () => {
    expect(() => parseAlternatives(section, store, 2)).toThrow(/cites 3 distinct.*limit is 2/);
    const two = { ...section, alternatives: [section.alternatives[1], section.alternatives[1]] };
    expect(() => parseAlternatives(two, store)).toThrow(/at most one workaround/);
  });

  it("rejects JSON outside the schema", () => {
    expect(() => parseAlternatives({ alternatives: [] }, store)).toThrow();
  });
});

describe("runAlternatives (Anthropic mocked)", () => {
  const spec = { name: "Halifax mobile grooming" } as IdeaSpec;
  const usage = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0 } };
  const research = real.message as unknown as Anthropic.Message;
  const reply = (parsed: unknown) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage, parsed_output: parsed, content: [] });

  beforeEach(() => {
    create.mockReset().mockResolvedValue(research);
    parse.mockReset();
  });

  it("merges the section's sources after the shared ones and retries an invalid write once", async () => {
    const bad = { ...section, scorecard: { ...section.scorecard, finding: "x".repeat(80) } };
    parse.mockResolvedValueOnce(reply(bad)).mockResolvedValueOnce(reply(section));
    const r = await runAlternatives(spec, store, "Shared notes.");

    // The fixture's three quoted pages follow the shared store's S27.
    expect(r.sources.map((s) => s.id)).toEqual(["S1", "S2", "S27", "S28", "S29", "S30"]);
    expect(r.changed.map((s) => s.id)).toEqual(["S28", "S29", "S30"]);
    expect(r.notes).toContain("[S30]");
    expect(r.section).toEqual(section);

    expect(parse).toHaveBeenCalledTimes(2);
    const retry = parse.mock.calls[1][0].messages;
    expect(retry.at(-1).content).toMatch(/scorecard\.alternatives\.finding: longer than 56/);
    const request = parse.mock.calls[0][0];
    expect(request.messages[0].content).toContain("[S30]");
    expect(request.system).toContain(`at most ${liveSourceBudget()} distinct`);

    expect(r.run).toMatchObject({ stage: "alternatives", prompt_version: "alternatives-research.v1+alternatives-write.v1" });
    // The research fixture's usage (Opus-sized, 10 searches) plus two writer calls, priced at Sonnet rates.
    expect(r.run.usage.web_search_requests).toBe(10);
    expect(r.run.usage.input_tokens).toBe(206014 + 2000);
  });

  it("gives up after the retry", async () => {
    parse.mockResolvedValue(reply({ ...section, market_gap: [found("x", "S99")] }));
    await expect(runAlternatives(spec, store, "")).rejects.toThrow(/writer output invalid: market_gap\[0\]: S99/);
    expect(parse).toHaveBeenCalledTimes(2);
  });
});
