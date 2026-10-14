import { beforeEach, describe, expect, it, vi } from "vitest";
import { runIntake, type IdeaSpec } from "../lib/engine/intake";
import type { IntakeInput } from "../lib/engine/input";
import { buildPartialReport } from "../lib/engine/report";
import type { SourceStore } from "../lib/engine/research";
import { economicsPrompt, founderPrice, writeEconomics } from "../lib/engine/sections/economics";

// The founder's price, as entered on the form, is the only price Economics may
// use: intake can't restate it, and a writer draft with another price is sent
// back. No model calls: the Anthropic client is mocked.

const create = vi.fn();
const parse = vi.fn();
vi.mock("../lib/engine/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine/llm")>()),
  anthropic: () => ({ messages: { create, parse } }),
}));

const src = (id: string) => ({ id, url: `https://${id.toLowerCase()}.example`, title: `Page ${id}`, retrieved_at: "2026-10-12T00:00:00.000Z", excerpt: `Quote from ${id}` });
const store: SourceStore = ["S1", "S2"].map(src);
const est = (text: string, estimate: string) => ({ text, source: null, estimate });

/** The fixture idea: in-person tutoring at $40 a session. */
const TUTORING: IntakeInput = {
  idea: "In-person high school math tutoring in Halifax, booked by the session.",
  target_customer: "Parents of high school students in Halifax",
  price: "$40/session",
  billing: "other",
  geography: "Halifax, Nova Scotia",
};

/** An Economics draft at `amount` a session: tutor time at a wage, plus small fixed costs. */
const draft = (amount: number) => ({
  per: "session",
  currency: "CAD",
  price: { amount, note: [est("The founder's price", "The founder's own price, from the form")] },
  unit_cost: { amount: 22, note: [est("1 h tutor time plus travel", "Tutor wage per hour plus travel per visit")] },
  fixed_costs: { amount: 300, note: [est("Software, insurance and ads", "Scheduling software plus liability insurance")] },
  break_even_unit: "sessions a month",
  scorecard: { rating: "mixed", finding: "Fair margin, but each session needs a tutor's hour." },
});

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const reply = (json: unknown) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage, content: [{ type: "text", text: JSON.stringify(json) }] });

beforeEach(() => {
  create.mockReset();
  parse.mockReset();
});

describe("founderPrice", () => {
  it("reads one figure, with its unit left to the text", () => {
    expect(founderPrice(TUTORING)).toEqual({ text: "$40/session", billing: "other", amount: 40, range: false });
    expect(founderPrice({ price: "$2,000/month", billing: "subscription" }).amount).toBe(2000);
    expect(founderPrice({ price: "$12.5K per install", billing: "one_time" }).amount).toBe(12500);
    expect(founderPrice({ price: "CAD 80 per groom", billing: "one_time" }).amount).toBe(80);
  });

  it("takes a range's midpoint", () => {
    expect(founderPrice({ price: "$5–10 per report", billing: "one_time" })).toMatchObject({ amount: 7.5, range: true });
    expect(founderPrice({ price: "$30 - $50 a session", billing: "other" })).toMatchObject({ amount: 40, range: true });
  });

  it("enforces nothing when the price isn't one figure or range", () => {
    expect(founderPrice({ price: "$40, or 4 sessions for $150", billing: "other" }).amount).toBeNull();
    expect(founderPrice({ price: "Free to start", billing: "subscription" }).amount).toBeNull();
    expect(founderPrice({ price: "$0", billing: "one_time" }).amount).toBeNull();
  });
});

describe("intake", () => {
  it("keeps the founder's price and billing even if the model restates them", async () => {
    const restated: IdeaSpec = {
      name: "Halifax math tutoring", customer: "Parents", problem: "Grades", category: "Tutoring",
      revenue_model: { price: "$35 per hour", billing: "subscription", notes: "Per session, no packages." },
      geography: { scope: "local", places: ["Halifax"] },
      search_queries: Array.from({ length: 4 }, (_, i) => ({ query: `tutoring halifax ${i}`, purpose: "competitors" as const })),
      ambiguities: [],
    };
    parse.mockResolvedValue({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage, parsed_output: restated });
    const { spec } = await runIntake(TUTORING);
    expect(spec.revenue_model).toEqual({ price: "$40/session", billing: "other", notes: "Per session, no packages." });
  });
});

describe("economics at the founder's price", () => {
  const price = founderPrice(TUTORING);

  it("tells the writer the exact amount", () => {
    expect(economicsPrompt(undefined, price)).toContain('the founder entered "$40/session" (other). So `price.amount` is 40.');
    expect(economicsPrompt(undefined, founderPrice({ price: "$5–10 per report", billing: "one_time" }))).toContain("is 7.5, the midpoint of that range");
  });

  it("sends back a draft at another price, and the report shows the founder's", async () => {
    create.mockResolvedValueOnce(reply(draft(30))).mockResolvedValueOnce(reply(draft(40)));
    const { value, run } = await writeEconomics("CONTEXT", store, {}, price);
    expect(create).toHaveBeenCalledTimes(2);
    expect(run.retries).toEqual([`price.amount: 30, but the founder's price is "$40/session", so it must be 40`]);

    const report = buildPartialReport({ economics: value }, store);
    expect(report.economics!.unit.price.value).toBe("$40");
    expect(report.economics!.workings![0]).toMatchObject({ label: "Price", value: "$40 a session" });
    expect(report.economics!.unit.margin.value).toBe("45%");
  });
});
