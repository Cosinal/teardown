import { beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import real from "./fixtures/research-response.json";
import { loadPrompt } from "../lib/engine/llm";
import { SOURCE_BUDGETS, buildPartialReport } from "../lib/engine/report";
import type { IdeaSpec } from "../lib/engine/intake";
import { RESEARCH_PROMPT, type SourceStore } from "../lib/engine/research";
import { ALTERNATIVES_RESEARCH_PROMPT, ALTERNATIVES_WRITE_PROMPT, parseAlternatives, researchAlternatives, writeAlternatives, type AlternativesSection } from "../lib/engine/sections/alternatives";
import { WriterError, mergeSources, parseJsonText, runSectionResearch, runWriter, writerContext, writerParams } from "../lib/engine/sections/common";
import { SECTIONS } from "../lib/engine/sections/config";
import { writeDemand, type DemandSection } from "../lib/engine/sections/demand";

const create = vi.fn();
vi.mock("../lib/engine/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine/llm")>()),
  anthropic: () => ({ messages: { create } }),
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

describe("buildPartialReport", () => {
  const report = buildPartialReport({ alternatives: section }, store, { date: "2026-10-12" });

  it("numbers the cited sources in order of use, with URLs from the store", () => {
    expect(report.sources.slice(0, 3)).toEqual([
      { basis: "found", text: "Page S27", url: "https://fundops.example/pricing" },
      { basis: "estimated", text: "Estimate. Analyst time per statement, from sample statements" },
      { basis: "found", text: "Page S1", url: "https://a.com/pricing" },
    ]);
    expect(report.alternatives![0].price).toEqual({ text: "Quote only", basis: "found", source: 1 });
    expect(report.alternatives![1]).toMatchObject({ workaround: true, price: { basis: "estimated", source: 2 } });
    expect(report.alternatives![1]).not.toHaveProperty("examples");
    expect(report.scorecard!.alternatives).toMatchObject({ rating: "mixed", basis: "found", source: 3 });
    expect(report.market_gap).toEqual([{ text: "Platforms are sold whole.", basis: "found", source: 1 }, "A single-task tool is open."]);
  });

  it("has only the sections given, and dates the sources", () => {
    expect(report.sources).toHaveLength(3);
    expect(report.demand_evidence).toBeUndefined();
    expect(report.verdict).toBeUndefined();
    expect(report.date).toBe("2026-10-12");
    expect(report.sources_retrieved).toBe("2026-10-11");
  });

  it("renders an uncited \"Not public\" price as plain text", () => {
    const np = { ...section, alternatives: [{ ...section.alternatives[0], price: plain("Not public") }, section.alternatives[1]] };
    expect(buildPartialReport({ alternatives: np }, store).alternatives![0].price).toBe("Not public");
  });

  it("rejects an unknown id and an uncited price", () => {
    expect(() => buildPartialReport({ alternatives: { ...section, scorecard: { ...section.scorecard, source: "S9" } } }, store)).toThrow(/unknown source id S9/);
    const uncited = { ...section, alternatives: [{ ...section.alternatives[0], price: plain("Quote only") }] };
    expect(() => buildPartialReport({ alternatives: uncited }, store)).toThrow(/alternatives\[0\]\.price: needs a source/);
  });
});

describe("parseAlternatives", () => {
  it("accepts a valid section", () => {
    expect(parseAlternatives(structuredClone(section), store)).toEqual(section);
  });

  it("rejects ids missing from the store, and source plus estimate together", () => {
    const bad = { ...section, market_gap: [found("Made up.", "S99")] };
    expect(() => parseAlternatives(bad, store)).toThrow(/market_gap\[0\]: S99 is not in the source list/);
    const both = { ...section, market_gap: [{ text: "x", source: "S1", estimate: "y" }] };
    expect(() => parseAlternatives(both, store)).toThrow(/not both/);
  });

  it("applies the report's length limits, naming the field", () => {
    const long = { ...section, alternatives: [{ ...section.alternatives[0], name: "A name that is far too long for the page" }] };
    expect(() => parseAlternatives(long, store)).toThrow(/alternatives\[0\]\.name: \d+ characters, at most 26/);
  });

  it("caps distinct sources at the budget and allows one workaround", () => {
    expect(() => parseAlternatives(section, store, 2)).toThrow(/cites 3 distinct.*limit is 2/);
    const two = { ...section, alternatives: [section.alternatives[1], section.alternatives[1]] };
    expect(() => parseAlternatives(two, store)).toThrow(/at most one workaround/);
  });

  it("keeps a \"Not public\" competitor only when its row cites a source", () => {
    const np = structuredClone(section);
    np.alternatives[0].price = plain("not public");
    expect(parseAlternatives(np, store).alternatives[0].price).toEqual(plain("Not public"));
    np.alternatives[0].weakness = [plain("Sold as a whole platform.")];
    expect(() => parseAlternatives(np, store)).toThrow(/"Not public" price needs a product row whose weakness cites a source/);
  });

  it("rejects JSON outside the schema", () => {
    expect(() => parseAlternatives({ alternatives: [] }, store)).toThrow();
  });
});

describe("parseJsonText", () => {
  it("reads a bare object, or one inside a code fence or prose", () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText('Here it is:\n```json\n{"a":{"b":[1]}}\n```')).toEqual({ a: { b: [1] } });
  });

  it("extracts the first object when extra text follows on a later line (the live error shape)", () => {
    const json = '{"a":1,"b":2}';
    const text = `${json}\n\n{"note":"counted characters"}`;
    // What the old first-`{` to last-`}` slice did: V8's exact demand_evidence error.
    expect(() => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)))
      .toThrow(/Unexpected non-whitespace character after JSON at position \d+ \(line 3 column 1\)/);
    expect(parseJsonText(text)).toEqual({ a: 1, b: 2 });
  });

  it("names the problem when there is no valid JSON", () => {
    expect(() => parseJsonText("Sorry, no.")).toThrow(/no JSON object/);
    expect(() => parseJsonText('{"a":}')).toThrow(/not valid JSON/);
  });
});

describe("writer context", () => {
  const spec = { name: "Test idea" } as IdeaSpec;
  const context = writerContext(spec, store, [{ label: "Shared research", text: "Notes [S1]" }, { label: "Empty", text: "" }]);

  it("holds the rules, spec, every source with its quote, and the notes", () => {
    expect(context).toContain("## Citing");
    expect(context).toContain('"name": "Test idea"');
    expect(context).toContain("[S27] Page S27\nURL: https://fundops.example/pricing\nQuoted: Quote from S27");
    expect(context).toContain("## Shared research\n\nNotes [S1]");
    expect(context).not.toContain("## Empty");
  });

  it("is the same cached first system block for every section; only the second block differs", () => {
    const a = writerParams({ model: "claude-sonnet-5-5", context, sectionPrompt: "Section A" }, []);
    const b = writerParams({ model: "claude-sonnet-5-5", context, sectionPrompt: "Section B" }, []);
    const [a0, a1] = a.system as Anthropic.TextBlockParam[];
    const [b0, b1] = b.system as Anthropic.TextBlockParam[];
    expect(JSON.stringify(a0)).toBe(JSON.stringify(b0));
    expect(a0.cache_control).toEqual({ type: "ephemeral" });
    expect([a1.text, b1.text]).toEqual(["Section A", "Section B"]);
    expect(JSON.stringify([a.output_config, a.model])).toBe(JSON.stringify([b.output_config, b.model]));
    expect(a).not.toHaveProperty("tools");
  });
});

describe("section stages (Anthropic mocked)", () => {
  const spec = { name: "Halifax mobile grooming" } as IdeaSpec;
  const usage = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0 } };
  const reply = (text: string) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage, content: [{ type: "text", text }] });

  beforeEach(() => {
    create.mockReset();
  });

  it("makes no API call for a section with 0 searches", async () => {
    const r = await runSectionResearch("alternatives", { spec, store, notes: "", searches: 0, model: "claude-sonnet-5-5", prompt: "alternatives-research.v2" });
    expect(create).not.toHaveBeenCalled();
    expect(r).toEqual({ sources: store, changed: [], notes: "", run: null, responses: [] });
  });

  it("merges the section's sources after the shared ones", async () => {
    create.mockResolvedValue(real.message as unknown as Anthropic.Message);
    const r = await researchAlternatives(spec, store, "Shared notes.");
    // The fixture's three quoted pages follow the shared store's S27.
    expect(r.sources.map((s) => s.id)).toEqual(["S1", "S2", "S27", "S28", "S29", "S30"]);
    expect(r.changed.map((s) => s.id)).toEqual(["S28", "S29", "S30"]);
    expect(r.notes).toContain("[S30]");
    expect(r.run).toMatchObject({ stage: "alternatives", step: "research", prompt_version: "alternatives-research.v2" });
    expect(create.mock.calls[0][0].tools[0]).toMatchObject({ max_uses: 6 });
  });

  it("writes from the shared context and retries an invalid write once", async () => {
    const bad = { ...section, scorecard: { ...section.scorecard, finding: "x".repeat(100) } };
    create.mockResolvedValueOnce(reply(JSON.stringify(bad))).mockResolvedValueOnce(reply(`\`\`\`json\n${JSON.stringify(section)}\n\`\`\``));
    const context = writerContext(spec, store, []);
    const r = await writeAlternatives(context, store);

    expect(r.value).toEqual(section);
    expect(create).toHaveBeenCalledTimes(2);
    const first = create.mock.calls[0][0];
    expect(first.system[0]).toEqual({ type: "text", text: context, cache_control: { type: "ephemeral" } });
    expect(first.system[1].text).toContain(`at most ${SOURCE_BUDGETS.alternatives} distinct`);
    expect(first).not.toHaveProperty("output_config.format");
    const retry = create.mock.calls[1][0].messages;
    expect(retry.at(-1).content).toMatch(/scorecard\.alternatives\.finding: 100 characters, at most 56/);
    expect(r.run).toMatchObject({ stage: "alternatives", step: "write", prompt_version: "writer-shared.v1+alternatives-write.v4" });
    expect(r.run.usage.input_tokens).toBe(2000);
  });

  it("accepts a Demand Evidence reply with extra JSON after a blank line, without retrying", async () => {
    const demand: DemandSection = {
      signals: [{ kind: "reviews", signal: "Groomer reviews", rating: "mixed", value: "94", detail: found("reviews for one Halifax groomer", "S2") }],
      evidence: "thin",
      scorecard: { rating: "weak", headline: "94", unit: "reviews", finding: "Thin evidence: one review count, no search data." },
    };
    const body = JSON.stringify(demand);
    create.mockResolvedValueOnce(reply(`${body}\n\n{"note":"I counted every field."}`));
    const r = await writeDemand(writerContext(spec, store, []), store);
    expect(r.value).toEqual(demand);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("uses the last JSON object when the first is a stub, without retrying", async () => {
    const demand: DemandSection = {
      signals: [{ kind: "reviews", signal: "Groomer reviews", rating: "mixed", value: "94", detail: found("reviews for one Halifax groomer", "S2") }],
      evidence: "thin",
      scorecard: { rating: "weak", headline: "94", unit: "reviews", finding: "Thin evidence: one review count, no search data." },
    };
    create.mockResolvedValueOnce(reply(`{"signals":[]}\n\n${JSON.stringify(demand)}`));
    const r = await writeDemand(writerContext(spec, store, []), store);
    expect(r.value).toEqual(demand);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("gives up after two retries, keeping what the calls cost", async () => {
    create.mockResolvedValue(reply("I could not find enough sources."));
    const err = await writeAlternatives("ctx", store).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriterError);
    expect((err as WriterError).message).toMatch(/alternatives: writer output invalid: no JSON object/);
    expect((err as WriterError).run).toMatchObject({ stage: "alternatives", step: "write", usage: { input_tokens: 3000 } });
    expect((err as WriterError).run.retries).toHaveLength(3);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("revises an earlier draft with fact-check's feedback", async () => {
    create.mockResolvedValue(reply(JSON.stringify({ ok: true })));
    const r = await runWriter("verdict", {
      model: "claude-sonnet-5-5", context: "ctx", finished: "FINISHED", sectionPrompt: "prompt", promptVersion: "verdict-write.v1",
      parse: (json) => json, revise: { draft: { ok: false }, feedback: "summary (partial): fix it" },
    });
    const call = create.mock.calls[0][0];
    expect(call.system.map((b: { text: string }) => b.text)).toEqual(["ctx", "FINISHED", "prompt"]);
    expect(call.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(call.messages.slice(1)).toEqual([
      { role: "assistant", content: JSON.stringify({ ok: false }) },
      { role: "user", content: "summary (partial): fix it" },
    ]);
    expect(r.run.step).toBe("revise");
  });
});

describe("competitor coverage prompts", () => {
  it("keeps the alternatives search cap at 6 and does not raise it", () => {
    expect(SECTIONS.alternatives.searches).toBe(6);
    expect(loadPrompt(ALTERNATIVES_RESEARCH_PROMPT)).toContain("{{max_searches}} at most");
    expect(loadPrompt(RESEARCH_PROMPT)).toContain("at most {{max_searches}} searches");
  });

  it("tells research to cover the category from several angles and keep named direct competitors", () => {
    const shared = loadPrompt(RESEARCH_PROMPT);
    const section = loadPrompt(ALTERNATIVES_RESEARCH_PROMPT);
    for (const text of [shared, section]) {
      expect(text).toMatch(/X alternatives|alternatives to/i);
      expect(text).toMatch(/Product Hunt|Indie Hackers|Reddit/);
      expect(text).toMatch(/own (pricing )?page|vendor's domain/i);
      expect(text).toMatch(/cheaper or closer-priced/);
    }
    expect(section).toMatch(/cannot be read as a different product/);
  });

  it("tells the writer to list named direct competitors and pick the closest substitute as the main rival", () => {
    expect(ALTERNATIVES_WRITE_PROMPT).toBe("alternatives-write.v4");
    const write = loadPrompt(ALTERNATIVES_WRITE_PROMPT);
    expect(write).toMatch(/main rival/);
    expect(write).toMatch(/closest direct substitute/);
    expect(write).toMatch(/Every credible named direct competitor/);
    expect(write).toMatch(/does not support a price or weakness for product B/);
  });
});
