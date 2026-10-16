import { beforeEach, describe, expect, it, vi } from "vitest";
import { addQuotes, applyFactcheck, assembleGap, claimFigures, claimRelevant, claimRequest, collectClaims, figuresOverlap, gapChanged, requireQuote, rowProduct, runFactcheck, sharesTerm, stricter, supportRate, tokens, UNCONFIRMED_PRICE_METHOD, type CheckResult } from "../lib/engine/factcheck";
import { memoryPageCache, type PageResult } from "../lib/engine/fetch";
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

  it("puts one claim's quoted text in its request, and the page text when given", () => {
    const c = collectClaims(section)[0];
    expect(JSON.parse(claimRequest(c, store[0]))).toEqual({
      context: c.context, claim: "Quote only", source: { id: "S1", title: "Page S1", url: "https://s1.example", quoted_text: "Canoe pricing is sales-led." },
    });
    expect(JSON.parse(claimRequest(c, store[0], "Full page")).source.page_text).toBe("Full page");
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
    expect(out.alternatives[1].price).toEqual({ text: "Not public", source: null, estimate: "Seat count × list price per seat" });
  });

  it("turns a dropped price into \"Not public\" when the row still cites a source", () => {
    const { section: out, log } = apply([result("alternatives[0].price", "unsupported", "drop")]);
    expect(out.alternatives[0].price).toEqual(plain("Not public"));
    expect(log.find((l) => l.id === "alternatives[0].price")).toMatchObject({ action: "dropped", result: "Not public" });
  });

  it("logs when a claim was skipped without asking the model", () => {
    const { log } = apply([{ ...result("alternatives[0].price", "unsupported", "drop"), skipped: true }]);
    expect(log.find((l) => l.id === "alternatives[0].price")).toMatchObject({ skipped: true, action: "dropped" });
  });

  it("keeps a named rival when its price citation fails and the weakness is unsourced, as an estimate", () => {
    // WorthBuild-shaped: the cited page is about a different product, so "Not public"
    // would fail (the row has no sourced weakness) and used to delete the whole rival.
    const draft = structuredClone(section);
    draft.alternatives[1].weakness = [plain("Sourcing depth is not shown.")];
    const claims = collectClaims(draft);
    const { section: out, log } = applyFactcheck(
      draft, claims,
      claims.map((c) => (c.id === "alternatives[1].price" ? result(c.id, "unsupported", "drop") : result(c.id, "supported"))),
      store,
    );
    expect(out.alternatives.map((a) => a.name)).toEqual(["Alts data platforms", "LP platforms", "Do it by hand"]);
    expect(out.alternatives[1].price).toEqual({
      text: "Not public", source: null, estimate: UNCONFIRMED_PRICE_METHOD,
    });
    expect(log.find((l) => l.id === "alternatives[1].price")).toMatchObject({ action: "estimated", result: UNCONFIRMED_PRICE_METHOD });
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

  it("keeps a claim the excerpt partly supported when the page's rewrite doesn't fit", () => {
    const { section: out, log } = apply([{ ...result("alternatives[1].price", "unsupported", "rewrite", "x".repeat(80)), basis: "page", excerpt_verdict: "partial" }]);
    expect(out).toEqual(section);
    expect(log.find((l) => l.id === "alternatives[1].price")).toMatchObject({ action: "kept", basis: "page", excerpt_verdict: "partial" });
  });

  it("never drops the scorecard; it falls back to our own summary", () => {
    const { section: out, log } = apply([result("scorecard", "unsupported", "drop")]);
    expect(out.scorecard).toMatchObject({ source: null, estimate: "Our summary of the alternatives listed in this section" });
    expect(log.find((l) => l.id === "scorecard")).toMatchObject({ action: "estimated" });
  });

  it("updates a scorecard that counted the rows when a row is dropped", () => {
    const { section: out } = apply([result("alternatives[1].weakness[0]", "unsupported", "drop")]);
    expect(out.scorecard.key_figure).toEqual({ value: "2", unit: "alternatives" });
  });

  it("logs in section order", () => {
    const { log } = apply([result("alternatives[1].weakness[0]", "unsupported", "drop"), result("market_gap[1]", "unsupported", "drop")]);
    expect(log.map((l) => l.id)).toEqual(claims.map((c) => c.id));
  });
});

describe("gap repair helpers", () => {
  const remaining = [found("Platforms cost $150-500K a year.", "S2"), plain("Below that, there is room.")];

  it("only repairs when a gap claim changed", () => {
    expect(gapChanged([{ id: "market_gap[1]", text: "x", source: "S3", verdict: "unsupported", reason: "", action: "dropped" }])).toBe(true);
    expect(gapChanged([{ id: "alternatives[0].price", text: "x", source: "S1", verdict: "unsupported", reason: "", action: "dropped" }])).toBe(false);
  });

  it("keeps parts by number and adds plain parts, but never plain text with figures", () => {
    expect(assembleGap(remaining, { parts: [{ keep: 0, text: null }, { keep: null, text: "A cheaper tool could fit." }, { keep: null, text: "It costs $24K." }, { keep: 7, text: null }] }))
      .toEqual([remaining[0], plain("A cheaper tool could fit.")]);
    expect(assembleGap(remaining, { parts: [{ keep: null, text: "Up to 3 tools." }] })).toBeNull();
  });

  it("puts back a supported part the reply left out, in its original place", () => {
    expect(assembleGap(remaining, { parts: [{ keep: 1, text: null }] }, [0])).toEqual(remaining);
  });
});

describe("supportRate", () => {
  it("counts each verdict", () => {
    expect(supportRate([{ verdict: "supported" }, { verdict: "partial" }, { verdict: "unsupported" }, { verdict: "supported" }]))
      .toEqual({ checked: 4, supported: 2, partial: 1, unsupported: 1, rate: 0.5 });
  });
});

describe("verdict helpers", () => {
  const judged = (verdict: CheckResult["verdict"], action: CheckResult["action"], quote: string | null, text: string | null = null) =>
    ({ verdict, reason: "r", action, text, method: null, quote });
  const page = "Allvue Systems | $150K-$1.2M | ILPA templates\nPricing starts around $150K annually.";

  it("keeps the stricter verdict, and the first on a tie", () => {
    expect(stricter(judged("supported", "keep", "a"), judged("partial", "keep", "b")).quote).toBe("b");
    expect(stricter(judged("unsupported", "drop", "a"), judged("partial", "keep", "b")).quote).toBe("a");
    expect(stricter(judged("partial", "keep", "a"), judged("partial", "keep", "b")).quote).toBe("a");
  });

  it("accepts a quote that is on the page, ignoring case, spacing and dash style", () => {
    expect(requireQuote(judged("supported", "keep", "allvue systems |  $150K–$1.2M"), page)).toMatchObject({ verdict: "supported" });
  });

  it("downgrades support without a verbatim quote, and withdraws an unquoted rewrite", () => {
    expect(requireQuote(judged("supported", "keep", "Allvue costs $150K to $1.2M a year"), page)).toMatchObject({ verdict: "partial", action: "keep", quote: null });
    expect(requireQuote(judged("supported", "keep", null), page)).toMatchObject({ verdict: "partial" });
    expect(requireQuote(judged("unsupported", "rewrite", null, "From $150K a year"), page)).toMatchObject({ action: "drop", text: null });
    expect(requireQuote(judged("partial", "rewrite", "invented passage here", "From $150K a year"), page)).toMatchObject({ action: "keep", text: null });
    expect(requireQuote(judged("unsupported", "rewrite", "Pricing starts around $150K annually.", "From $150K a year"), page))
      .toMatchObject({ action: "rewrite", text: "From $150K a year" });
  });

  it("adds page quotes to their source's excerpt once, and skips ones already there", () => {
    const claims = collectClaims(section);
    const results: CheckResult[] = claims.map((c) => ({ ...result(c.id, "supported"), basis: "excerpt" }));
    results[2] = { ...results[2], basis: "page", quote: "Allvue starts at $150K." };
    results[3] = { ...results[3], basis: "page", quote: "Allvue starts at $150K." };
    results[4] = { ...results[4], basis: "page", quote: "analysts re-key statements." };
    const { store: next, changed } = addQuotes(store, results, claims);
    expect(changed.map((s) => s.id)).toEqual(["S2"]);
    expect(next[1].excerpt).toBe("Allvue costs $150-500K a year. … Allvue starts at $150K.");
    expect(next[0]).toBe(store[0]);
  });
});

describe("runFactcheck (Anthropic mocked)", () => {
  const usage = { input_tokens: 5000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  type Verdict = { verdict: CheckResult["verdict"]; action?: CheckResult["action"]; text?: string | null; quote?: string | null };
  const reply = (parsed: unknown) => ({ model: "claude-haiku-5-5", stop_reason: "end_turn", usage, parsed_output: parsed, content: [] });
  /** Answers each per-claim call from `judge`, and gap repairs from `gap`. */
  const respond = (judge: (claim: string, page: string | undefined) => Verdict, gap?: unknown) =>
    parse.mockImplementation(async (params: { messages: { content: string }[] }) => {
      const req = JSON.parse(params.messages[0].content);
      if (!("claim" in req)) return reply(gap);
      const v = judge(req.claim, req.source.page_text);
      return reply({ reason: `${v.verdict} because`, action: "keep", text: null, method: null, quote: null, ...v });
    });
  const pageText = "Allvue Systems pricing. Allvue costs $150K to $500K a year for most sponsors. Setup takes about three months.";
  let fetcher: ReturnType<typeof vi.fn<(url: string) => Promise<PageResult>>>;
  beforeEach(() => {
    parse.mockReset();
    fetcher = vi.fn(async () => ({ ok: true as const, text: pageText }));
  });

  it("judges each claim in its own call and fetches nothing when the excerpts support every claim", async () => {
    respond(() => ({ verdict: "supported" }));
    const r = await runFactcheck(section, store, { fetcher });
    expect(parse).toHaveBeenCalledTimes(collectClaims(section).length);
    expect(fetcher).not.toHaveBeenCalled();
    expect(r.run).toMatchObject({ stage: "factcheck", prompt_version: "factcheck.v3", model: "claude-haiku-5-5", pages: [], recheck_cost_usd: 0 });
    // 8 calls × (5000 in × $0.10 + 1000 out × $0.50) per million.
    expect(r.run?.cost_usd).toBe(0.008);
    expect(r.section).toEqual(section);
  });

  it("re-checks a claim the excerpt doesn't support against the fetched page, twice, and keeps it with the page's quote", async () => {
    respond((claim, page) => {
      if (claim !== "Three-month setup") return { verdict: "supported" };
      return page ? { verdict: "supported", quote: "Setup takes about three months." } : { verdict: "unsupported", action: "drop" };
    });
    const r = await runFactcheck(section, store, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(collectClaims(section).length + 2);
    expect(r.section).toEqual(section);
    expect(r.log.find((l) => l.id === "alternatives[1].weakness[0]")).toMatchObject({
      verdict: "supported", excerpt_verdict: "unsupported", basis: "page", quote: "Setup takes about three months.", action: "kept",
    });
    expect(r.changed).toEqual([{ ...store[1], excerpt: "Allvue costs $150-500K a year. … Setup takes about three months." }]);
    expect(r.run?.pages).toEqual([{ source: "S2", url: "https://s2.example", ok: true, cached: false, chars: pageText.length }]);
    expect(r.run?.recheck_cost_usd).toBe(0.002);
  });

  it("keeps the stricter of the two page verdicts, and treats an unquoted \"supported\" as partial", async () => {
    let calls = 0;
    respond((claim, page) => {
      if (claim !== "Three-month setup") return { verdict: "supported" };
      if (!page) return { verdict: "partial" };
      return ++calls === 1 ? { verdict: "supported", quote: "Setup takes about three months." } : { verdict: "supported", quote: "Setup is fast." };
    });
    const r = await runFactcheck(section, store, { fetcher });
    expect(r.log.find((l) => l.id === "alternatives[1].weakness[0]")).toMatchObject({ verdict: "partial", basis: "page", action: "kept" });
    expect(r.changed).toEqual([]);
  });

  it("never drops a claim on the page that the excerpt partly supported, but applies a page rewrite", async () => {
    respond((claim, page) => {
      if (claim === "Three-month setup") return page ? { verdict: "unsupported", action: "drop" } : { verdict: "partial" };
      if (claim === "Quote only") return page ? { verdict: "unsupported", action: "rewrite", text: "Sales-led pricing", quote: "Allvue Systems pricing." } : { verdict: "partial" };
      return { verdict: "supported" };
    });
    const r = await runFactcheck(section, store, { fetcher });
    expect(r.log.find((l) => l.id === "alternatives[1].weakness[0]")).toMatchObject({ verdict: "partial", basis: "excerpt", action: "kept" });
    expect(r.log.find((l) => l.id === "alternatives[1].weakness[0]")?.reason).toContain("Page check: unsupported");
    expect(r.log.find((l) => l.id === "alternatives[0].price")).toMatchObject({ verdict: "unsupported", basis: "page", action: "rewritten", result: "Sales-led pricing" });
  });

  it("fetches each page once per cache, across claims and runs", async () => {
    respond((_claim, page) => (page ? { verdict: "unsupported", action: "drop" } : { verdict: "partial" }));
    const pages = memoryPageCache();
    await runFactcheck(section, store, { fetcher, pages });
    await runFactcheck(section, store, { fetcher, pages });
    expect(fetcher.mock.calls.map((c) => c[0]).sort()).toEqual(["https://s1.example", "https://s2.example", "https://s3.example"]);
  });

  it("without a page, asks a partial claim once more on the excerpt and keeps the stricter verdict", async () => {
    fetcher.mockResolvedValue({ ok: false, error: "HTTP 403" });
    let calls = 0;
    respond((claim) => (claim !== "Three-month setup" ? { verdict: "supported" } : ++calls === 1 ? { verdict: "partial" } : { verdict: "unsupported", action: "drop" }));
    const r = await runFactcheck(section, store, { fetcher });
    expect(r.log.find((l) => l.id === "alternatives[1].weakness[0]")).toMatchObject({ verdict: "unsupported", basis: "excerpt", fetch_error: "HTTP 403" });
    expect(r.run?.pages).toEqual([{ source: "S2", url: "https://s2.example", ok: false, cached: false, error: "HTTP 403" }]);
  });

  it("checks on excerpts only when fetch is off", async () => {
    respond(() => ({ verdict: "partial" }));
    const r = await runFactcheck(section, store, { fetcher, fetch: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(r.results.every((x) => x.basis === "excerpt")).toBe(true);
  });

  it("retries a claim whose reply doesn't parse", async () => {
    respond(() => ({ verdict: "supported" }));
    parse.mockResolvedValueOnce(reply(null));
    const r = await runFactcheck(section, store, { fetcher });
    expect(parse).toHaveBeenCalledTimes(collectClaims(section).length + 1);
    expect(r.results).toHaveLength(collectClaims(section).length);
  });

  it("repairs the market gap when one of its claims is dropped", async () => {
    respond((claim) => (claim === "Platforms cost $150-500K a year." ? { verdict: "unsupported", action: "drop" } : { verdict: "supported" }), { parts: [{ keep: 0, text: null }, { keep: null, text: "So a focused tool has room." }] });
    const r = await runFactcheck(section, store, { fetcher });
    expect(r.section.market_gap).toEqual([found("No reconciliation-only tool exists.", "S3"), plain("So a focused tool has room.")]);
    expect(r.run).toMatchObject({ prompt_version: "factcheck.v3+factcheck-gap.v1", repairs: [{ field: "market_gap" }] });
  });

  it("does not ask the model when the excerpt has none of the claim's figures", async () => {
    const draft = structuredClone(section);
    draft.alternatives[0].price = found("100K members", "S1");
    respond(() => ({ verdict: "supported" }));
    fetcher.mockResolvedValue({ ok: true, text: "Canoe pricing is sales-led. Nothing about members." });
    const r = await runFactcheck(draft, store, { fetcher });
    const price = r.log.find((l) => l.id === "alternatives[0].price");
    expect(price).toMatchObject({ verdict: "unsupported", action: "dropped", result: "Not public", skipped: true });
    expect(r.section.alternatives[0].price).toEqual(plain("Not public"));
    expect(parse.mock.calls.some((c) => JSON.stringify(c[0].messages).includes("100K members"))).toBe(false);
  });
});

describe("claimRelevant", () => {
  const s = (title: string, url: string, excerpt: string) => ({ title, url, excerpt });

  it("reads figures and treats indiehackers as sharing a term with indie-hacker", () => {
    expect(claimFigures("100K Members, 2.9% + 30¢")).toEqual([
      { n: 0.3, kind: "num" }, { n: 100_000, kind: "num" }, { n: 2.9, kind: "pct" },
    ]);
    expect(sharesTerm(tokens("indiehackers"), tokens("indie-hacker-business-statistics"))).toBe(true);
    expect(rowProduct(`Alternatives row "LP platforms" (Allvue): its price`)).toBe("Allvue");
    expect(rowProduct(`Alternatives row "WorthBuild": its price`)).toBe("WorthBuild");
    expect(rowProduct(`Alternatives row "Do it by hand": its weakness`)).toBeUndefined();
  });

  it("treats K/M, commas, percent, cents and number words as the same figure", () => {
    expect(figuresOverlap("$1.2M ARR", "Revenue of 1,200,000 last year")).toBe(true);
    expect(figuresOverlap("$1.2M", "$1.2 million")).toBe(true);
    expect(figuresOverlap("100K members", "100,000 members")).toBe(true);
    expect(figuresOverlap("$50K–$500K a year", "Plans from $50,000")).toBe(true);
    expect(figuresOverlap("2.9% + 30¢", "2.9% plus $0.30")).toBe(true);
    expect(figuresOverlap("3%", "3 percent")).toBe(true);
    expect(figuresOverlap("5-10 hours", "five to ten hours")).toBe(true);
  });

  it("keeps a format-variant claim relevant against excerpt and page text", () => {
    const src = s("Pricing", "https://example.com/pricing", "List price is $1.2 million a year.");
    expect(claimRelevant("$1.2M a year", src, `Alternatives row "Allvue": its price`)).toBe("relevant");
    expect(claimRelevant("100K members", src, "Demand evidence", "The forum has 100,000 members.")).toBe("relevant");
    expect(claimRelevant("30¢ per charge", s("Fees", "https://example.com/fees", "A $0.30 fee applies."), "Economics")).toBe("relevant");
  });

  it("falls through to the model when figures miss but the page has numbers of its own", () => {
    expect(claimRelevant(
      "$1.2M a year",
      s("Pricing", "https://example.com/pricing", "Enterprise plans start at $80,000."),
      "Economics unit cost note",
    )).toBe("unsure");
  });

  it("rejects a 100K forum claim whose excerpt is about something else", () => {
    expect(claimRelevant(
      "100K Members on r/indiehackers",
      s("Women Entrepreneur Ecommerce Statistics", "https://example.com/indie-hacker-business-statistics", "Women-owned ecommerce businesses grew last year."),
      `Demand evidence, signal "Forum members" (forum): the figure 100K and what it counts`,
    )).toBe("skip");
  });

  it("rejects WorthBuild's price against DimeADozen's $9 page", () => {
    expect(claimRelevant(
      "$5",
      s("DimeADozen pricing", "https://dimeadozen.ai/pricing", "Plans start at $9 a report."),
      `Alternatives row "WorthBuild" (worthbuild.com): its price`,
    )).toBe("skip");
  });

  it("does not skip a short product name that produced no tokens", () => {
    expect(tokens("Wix")).toEqual([]);
    expect(tokens("Box")).toEqual([]);
    expect(claimRelevant(
      "Free plan",
      s("Site builders compared", "https://example.com/builders", "Website builders charge monthly."),
      `Alternatives row "Wix": its price`,
    )).toBe("unsure");
    expect(claimRelevant(
      "Per-user pricing",
      s("Cloud storage", "https://example.com/storage", "Cloud storage for teams."),
      `Alternatives row "Box": its price`,
    )).toBe("unsure");
  });

  it("matches Agencies/agency, Directories/directory and validation/validating by stem", () => {
    expect(sharesTerm(tokens("Agencies"), tokens("agency partners"))).toBe(true);
    expect(sharesTerm(tokens("Directories"), tokens("local directory listing"))).toBe(true);
    expect(sharesTerm(tokens("validation"), tokens("validating the idea"))).toBe(true);
    expect(claimRelevant(
      "Slow for agencies",
      s("Agency directory", "https://example.com/agency", "A directory for validating agency leads."),
      `Alternatives row "Agencies": its weakness`,
    )).toBe("relevant");
  });

  it("keeps a card-fee claim whose excerpt has the rate even under an unrelated title", () => {
    expect(claimRelevant(
      "2.9% + 30¢",
      s("How we validate SaaS pricing pages", "https://preuve.ai/blog/fees", "The standard US rate is 2.9% + 30¢ per successful card charge."),
      `Economics unit cost note`,
    )).toBe("relevant");
  });
});
