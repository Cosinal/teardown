import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budget, DeadlineError, requestOptions, withBudget, type StageRun } from "../lib/engine/llm";
import { writeFirstSections } from "../lib/engine/pipeline";
import type { IdeaSpec } from "../lib/engine/intake";
import type { SourceStore } from "../lib/engine/research";
import type { AlternativesSection } from "../lib/engine/sections/alternatives";
import { WRITE_ATTEMPTS, WriterError, problemField, runWriter, stringAt, withString, writerContext } from "../lib/engine/sections/common";
import type { DemandSection } from "../lib/engine/sections/demand";
import type { EconomicsSection } from "../lib/engine/sections/economics";

// Keeping a run under Vercel's 300 s limit: the first three writers run at
// once after a cache warm-up, retries ask only for the field that failed, and
// the run's time budget aborts calls at its hard deadline. The Anthropic
// client is mocked, with fake delays on fake timers.

const create = vi.fn();
vi.mock("../lib/engine/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine/llm")>()),
  anthropic: () => ({ messages: { create } }),
}));

type Params = { max_tokens: number; system: { text: string }[]; messages: { role: string; content: string }[] };

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const reply = (text: string) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage, content: [{ type: "text", text }] });

const src = (id: string) => ({ id, url: `https://${id.toLowerCase()}.example`, title: `Page ${id}`, retrieved_at: "2026-10-12T00:00:00.000Z", excerpt: `Quote from ${id}` });
const store: SourceStore = ["S1", "S2", "S3", "S4"].map(src);
const found = (text: string, source: string) => ({ text, source, estimate: null });
const est = (text: string, estimate: string) => ({ text, source: null, estimate });
const plain = (text: string) => ({ text, source: null, estimate: null });

const spec = {
  name: "Halifax mobile dog grooming", customer: "Dog owners in Halifax", problem: "Grooming without driving to a salon",
  revenue_model: { price: "$80 per groom", billing: "one_time", notes: "Flat price." },
  category: "Mobile dog grooming", geography: { scope: "local", places: ["Halifax"] }, search_queries: [], ambiguities: [],
} as IdeaSpec;
const INPUT = { idea: "A mobile dog grooming van.", target_customer: "Dog owners", price: "$80", billing: "one_time", geography: "Halifax" } as const;

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
const context = writerContext(spec, store, [{ label: "Shared research", text: "Salons dominate [S1]." }]);

/** Which writer a request is for, from its section prompt. */
function section(p: Params): "warm" | "alternatives" | "demand_evidence" | "economics" {
  if (p.max_tokens === 0) return "warm";
  const prompt = p.system.at(-1)!.text;
  if (prompt.startsWith("# Section: Existing Alternatives")) return "alternatives";
  if (prompt.startsWith("# Section: Demand Evidence")) return "demand_evidence";
  if (prompt.startsWith("# Section: Economics")) return "economics";
  throw new Error(`unexpected request: ${prompt.slice(0, 40)}`);
}
const DRAFTS = { alternatives, demand_evidence: demand, economics };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  create.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("first three writers", () => {
  /** Mocks the client: the warm-up takes 500 ms, each writer 2 s. Logs when each call starts and ends. */
  function timedClient(warm: "ok" | "fail" = "ok") {
    const log: { name: string; start: number; end: number }[] = [];
    let inFlight = 0;
    let maxWriters = 0;
    create.mockImplementation(async (p: Params) => {
      const name = section(p);
      const start = Date.now();
      if (name !== "warm") maxWriters = Math.max(maxWriters, ++inFlight);
      await sleep(name === "warm" ? 500 : 2000);
      if (name !== "warm") inFlight--;
      log.push({ name, start, end: Date.now() });
      if (name === "warm") {
        if (warm === "fail") throw new Error("400 bad request");
        return { ...reply(""), stop_reason: "max_tokens" };
      }
      return reply(JSON.stringify(DRAFTS[name]));
    });
    return { log, maxWriters: () => maxWriters };
  }

  async function run() {
    const runs: StageRun[] = [];
    const t0 = Date.now();
    const done = writeFirstSections(context, store, INPUT, {}, async (r) => { if (r) runs.push(r); });
    await vi.advanceTimersByTimeAsync(10_000);
    const [alt, dem, econ] = await done;
    return { alt, dem, econ, runs, t0 };
  }

  it("warm the cache, then run all three writers at once", async () => {
    const client = timedClient();
    const { alt, dem, econ, runs, t0 } = await run();

    expect(alt.value).toEqual(alternatives);
    expect(dem.value).toEqual(demand);
    expect(econ.value.price.amount).toBe(80);
    expect(client.maxWriters()).toBe(3);
    const warm = client.log.find((l) => l.name === "warm")!;
    const writers = client.log.filter((l) => l.name !== "warm");
    // Every writer starts after the warm-up has written the cache, and together.
    for (const w of writers) expect(w.start).toBe(warm.end);
    expect(Math.max(...writers.map((w) => w.end)) - t0).toBe(2500);
    // The warm-up's spend is recorded with the writers'.
    expect(runs.map((r) => `${r.stage}:${r.step}`).toSorted()).toEqual(["alternatives:warm", "alternatives:write", "demand_evidence:write", "economics:write"]);
  });

  it("the warm-up has the writers' exact cached prefix", async () => {
    timedClient();
    await run();
    const sent = create.mock.calls.map((c) => c[0] as Params & { model: string; output_config: unknown });
    const warm = sent.find((p) => p.max_tokens === 0)!;
    for (const p of sent) {
      expect(p.model).toBe(warm.model);
      expect(p.output_config).toEqual(warm.output_config);
      expect(p.system[0]).toEqual(warm.system[0]);
    }
  });

  it("without the warm-up, Alternatives writes the cache first and the other two follow together", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = timedClient("fail");
    const { runs, t0 } = await run();
    const at = (name: string) => client.log.find((l) => l.name === name)!;
    expect(at("demand_evidence").start).toBe(at("alternatives").end);
    expect(at("economics").start).toBe(at("alternatives").end);
    expect(at("economics").end - t0).toBe(4500);
    expect(runs.map((r) => r.step)).not.toContain("warm");
  });

  it("records every writer's spend when one fails, and throws that writer's error", async () => {
    create.mockImplementation(async (p: Params) => {
      const name = section(p);
      await sleep(100);
      if (name === "warm") return { ...reply(""), stop_reason: "max_tokens" };
      return reply(name === "demand_evidence" ? "no JSON here" : JSON.stringify(DRAFTS[name]));
    });
    const runs: StageRun[] = [];
    const done = writeFirstSections(context, store, INPUT, {}, async (r) => { if (r) runs.push(r); }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await done;
    expect(err).toBeInstanceOf(WriterError);
    expect((err as WriterError).run.stage).toBe("demand_evidence");
    // The failed writer's run is recorded by the caller (store.ts); the others' here.
    expect(runs.map((r) => `${r.stage}:${r.step}`).toSorted()).toEqual(["alternatives:warm", "alternatives:write", "economics:write"]);
  });

  it("does not fail the run when demand_evidence JSON is followed by extra text on a later line", async () => {
    create.mockImplementation(async (p: Params) => {
      const name = section(p);
      if (name === "warm") return { ...reply(""), stop_reason: "max_tokens" };
      const body = JSON.stringify(DRAFTS[name]);
      return reply(name === "demand_evidence" ? `${body}\n\n{"note":"extra"}` : body);
    });
    const { dem } = await run();
    expect(dem.value).toEqual(demand);
    expect(create.mock.calls.filter((c) => section(c[0] as Params) === "demand_evidence")).toHaveLength(1);
  });
});

describe("writer retries", () => {
  const parse = (json: unknown) => {
    const text = stringAt(json, "tests[1].description");
    if (text === undefined) throw new Error("tests[1].description: expected a non-empty string");
    if (text.length > 10) throw new Error(`tests[1].description: ${text.length} characters, at most 10`);
    return json;
  };
  const write = () => runWriter("next_tests", { model: "claude-sonnet-5-5", context: "ctx", sectionPrompt: "prompt", promptVersion: "tests-write.v1", parse });
  const draft = (description: string) => ({ tests: [{ name: "A", description: "fine" }, { name: "B", description }] });

  it("finds the field a problem names", () => {
    expect(problemField("tests[0].description: 68 characters, at most 64")).toBe("tests[0].description");
    expect(problemField("scorecard.finding: 61 characters, at most 56")).toBe("scorecard.finding");
    expect(problemField("cites 7 distinct sources; the limit is 5")).toBeNull();
    expect(problemField("the reply is not valid JSON (Unexpected token)")).toBeNull();
    expect(withString(draft("x"), "tests[1].description", "y")).toEqual(draft("y"));
  });

  it("ask for only the field that failed and put it back into the last reply", async () => {
    create.mockResolvedValueOnce(reply(JSON.stringify(draft("much too long")))).mockResolvedValueOnce(reply('{"tests[1].description": "short"}'));
    const r = await write();
    expect(r.value).toEqual(draft("short"));
    expect(create).toHaveBeenCalledTimes(2);
    const ask = (create.mock.calls[1][0] as Params).messages.at(-1)!.content;
    expect(ask).toContain("Rewrite only that field");
    expect(ask).toContain('{"tests[1].description": "..."}');
    expect(r.run.retries).toEqual(["tests[1].description: 13 characters, at most 10"]);
  });

  it("ask for the whole object again when the problem isn't one field of the reply", async () => {
    create.mockResolvedValueOnce(reply("not JSON")).mockResolvedValueOnce(reply(JSON.stringify(draft("short"))));
    const r = await write();
    expect(r.value).toEqual(draft("short"));
    expect((create.mock.calls[1][0] as Params).messages.at(-1)!.content).toContain("reply with the whole JSON object again");
  });

  it("keeps the section when valid JSON is followed by extra text on a later line, without retrying", async () => {
    const good = draft("short");
    create.mockResolvedValueOnce(reply(`${JSON.stringify(good)}\n\n{"note":"counted characters"}`));
    const r = await write();
    expect(r.value).toEqual(good);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries the writer once when nothing extractable is valid JSON, then succeeds", async () => {
    create.mockResolvedValueOnce(reply('{"a":}\n\nstill broken')).mockResolvedValueOnce(reply(JSON.stringify(draft("short"))));
    const r = await write();
    expect(r.value).toEqual(draft("short"));
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1][0] as Params).messages.at(-1)!.content).toContain("reply with the whole JSON object again");
  });

  it("stop after two retries on a structural error", async () => {
    const parse = () => {
      throw new Error("scorecard: expected an object");
    };
    create.mockResolvedValue(reply(JSON.stringify(draft("short"))));
    const err = await runWriter("next_tests", {
      model: "claude-sonnet-5-5", context: "ctx", sectionPrompt: "prompt", promptVersion: "tests-write.v1", parse,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriterError);
    expect((err as WriterError).message).toMatch(/scorecard: expected an object/);
    expect(WRITE_ATTEMPTS).toBe(3);
    expect(create).toHaveBeenCalledTimes(3);
  });
});

describe("time budget", () => {
  it("passes the hard deadline to every call, and caps each attempt at 60 s", () => {
    expect(requestOptions()).toEqual({ timeout: 60_000 });
    expect(requestOptions(null)).toEqual({});
    const budget = new Budget(240_000, 275_000);
    return withBudget(budget, async () => {
      vi.advanceTimersByTime(250_000);
      const opts = requestOptions();
      expect(opts.signal).toBe(budget.signal);
      expect(opts.timeout).toBe(25_000);
      expect(requestOptions(null).timeout).toBe(25_000);
      expect(budget.overSoft).toBe(true);
      budget.done();
    });
  });

  it("aborts a call still running at the hard deadline", async () => {
    // Like the SDK: the request rejects when its signal aborts.
    create.mockImplementation((_p: Params, opts: { signal: AbortSignal }) => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("Request was aborted.")));
    }));
    const budget = new Budget(240_000, 275_000);
    const done = withBudget(budget, () => runWriter("verdict", {
      model: "claude-sonnet-5-5", context: "ctx", sectionPrompt: "prompt", promptVersion: "verdict-write.v1", parse: (j) => j,
    })).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(275_000);
    expect(await done).toMatchObject({ message: "Request was aborted." });
    expect(budget.expired).toBe(true);
    expect(() => budget.check()).toThrow(DeadlineError);
    await expect(withBudget(budget, async () => requestOptions())).rejects.toBeInstanceOf(DeadlineError);
    budget.done();
  });
});
