import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkClaimList, type CheckClaim } from "../lib/engine/factcheck";
import { memoryPageCache } from "../lib/engine/fetch";
import type { IdeaSpec } from "../lib/engine/intake";
import { ZERO_USAGE, cacheHitRate } from "../lib/engine/llm";
import type { Drafts } from "../lib/engine/report";
import type { SourceStore } from "../lib/engine/research";
import type { AlternativesSection } from "../lib/engine/sections/alternatives";
import { writeAlternatives } from "../lib/engine/sections/alternatives";
import { writeAssumptions } from "../lib/engine/sections/assumptions";
import { writeBlockers } from "../lib/engine/sections/blockers";
import { WriterError, writerContext } from "../lib/engine/sections/common";
import { writeDemand, type DemandSection } from "../lib/engine/sections/demand";
import { writeDistribution } from "../lib/engine/sections/distribution";
import { writeEconomics, type EconomicsSection } from "../lib/engine/sections/economics";
import { writeIdea } from "../lib/engine/sections/idea";
import { laterContext } from "../lib/engine/sections/later";
import { writeTests } from "../lib/engine/sections/tests";
import { writeVerdict } from "../lib/engine/sections/verdict";

// Prompt caching is a prefix match: tools, then system, then messages, with
// model, thinking and output_config (effort and format) part of the key. These
// tests capture every request and check that what comes before each cache
// breakpoint is byte-identical wherever it should be shared.

const create = vi.fn();
const parse = vi.fn();
vi.mock("../lib/engine/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine/llm")>()),
  anthropic: () => ({ messages: { create, parse } }),
}));

type Block = { type: string; text: string; cache_control?: { type: string } };
type Params = {
  model: string; thinking?: unknown; output_config?: unknown; tools?: unknown;
  system: string | Block[]; messages: { role: string; content: unknown }[];
};

/** Everything up to and including the system block holding the `n`-th breakpoint (0-based), as the bytes that key the cache. */
function prefix(p: Params, n: number): string {
  const system = p.system as Block[];
  const marks = system.flatMap((b, i) => (b.cache_control ? [i] : []));
  expect(marks.length).toBeGreaterThan(n);
  const { model, thinking, output_config, tools } = p;
  return JSON.stringify({ model, thinking, output_config, tools, system: system.slice(0, marks[n] + 1) });
}

/** What comes after the last breakpoint: the uncached, per-call part. */
function suffix(p: Params): string {
  const system = p.system as Block[];
  const last = system.map((b) => !!b.cache_control).lastIndexOf(true);
  return JSON.stringify({ system: system.slice(last + 1), messages: p.messages });
}

const calls = (fn: typeof create) => fn.mock.calls.map((c) => c[0] as Params);

const src = (id: string) => ({ id, url: `https://${id.toLowerCase()}.example`, title: `Page ${id}`, retrieved_at: "2026-10-12T00:00:00.000Z", excerpt: `Quote from ${id}` });
const store: SourceStore = ["S1", "S2", "S3", "S4"].map(src);
const found = (text: string, source: string) => ({ text, source, estimate: null });
const est = (text: string, estimate: string) => ({ text, source: null, estimate });
const plain = (text: string) => ({ text, source: null, estimate: null });

const spec = {
  name: "Halifax mobile dog grooming",
  customer: "Dog owners in Halifax",
  problem: "Grooming without driving to a salon",
  revenue_model: { price: "$80 per groom", billing: "one_time", notes: "Flat price." },
  category: "Mobile dog grooming",
  geography: { scope: "local", places: ["Halifax"] },
  search_queries: [],
  ambiguities: [],
} as IdeaSpec;

const alternatives: AlternativesSection = {
  alternatives: [{
    name: "Salons", examples: "PetSmart, local salons", workaround: false, what_it_does: "Groom dogs in store.",
    price: found("$70-$120 a groom", "S1"), weakness: [plain("The owner drives and waits.")],
  }],
  market_gap: [plain("Nobody local comes to the door.")],
  scorecard: { rating: "mixed", key_figure: { value: "1", unit: "alternatives" }, finding: "Salons only; no one comes to the door.", source: "S1", estimate: null },
};
const demand: DemandSection = {
  signals: [{ kind: "reviews", signal: "Groomer reviews", rating: "mixed", value: "94", detail: found("reviews for one Halifax groomer", "S2") }],
  evidence: "thin",
  scorecard: { rating: "weak", headline: "94", unit: "reviews", finding: "Thin evidence: one review count, no search data." },
};
const economics: EconomicsSection = {
  per: "groom",
  currency: "CAD",
  price: { amount: 80, note: [est("The founder's price", "The founder's own price, from the idea")] },
  unit_cost: { amount: 62, note: [est("2.5 h labour plus supplies", "Hours per visit × groomer wage, plus supplies")] },
  fixed_costs: { amount: 2000, note: [est("Van, insurance and software", "Van lease plus insurance and software")] },
  break_even_unit: "grooms a month",
  scorecard: { rating: "weak", finding: "Thin margin; break-even needs a full calendar." },
};

const context = writerContext(spec, store, [{ label: "Shared research", text: "Salons dominate [S1]." }]);
const base: Partial<Drafts> = { alternatives, demand_evidence: demand, economics };

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
/** A writer reply that never parses, so each writer uses every attempt (first call plus retries). */
const badReply = () => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage, content: [{ type: "text", text: "not json" }] });

/** Runs a writer to failure and returns its requests: the first call, then each retry. */
async function writerCalls(write: () => Promise<unknown>): Promise<Params[]> {
  // Copied when sent: the writer appends retries to the same messages array.
  const sent: Params[] = [];
  create.mockReset();
  create.mockImplementation(async (p: Params) => {
    sent.push(structuredClone(p));
    return badReply();
  });
  await expect(write()).rejects.toBeInstanceOf(WriterError);
  return sent;
}

describe("writer cache prefix", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("is byte-identical up to the shared context for all nine writers, their retries and revisions", async () => {
    const round1 = laterContext(spec, store, base, context);
    const round2 = laterContext(spec, store, { ...base, demand_evidence: undefined }, context);
    const revise = { draft: { headline: "Old draft" }, feedback: "Fix the headline." };
    const runs = {
      alternatives: await writerCalls(() => writeAlternatives(context, store)),
      demand_evidence: await writerCalls(() => writeDemand(context, store)),
      economics: await writerCalls(() => writeEconomics(context, store)),
      idea: await writerCalls(() => writeIdea(round1)),
      idea_revise: await writerCalls(() => writeIdea(round1, {}, revise)),
      distribution: await writerCalls(() => writeDistribution(round1)),
      blockers: await writerCalls(() => writeBlockers(round1)),
      riskiest_assumptions: await writerCalls(() => writeAssumptions(round2)),
      next_tests: await writerCalls(() => writeTests(round2)),
      verdict: await writerCalls(() => writeVerdict(round2)),
      verdict_revise: await writerCalls(() => writeVerdict(round2, {}, revise)),
    };
    const all = Object.values(runs).flat();
    // First call plus three retries each.
    for (const r of Object.values(runs)) expect(r).toHaveLength(4);
    const first = prefix(all[0], 0);
    for (const p of all) expect(prefix(p, 0)).toBe(first);
    // The shared context is exactly the cached block; section instructions come after it.
    expect((all[0].system as Block[])[0].text).toBe(context);
  });

  it("is byte-identical up to the finished sections for writers in the same round", async () => {
    const round1 = laterContext(spec, store, base, context);
    const round2 = laterContext(spec, store, { ...base, demand_evidence: undefined }, context);
    const r1 = [
      ...await writerCalls(() => writeIdea(round1)),
      ...await writerCalls(() => writeDistribution(round1)),
      ...await writerCalls(() => writeBlockers(round1)),
      ...await writerCalls(() => writeIdea(round1, {}, { draft: {}, feedback: "Fix it." })),
    ];
    for (const p of r1) expect(prefix(p, 1)).toBe(prefix(r1[0], 1));
    const r2 = await writerCalls(() => writeTests(round2));
    expect(prefix(r2[0], 1)).not.toBe(prefix(r1[0], 1));
    expect(prefix(r2[0], 0)).toBe(prefix(r1[0], 0));
  });

  it("only appends messages on a retry, after the breakpoints", async () => {
    const ps = await writerCalls(() => writeDemand(context, store));
    for (const [i, p] of ps.entries()) {
      expect(JSON.stringify(p.system)).toBe(JSON.stringify(ps[0].system));
      // Each retry adds the failed reply and the validation error to the end.
      expect(p.messages).toHaveLength(1 + 2 * i);
      expect(p.messages.slice(0, ps[0].messages.length)).toEqual(ps[0].messages);
    }
    expect(suffix(ps[3])).toContain("That JSON failed validation");
    expect(prefix(ps[3], 0)).not.toContain("That JSON failed validation");
  });

  it("uses at most four breakpoints", async () => {
    const ps = await writerCalls(() => writeVerdict(laterContext(spec, store, base, context)));
    const marks = (ps[0].system as Block[]).filter((b) => b.cache_control).length;
    expect(marks).toBeLessThanOrEqual(4);
  });
});

describe("fact-check cache prefix", () => {
  const claim = (id: string, source: string): CheckClaim => ({ id, text: `Claim ${id}`, source, context: `Row for ${id}` });
  const verdict = (v: "supported" | "partial") => ({
    model: "claude-haiku-5-5", stop_reason: "end_turn", usage,
    parsed_output: { verdict: v, reason: "because", quote: v === "supported" ? "Quote from S1" : null, action: "keep", text: null, method: null },
  });

  beforeEach(() => {
    parse.mockReset();
  });

  it("is byte-identical across claims, page re-checks, retries, sections and internal checks", async () => {
    parse
      .mockResolvedValueOnce(verdict("supported"))
      // Claim b: no parsed output first, so the judge retries.
      .mockResolvedValueOnce({ ...verdict("supported"), parsed_output: null })
      .mockResolvedValueOnce(verdict("partial"))
      .mockResolvedValue(verdict("supported"));
    const fetcher = vi.fn(async () => ({ ok: true as const, text: "Full page. Quote from S2 and more." }));
    // One section, with a page re-check and a retry.
    await checkClaimList([claim("a", "S1"), claim("b", "S2")], store, { fetcher, pages: memoryPageCache() });
    // Another section.
    await checkClaimList([claim("c", "S3"), claim("d", "S4")], store, { fetcher, pages: memoryPageCache() });
    // An internal check: no pages, the report as an extra source.
    await checkClaimList([claim("e", "R1")], [...store, { ...src("R1"), url: "report://draft" }], { fetch: false });

    const ps = calls(parse);
    const pageCalls = ps.filter((p) => JSON.stringify(p.messages).includes("page_text"));
    expect(pageCalls.length).toBeGreaterThan(0);
    expect(ps.length).toBeGreaterThanOrEqual(7);
    for (const p of ps) expect(prefix(p, 0)).toBe(prefix(ps[0], 0));
    // The claim (and page) is after the breakpoint, never in the cached part.
    for (const p of ps) {
      expect(prefix(p, 0)).not.toContain("Claim ");
      expect(suffix(p)).toContain("Claim ");
    }
  });

  it("lets the first excerpt call finish before the rest start, so they read its cache", async () => {
    const pending: (() => void)[] = [];
    parse.mockImplementation(() => new Promise((resolve) => pending.push(() => resolve(verdict("supported")))));
    const done = checkClaimList(["a", "b", "c", "d"].map((id) => claim(id, "S1")), store, { fetch: false });
    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(parse).toHaveBeenCalledTimes(1);
    pending[0]();
    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(4));
    pending.slice(1).forEach((r) => r());
    const out = await done;
    expect(out.results.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("cacheHitRate", () => {
  it("is reads over all input tokens", () => {
    expect(cacheHitRate({ ...ZERO_USAGE, input_tokens: 100, cache_creation_input_tokens: 300, cache_read_input_tokens: 600 })).toBe(0.6);
    expect(cacheHitRate(ZERO_USAGE)).toBe(0);
  });
});

describe("cacheReport", () => {
  it("groups runs by stage and step, with the total last", async () => {
    const { cacheReport } = await import("../lib/engine/llm");
    const run = (stage: "factcheck" | "idea", step: "write" | undefined, read: number) => ({
      stage, step, prompt_version: "v1", model: "claude-haiku-5-5", cost_usd: 0.01, started_at: "", duration_ms: 0,
      usage: { ...ZERO_USAGE, input_tokens: 100, cache_read_input_tokens: read },
    });
    const rows = cacheReport([run("factcheck", undefined, 100), run("idea", "write", 300), run("factcheck", undefined, 100)]);
    expect(rows.map((r) => [r.stage, r.runs, r.hit_rate])).toEqual([["factcheck", 2, 0.5], ["idea:write", 1, 0.75], ["total", 3, 0.625]]);
    expect(rows.at(-1)?.cost_usd).toBe(0.03);
  });
});
