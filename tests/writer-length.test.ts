import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPrompt } from "../lib/engine/llm";
import type { IdeaSpec } from "../lib/engine/intake";
import type { SourceStore } from "../lib/engine/research";
import type { AlternativesSection } from "../lib/engine/sections/alternatives";
import type { AssumptionsSection } from "../lib/engine/sections/assumptions";
import { parseBlockers, writeBlockers, type BlockersSection } from "../lib/engine/sections/blockers";
import {
  LENGTH_REPAIR_ATTEMPTS, WRITE_ATTEMPTS, WriterError, applyLengthOverrun, lengthOverrun,
  runWriter, truncateAtWord,
} from "../lib/engine/sections/common";
import type { DemandSection } from "../lib/engine/sections/demand";
import type { DistributionSection } from "../lib/engine/sections/distribution";
import type { EconomicsSection } from "../lib/engine/sections/economics";
import { parseIdea, writeIdea, type IdeaSection } from "../lib/engine/sections/idea";
import { laterContext } from "../lib/engine/sections/later";
import { parseTests, writeTests, type TestsSection } from "../lib/engine/sections/tests";
import { parseVerdict, writeVerdict, type VerdictSection } from "../lib/engine/sections/verdict";
import type { Drafts } from "../lib/engine/report";
import { LEN } from "../lib/engine/validate";

const create = vi.fn();
vi.mock("../lib/engine/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine/llm")>()),
  anthropic: () => ({ messages: { create } }),
}));

type Params = { max_tokens: number; system: { text: string }[]; messages: { role: string; content: string }[] };

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const reply = (text: string) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage, content: [{ type: "text", text }] });

const src = (id: string) => ({ id, url: `https://${id.toLowerCase()}.example`, title: `Page ${id}`, retrieved_at: "2026-10-12T00:00:00.000Z", excerpt: `Quote from ${id}` });
const store: SourceStore = ["S1", "S2", "S3", "S4", "S5", "S6"].map(src);
const found = (text: string, source: string) => ({ text, source, estimate: null });
const est = (text: string, estimate: string) => ({ text, source: null, estimate });
const plain = (text: string) => ({ text, source: null, estimate: null });

const spec = {
  name: "Halifax mobile dog grooming", customer: "Dog owners in Halifax", problem: "Grooming without driving to a salon",
  revenue_model: { price: "$80 per groom", billing: "one_time", notes: "Flat price." },
  category: "Mobile dog grooming", geography: { scope: "local", places: ["Halifax"] }, search_queries: [], ambiguities: [],
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
  per: "groom", currency: "CAD",
  price: { amount: 80, note: [est("The founder's price", "The founder's own price, from the idea")] },
  unit_cost: { amount: 62, note: [est("2.5 h labour plus supplies", "Hours per visit × groomer wage, plus supplies")] },
  fixed_costs: { amount: 2000, note: [est("Van, insurance and software", "Van lease plus insurance and software")] },
  break_even_unit: "grooms a month",
  scorecard: { rating: "weak", finding: "Thin margin; break-even needs a full calendar." },
};
const distribution: DistributionSection = {
  channels: [
    { name: "Neighbourhood Facebook groups", examples: "Halifax dog owner groups", rating: "strong", cac: { low: 5, high: 15, source: null, estimate: "Founder hours per post × wage ÷ bookings" }, reason: [plain("Owners ask for groomers there.")] },
  ],
  scorecard: { rating: "strong", finding: "Free groups fit what a groom keeps." },
};
const blockers: BlockersSection = {
  blockers: [{ type: "Licensing", risk: "Mobile business licence", severity: "high", detail: found("Halifax requires a mobile vendor licence.", "S4") }],
  scorecard: { rating: "mixed", finding: "A licence is needed before the first groom." },
};
const idea: IdeaSection = {
  name: spec.name, headline: "Mobile dog grooming at the owner's door", customer: "Dog owners in Halifax",
  problem: "Grooming without the drive to a salon", revenue: "$80 per groom, paid per visit.",
};
const assumptions: AssumptionsSection = {
  assumptions: [
    { statement: "Halifax dog owners will pay $80 for a groom at home.", short: "Dog owners will pay $80 for a groom at home.", if_false: "If false, there is no business.", rests_on: "demand_evidence", evidence: "Demand Evidence found one signal: 94 reviews for one groomer." },
  ],
};
const tests: TestsSection = {
  tests: [{
    name: "Deposit page.", description: "Take $20 deposits for a first groom.", summary: "Post a booking page with a $20 deposit to two Halifax dog groups.",
    assumption: 1, proves: "Owners commit money.", cost: 20, days: 10, kill_threshold: "Fewer than 10 deposits from 200 visits.", kill_threshold_short: "Under 10 deposits",
  }],
};

const FINDING_60 = "A licence is needed before the first groom can go ahead now.";
const context = "CONTEXT";
const round1 = laterContext(spec, store, { alternatives, demand_evidence: demand, economics }, context);
const round3 = laterContext(spec, store, { alternatives, demand_evidence: demand, economics, idea, distribution, blockers, riskiest_assumptions: assumptions }, context);

beforeEach(() => {
  create.mockReset();
});

describe("length overrun helpers", () => {
  it("parses the writer and report length-error shapes, and ignores structural errors", () => {
    expect(FINDING_60.length).toBe(60);
    expect(lengthOverrun("scorecard.finding: 60 characters, at most 56")).toEqual({ field: "scorecard.finding", max: 56, length: 60 });
    expect(lengthOverrun("tests[0].description: 68 characters, at most 64")).toEqual({ field: "tests[0].description", max: 64, length: 68 });
    expect(lengthOverrun("headline: 70 characters, at most 64")).toEqual({ field: "headline", max: 64, length: 70 });
    expect(lengthOverrun("alternatives[0].name: 41 characters, at most 26")).toEqual({ field: "alternatives[0].name", max: 26, length: 41 });
    expect(lengthOverrun("channels[0].reason: 80 characters; with the cost text code adds, the reason parts may have at most 67")).toEqual({
      field: "channels[0].reason", max: 67, length: 80,
    });
    expect(lengthOverrun("scorecard.finding: no figures (the key figure carries the number)")).toBeNull();
    expect(lengthOverrun("scorecard: expected an object")).toBeNull();
    expect(lengthOverrun("the reply is not valid JSON (Unexpected token)")).toBeNull();
    expect(lengthOverrun("cites 7 distinct sources; the limit is 5")).toBeNull();
  });

  it("truncates at a word boundary with an ellipsis, and hard-cuts a single word", () => {
    expect(truncateAtWord("only paperwork stands in the way of launching", 20)).toBe("only paperwork…");
    expect(truncateAtWord(FINDING_60, LEN.finding).length).toBeLessThanOrEqual(LEN.finding);
    expect(truncateAtWord(FINDING_60, LEN.finding).endsWith("…")).toBe(true);
    expect(truncateAtWord("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghi…");
    expect(truncateAtWord("short enough", 56)).toBe("short enough");
  });

  it("shortens a scorecard finding and the texts of a parts array", () => {
    const finding = applyLengthOverrun({ scorecard: { finding: FINDING_60 } }, { field: "scorecard.finding", max: 56, length: 60 }) as { scorecard: { finding: string } };
    expect(finding.scorecard.finding.length).toBeLessThanOrEqual(56);
    expect(finding.scorecard.finding.endsWith("…")).toBe(true);

    const mapped = applyLengthOverrun({ scorecard: { finding: FINDING_60 } }, { field: "scorecard.blockers.finding", max: 56, length: 60 }) as { scorecard: { finding: string } };
    expect(mapped.scorecard.finding.length).toBeLessThanOrEqual(56);

    const parts = applyLengthOverrun(
      { reason: [{ text: "x".repeat(50), source: null, estimate: null }, { text: "y".repeat(40), source: null, estimate: null }] },
      { field: "reason", max: 55, length: 90 },
    ) as { reason: { text: string }[] };
    expect(parts.reason.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(55);
  });
});

describe("runWriter length recovery", () => {
  const parseFinding = (json: unknown) => {
    const finding = (json as { scorecard: { finding: string } }).scorecard?.finding;
    if (typeof finding !== "string" || !finding.trim()) throw new Error("scorecard.finding: expected a non-empty string");
    if (finding.length > 56) throw new Error(`scorecard.finding: ${finding.length} characters, at most 56`);
    return json;
  };
  const draft = (finding: string) => ({ scorecard: { finding } });
  const write = () => runWriter("blockers", { model: "claude-sonnet-5-5", context: "ctx", sectionPrompt: "prompt", promptVersion: "blockers-write.v1", parse: parseFinding });

  it("repairs a 60-character finding when the writer shortens it", async () => {
    create.mockResolvedValueOnce(reply(JSON.stringify(draft(FINDING_60)))).mockResolvedValueOnce(reply('{"scorecard.finding": "A licence is needed first."}'));
    const r = await write();
    expect(r.value).toEqual(draft("A licence is needed first."));
    expect(create).toHaveBeenCalledTimes(2);
    const ask = (create.mock.calls[1][0] as Params).messages.at(-1)!.content;
    expect(ask).toContain("hard limit of 56 characters");
    expect(ask).toContain("it is 60 characters");
    expect(ask).toContain("Rewrite only that field");
    expect(r.run.retries).toEqual(["scorecard.finding: 60 characters, at most 56"]);
  });

  it("truncates a 60-character finding after one repair and completes the run", async () => {
    create.mockResolvedValue(reply(JSON.stringify(draft(FINDING_60))));
    const r = await write();
    const finding = (r.value as { scorecard: { finding: string } }).scorecard.finding;
    expect(finding.length).toBeLessThanOrEqual(56);
    expect(finding.endsWith("…")).toBe(true);
    expect(create).toHaveBeenCalledTimes(1 + LENGTH_REPAIR_ATTEMPTS);
    expect(r.run.retries?.some((x) => x.startsWith("truncated scorecard.finding"))).toBe(true);
  });

  it("truncates a combined parts field after one repair", async () => {
    const parse = (json: unknown) => {
      const reason = (json as { channels: { reason: { text: string }[] }[] }).channels?.[0]?.reason;
      if (!Array.isArray(reason)) throw new Error("channels[0].reason: expected an array");
      const n = reason.reduce((s, p) => s + p.text.length, 0);
      if (n > 55) throw new Error(`channels[0].reason: ${n} characters; with the cost text code adds, the reason parts may have at most 55`);
      return json;
    };
    create.mockResolvedValue(reply(JSON.stringify({ channels: [{ reason: [{ text: "x".repeat(50) }, { text: "y".repeat(20) }] }] })));
    const r = await runWriter("distribution", {
      model: "claude-sonnet-5-5", context: "ctx", sectionPrompt: "prompt", promptVersion: "distribution-write.v1", parse,
    });
    const n = (r.value as { channels: { reason: { text: string }[] }[] }).channels[0].reason.reduce((s, p) => s + p.text.length, 0);
    expect(n).toBeLessThanOrEqual(55);
    expect(create).toHaveBeenCalledTimes(1 + LENGTH_REPAIR_ATTEMPTS);
  });

  it("still fails a structural error after the usual retries", async () => {
    create.mockResolvedValue(reply(JSON.stringify({})));
    const err = await write().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriterError);
    expect((err as WriterError).message).toMatch(/blockers: writer output invalid: scorecard.finding: expected a non-empty string/);
    expect(create).toHaveBeenCalledTimes(WRITE_ATTEMPTS);
  });
});

describe("section writers", () => {
  it("completes Blockers when scorecard.finding is 60 characters", async () => {
    expect(() => parseBlockers({ ...blockers, scorecard: { ...blockers.scorecard, finding: FINDING_60 } }, round1)).toThrow(/scorecard.finding: 60 characters, at most 56/);
    create.mockResolvedValue(reply(JSON.stringify({ ...blockers, scorecard: { ...blockers.scorecard, finding: FINDING_60 } })));
    const r = await writeBlockers(round1);
    expect(r.value.scorecard.finding.length).toBeLessThanOrEqual(LEN.finding);
    expect(r.value.scorecard.finding.endsWith("…")).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("completes Idea when headline is over 64 characters", async () => {
    const headline = "Mobile dog grooming at the owner's door in Halifax for busy owners";
    expect(headline.length).toBeGreaterThan(64);
    expect(() => parseIdea({ headline, customer: idea.customer, problem: idea.problem, revenue: idea.revenue }, round1)).toThrow(/headline: \d+ characters, at most 64/);
    create.mockResolvedValue(reply(JSON.stringify({ headline, customer: idea.customer, problem: idea.problem, revenue: idea.revenue })));
    const r = await writeIdea(round1);
    expect(r.value.headline.length).toBeLessThanOrEqual(64);
    expect(r.value.headline.endsWith("…")).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("completes Next Tests when description is over 64 characters", async () => {
    const description = "Take twenty-dollar deposits for a first home groom from two groups.";
    expect(description.length).toBeGreaterThan(64);
    expect(() => parseTests({ tests: [{ ...tests.tests[0], description }] }, round3)).toThrow(/tests\[0\]\.description: \d+ characters, at most 64/);
    create.mockResolvedValue(reply(JSON.stringify({ tests: [{ ...tests.tests[0], description }] })));
    const r = await writeTests(round3);
    expect(r.value.tests[0].description.length).toBeLessThanOrEqual(64);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("still fails Blockers when the JSON is missing required fields", async () => {
    create.mockResolvedValue(reply(JSON.stringify({ blockers: [] })));
    const err = await writeBlockers(round1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriterError);
    expect((err as WriterError).message).toMatch(/blockers: writer output invalid:/);
    expect(create).toHaveBeenCalledTimes(WRITE_ATTEMPTS);
  });

  it("still fails Verdict when a summary uses a figure the report does not give", async () => {
    const all: Partial<Drafts> = { alternatives, demand_evidence: demand, economics, idea, distribution, blockers, riskiest_assumptions: assumptions, next_tests: tests };
    const round4 = laterContext(spec, store, all, context);
    const verdict: VerdictSection = {
      call: "test_first", confidence: "low", summary: "Each groom keeps $25 which the report never said.",
      page_summaries: { market: "Salons only; demand is thin.", business: "A thin margin and costly ads.", next_steps: "One licence and one test of deposits." },
    };
    expect(() => parseVerdict(verdict, round4)).toThrow(/"\$25"/);
    create.mockResolvedValue(reply(JSON.stringify(verdict)));
    const err = await writeVerdict(round4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriterError);
    expect((err as WriterError).message).toMatch(/"\$25"/);
    expect(create).toHaveBeenCalledTimes(WRITE_ATTEMPTS);
  });
});

describe("writer prompts", () => {
  it("tell every section writer the hard character limits", () => {
    for (const name of [
      "writer-shared.v1", "blockers-write.v1", "demand-write.v1", "economics-write.v2", "alternatives-write.v3",
      "distribution-write.v1", "idea-write.v1", "tests-write.v1", "verdict-write.v1", "assumptions-write.v1",
    ]) {
      expect(loadPrompt(name), name).toMatch(/character limits are hard|hard limits/i);
    }
    expect(loadPrompt("blockers-write.v1")).toContain("at most 56 characters");
    expect(loadPrompt("demand-write.v1")).toContain("at most 56 characters");
    expect(loadPrompt("idea-write.v1")).toContain("at most 64 characters");
    expect(loadPrompt("tests-write.v1")).toContain("at most 64 characters");
    expect(loadPrompt("verdict-write.v1")).toContain("at most 160 characters");
  });
});
