import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyFactcheck, collectClaims, factcheckRequest, runFactcheck, supportRate, type CheckResult } from "../lib/engine/factcheck";
import type { SourceStore } from "../lib/engine/research";
import type { AlternativesSection } from "../lib/engine/sections/alternatives";

const parse = vi.fn();
vi.mock("../lib/engine/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine/llm")>()),
  anthropic: () => ({ messages: { parse } }),
}));

const src = (id: string, excerpt: string) => ({ id, url: `https://${id.toLowerCase()}.example`, title: `Page ${id}`, retrieved_at: "2026-10-12T00:00:00.000Z", excerpt });
const store: SourceStore = [src("S1", "Canoe pricing is sales-led."), src("S2", "Allvue costs $150-500K a year."), src("S3", "Analysts re-key statements.")];

const plain = (text: string) => ({ text, source: null, estimate: null });
const found = (text: string, source: string) => ({ text, source, estimate: null });

const section: AlternativesSection = {
  alternatives: [
    { name: "Alts data platforms", examples: "Canoe", workaround: false, what_it_does: "Extract GP statement data.",
      price: found("Quote only", "S1"), weakness: [found("Sales-led pricing", "S1"), plain("and slow to buy.")] },
    { name: "LP platforms", examples: "Allvue", workaround: false, what_it_does: "Track LP portfolios.",
      price: found("$50K to $500K a year", "S2"), weakness: [found("Three-month setup", "S2")] },
    { name: "Do it by hand", examples: null, workaround: true, what_it_does: "Re-key statements into Excel.",
      price: { text: "Staff time", source: null, estimate: "Analyst hours per statement × statements" }, weakness: [found("Analysts re-key statements", "S3")] },
  ],
  market_gap: [found("Platforms cost $150-500K a year.", "S2"), found("No reconciliation-only tool exists.", "S3")],
  scorecard: { rating: "mixed", key_figure: { value: "3", unit: "alternatives" }, finding: "Costly platforms above, manual work below.", source: "S2", estimate: null },
};

const result = (id: string, verdict: CheckResult["verdict"], action: CheckResult["action"] = "keep", text: string | null = null, method: string | null = null): CheckResult =>
  ({ id, verdict, reason: `${verdict} because`, action, text, method });

describe("collectClaims", () => {
  it("lists only found citations, with ids that locate them and the row as context", () => {
    const claims = collectClaims(section);
    expect(claims.map((c) => c.id)).toEqual([
      "alternatives[0].price", "alternatives[0].weakness[0]", "alternatives[1].price", "alternatives[1].weakness[0]",
      "alternatives[2].weakness[0]", "market_gap[0]", "market_gap[1]", "scorecard",
    ]);
    expect(claims[2].context).toContain('"LP platforms" (Allvue)');
  });

  it("skips an uncited \"Not public\" price", () => {
    const s = structuredClone(section);
    s.alternatives[0].price = plain("Not public");
    expect(collectClaims(s).map((c) => c.id)).not.toContain("alternatives[0].price");
  });

  it("puts each claim's quoted text in the request", () => {
    const req = JSON.parse(factcheckRequest(collectClaims(section).slice(0, 1), store));
    expect(req[0]).toMatchObject({ id: "alternatives[0].price", claim: "Quote only", source: { id: "S1", quoted_text: "Canoe pricing is sales-led." } });
  });
});

describe("applyFactcheck", () => {
  const claims = collectClaims(section);
  const allSupported = claims.map((c) => result(c.id, "supported"));
  const apply = (overrides: CheckResult[]) => {
    const byId = new Map(overrides.map((r) => [r.id, r]));
    return applyFactcheck(section, claims, allSupported.map((r) => byId.get(r.id) ?? r), store);
  };

  it("leaves supported claims alone", () => {
    const { section: out, log } = apply([]);
    expect(out).toEqual(section);
    expect(log.every((l) => l.action === "kept")).toBe(true);
  });

  it("narrows a partial claim and rewrites an unsupported one to what the source says", () => {
    const { section: out, log } = apply([
      result("alternatives[1].price", "partial", "rewrite", "$150-500K a year"),
      result("market_gap[1]", "unsupported", "rewrite", "Analysts re-key statements by hand."),
    ]);
    expect(out.alternatives[1].price).toEqual(found("$150-500K a year", "S2"));
    expect(out.market_gap[1]).toEqual(found("Analysts re-key statements by hand.", "S3"));
    expect(log.find((l) => l.id === "alternatives[1].price")).toMatchObject({ verdict: "partial", action: "rewritten", result: "$150-500K a year" });
  });

  it("keeps a partial claim the checker did not rewrite", () => {
    const { log } = apply([result("market_gap[0]", "partial", "keep")]);
    expect(log.find((l) => l.id === "market_gap[0]")).toMatchObject({ verdict: "partial", action: "kept" });
  });

  it("re-tags an unsupported figure as an estimate with its method", () => {
    const { section: out } = apply([result("alternatives[1].price", "unsupported", "estimate", "$50K+ a year", "Seat count × list price per seat")]);
    expect(out.alternatives[1].price).toEqual({ text: "$50K+ a year", source: null, estimate: "Seat count × list price per seat" });
  });

  it("turns a dropped price into \"Not public\" when the row still cites a source", () => {
    const { section: out, log } = apply([result("alternatives[0].price", "unsupported", "drop")]);
    expect(out.alternatives[0].price).toEqual(plain("Not public"));
    expect(log.find((l) => l.id === "alternatives[0].price")).toMatchObject({ action: "dropped", result: "Not public" });
  });

  it("drops the whole row when its only cited weakness goes, and logs the row's other claims", () => {
    const { section: out, log } = apply([result("alternatives[1].weakness[0]", "unsupported", "drop")]);
    expect(out.alternatives.map((a) => a.name)).toEqual(["Alts data platforms", "Do it by hand"]);
    expect(log.filter((l) => l.id.startsWith("alternatives[1]")).map((l) => l.action)).toEqual(["dropped", "dropped"]);
  });

  it("falls back to dropping when a rewrite breaks the page limits", () => {
    const { section: out, log } = apply([result("market_gap[1]", "unsupported", "rewrite", "x".repeat(500))]);
    expect(out.market_gap).toHaveLength(1);
    expect(log.find((l) => l.id === "market_gap[1]")).toMatchObject({ action: "dropped" });
  });

  it("never drops the scorecard; it falls back to our own summary", () => {
    const { section: out, log } = apply([result("scorecard", "unsupported", "drop")]);
    expect(out.scorecard).toMatchObject({ source: null, estimate: "Our summary of the alternatives listed in this section" });
    expect(log.find((l) => l.id === "scorecard")).toMatchObject({ action: "estimated" });
  });

  it("logs in section order", () => {
    const { log } = apply([result("alternatives[1].weakness[0]", "unsupported", "drop"), result("market_gap[1]", "unsupported", "drop")]);
    expect(log.map((l) => l.id)).toEqual(claims.map((c) => c.id));
  });
});

describe("supportRate", () => {
  it("counts each verdict", () => {
    expect(supportRate([{ verdict: "supported" }, { verdict: "partial" }, { verdict: "unsupported" }, { verdict: "supported" }]))
      .toEqual({ checked: 4, supported: 2, partial: 1, unsupported: 1, rate: 0.5 });
  });
});

describe("runFactcheck (Anthropic mocked)", () => {
  const usage = { input_tokens: 5000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const reply = (results: CheckResult[]) => ({ model: "claude-haiku-5-5", stop_reason: "end_turn", usage, parsed_output: { results }, content: [] });
  beforeEach(() => parse.mockReset());

  it("retries when a claim gets no verdict, then applies the fixes and logs them on the run", async () => {
    const ids = collectClaims(section).map((c) => c.id);
    parse
      .mockResolvedValueOnce(reply(ids.slice(1).map((id) => result(id, "supported"))))
      .mockResolvedValueOnce(reply(ids.map((id) => (id === "market_gap[1]" ? result(id, "unsupported", "drop") : result(id, "supported")))));
    const r = await runFactcheck(section, store);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(r.section.market_gap).toHaveLength(1);
    expect(r.run).toMatchObject({ stage: "factcheck", prompt_version: "factcheck.v1", model: "claude-haiku-5-5" });
    expect(r.run?.claims?.find((c) => c.id === "market_gap[1]")).toMatchObject({ verdict: "unsupported", action: "dropped" });
    // 2 calls × (5000 in × $0.10 + 1000 out × $0.50) per million.
    expect(r.run?.cost_usd).toBe(0.002);
  });
});
