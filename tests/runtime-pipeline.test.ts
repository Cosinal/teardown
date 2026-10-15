import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budget, DeadlineError, ZERO_USAGE, withBudget, type StageRun } from "../lib/engine/llm";
import type { TeardownStatus } from "../lib/engine/pipeline";

// The time budget across the whole pipeline. Every stage is mocked to take
// 1 s of fake time; the Anthropic client only answers the cache warm-up.

const create = vi.fn();
vi.mock("../lib/engine/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine/llm")>()),
  anthropic: () => ({ messages: { create } }),
}));

const STEP_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (stage: string, step = "write"): StageRun => ({
  stage, step, prompt_version: "v1", model: "claude-sonnet-5-5", usage: ZERO_USAGE, cost_usd: 0.01,
  started_at: new Date().toISOString(), duration_ms: STEP_MS,
} as StageRun);
/** A later writer's third argument when it revises a draft: { draft, feedback }. */
const isRevision = (args: unknown[]) => typeof args[2] === "object" && args[2] !== null && "feedback" in args[2];
/** A writer: 1 s, then an empty draft. */
const writer = (stage: string) => vi.fn(async (...args: unknown[]) => {
  await sleep(STEP_MS);
  return { value: { stage }, run: run(stage, isRevision(args) ? "revise" : "write") };
});
const store = [{ id: "S1", url: "https://s1.example", title: "S1", retrieved_at: "2026-10-12T00:00:00.000Z", excerpt: "Quote" }];
const checked = async (_name: string, _check: unknown, section: unknown) => {
  await sleep(STEP_MS);
  return { section, log: [], results: [], excerptResults: [], sources: store, changed: [], run: null };
};

const w = {
  alternatives: writer("alternatives"), demand_evidence: writer("demand_evidence"), economics: writer("economics"),
  idea: writer("idea"), distribution: writer("distribution"), blockers: writer("blockers"),
  riskiest_assumptions: writer("riskiest_assumptions"), next_tests: writer("next_tests"), verdict: writer("verdict"),
};
const noCheck = () => () => ({});

vi.mock("../lib/engine/intake", () => ({
  runIntake: vi.fn(async () => { await sleep(STEP_MS); return { spec: { revenue_model: { billing: "one_time" } }, run: run("intake", "") }; }),
}));
vi.mock("../lib/engine/research", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine/research")>()),
  runResearch: vi.fn(async () => { await sleep(STEP_MS); return { sources: store, notes: "Notes [S1].", run: run("research", ""), responses: [] }; }),
}));
vi.mock("../lib/engine/factcheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine/factcheck")>()),
  factcheckSection: checked,
  runFactcheck: (section: unknown) => checked("alternatives", null, section),
}));
/** The internal check always finds one unsupported claim, so each of Idea, Assumptions and Verdict asks for a revision. */
vi.mock("../lib/engine/sections/brief", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine/sections/brief")>()),
  factcheckInternal: async (name: string, _check: unknown, section: unknown) => {
    await sleep(STEP_MS);
    return {
      section, results: [], excerptResults: [], sources: store, changed: [], run: run("factcheck", undefined),
      log: [{ id: `${name}.x`, text: "A claim.", source: "R", verdict: "unsupported", reason: "Not in the report.", action: "unresolved" }],
    };
  },
}));
vi.mock("../lib/engine/report", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/engine/report")>()), buildReport: () => ({}) }));
vi.mock("../lib/engine/sections/later", () => ({ laterContext: () => ({}) }));
vi.mock("../lib/engine/sections/alternatives", async (i) => ({ ...(await i<object>()), writeAlternatives: w.alternatives }));
vi.mock("../lib/engine/sections/demand", async (i) => ({ ...(await i<object>()), writeDemand: w.demand_evidence, demandCheck: noCheck }));
vi.mock("../lib/engine/sections/economics", async (i) => ({ ...(await i<object>()), writeEconomics: w.economics, economicsCheck: noCheck }));
vi.mock("../lib/engine/sections/idea", async (i) => ({ ...(await i<object>()), writeIdea: w.idea, ideaCheck: noCheck, ideaSource: () => ({}) }));
vi.mock("../lib/engine/sections/distribution", async (i) => ({ ...(await i<object>()), writeDistribution: w.distribution, distributionCheck: noCheck }));
vi.mock("../lib/engine/sections/blockers", async (i) => ({ ...(await i<object>()), writeBlockers: w.blockers, blockersCheck: noCheck }));
vi.mock("../lib/engine/sections/assumptions", async (i) => ({
  ...(await i<object>()), writeAssumptions: w.riskiest_assumptions, assumptionsCheck: noCheck, reportSource: () => ({}),
}));
vi.mock("../lib/engine/sections/tests", async (i) => ({ ...(await i<object>()), writeTests: w.next_tests, testsCheck: noCheck }));
vi.mock("../lib/engine/sections/verdict", async (i) => ({ ...(await i<object>()), writeVerdict: w.verdict, verdictCheck: noCheck }));

const { runPipeline } = await import("../lib/engine/pipeline");
const { runIntake } = await import("../lib/engine/intake");
const { runResearch } = await import("../lib/engine/research");

const INPUT = { idea: "A mobile dog grooming van.", target_customer: "Dog owners", price: "$80", billing: "one_time", geography: "Halifax" } as const;
const NO_SEARCHES = { demand_evidence: { maxSearches: 0 }, economics: { maxSearches: 0 }, alternatives: { maxSearches: 0 } };

/** Runs the pipeline under `budget` on fake timers. Returns its result or error, how long it took, and the statuses and runs it recorded. */
async function pipeline(budget: Budget) {
  const statuses: TeardownStatus[] = [];
  const runs: StageRun[] = [];
  const t0 = Date.now();
  const done = withBudget(budget, () => runPipeline(INPUT, NO_SEARCHES, {
    status: async (s) => { statuses.push(s); },
    run: async (r) => { runs.push(r); },
  })).then((r) => ({ ok: r, ms: Date.now() - t0 }), (err: unknown) => ({ err, ms: Date.now() - t0 }));
  await vi.advanceTimersByTimeAsync(600_000);
  const out = await done;
  budget.done();
  return { ...out, statuses, runs };
}
const revisions = () => Object.values(w).flatMap((fn) => fn.mock.calls.filter(isRevision));

beforeEach(() => {
  vi.useFakeTimers();
  create.mockReset();
  vi.mocked(runIntake).mockClear();
  vi.mocked(runResearch).mockClear();
  create.mockImplementation(async () => {
    await sleep(STEP_MS);
    return { model: "claude-sonnet-5-5", stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 }, content: [] };
  });
  for (const fn of Object.values(w)) fn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("pipeline time budget", () => {
  it("within the soft limit, revises Idea, Riskiest Assumptions and Verdict after their check", async () => {
    const r = await pipeline(new Budget(240_000, 275_000));
    expect(r).toHaveProperty("ok");
    expect(r.statuses.at(-1)).toBe("done");
    expect(revisions()).toHaveLength(3);
    expect(r.runs.filter((x) => x.step === "revise").map((x) => x.stage)).toEqual(["idea", "riskiest_assumptions", "verdict"]);
  });

  it("past the soft limit, skips the revisions and finishes with the checked first drafts", async () => {
    const budget = new Budget(240_000, 275_000);
    // Pretend the run is already 4 minutes in.
    vi.advanceTimersByTime(240_000);
    const r = await pipeline(budget);
    expect(r).toHaveProperty("ok");
    expect(r.statuses.at(-1)).toBe("done");
    expect(revisions()).toEqual([]);
  });

  it("skips only the revisions after the soft limit, keeping the earlier ones", async () => {
    // Intake, research, warm-up, writers, checks: Idea's revision comes before 10 s, Verdict's after.
    const r = await pipeline(new Budget(10_000, 275_000));
    expect(r).toHaveProperty("ok");
    const revised = r.runs.filter((x) => x.step === "revise").map((x) => x.stage);
    expect(revised).toContain("idea");
    expect(revised).not.toContain("verdict");
  });

  it("at the hard deadline, stops at the next step with a DeadlineError", async () => {
    const r = await pipeline(new Budget(1_000, 5_500));
    expect((r as { err: unknown }).err).toBeInstanceOf(DeadlineError);
    expect(r.statuses).not.toContain("done");
    // The mocked steps ignore the abort signal (real API calls don't: see runtime.test.ts), so the
    // first three fact-checks finish at 7 s and the next step's check throws.
    expect(r.ms).toBe(7_000);
  });

  it("resume from saved research skips intake and searches", async () => {
    const spec = { revenue_model: { billing: "one_time" } };
    const budget = new Budget(240_000, 275_000);
    const statuses: TeardownStatus[] = [];
    const done = withBudget(budget, () => runPipeline(INPUT, {
      ...NO_SEARCHES,
      resume: {
        spec: spec as never,
        research: { sources: store, notes: "Notes [S1]." },
        sectionSources: store,
        sectionNotes: { demand_evidence: "Demand notes [S2]." },
      },
    }, { status: async (s) => { statuses.push(s); } }));
    await vi.advanceTimersByTimeAsync(600_000);
    await done;
    budget.done();
    expect(runIntake).not.toHaveBeenCalled();
    expect(runResearch).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe("done");
  });

  it("runs the three first writers at once", async () => {
    let inFlight = 0;
    let most = 0;
    for (const name of ["alternatives", "demand_evidence", "economics"] as const) {
      w[name].mockImplementationOnce(async () => {
        most = Math.max(most, ++inFlight);
        await sleep(STEP_MS);
        inFlight--;
        return { value: { stage: name }, run: run(name) };
      });
    }
    const r = await pipeline(new Budget(240_000, 275_000));
    expect(r).toHaveProperty("ok");
    expect(most).toBe(3);
  });
});
