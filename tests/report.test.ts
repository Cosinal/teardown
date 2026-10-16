import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Report from "@/components/Report";
import { SAMPLE_REPORT } from "../lib/engine/fixtures/sample";
import { buildPartialReport, contentWords, hostLabel, sourceText } from "../lib/engine/report";
import type { SourceStore } from "../lib/engine/research";
import type { AlternativesSection } from "../lib/engine/sections/alternatives";
import { parseReport, stripStoreCites, stripStoreIds } from "../lib/engine/validate";

const src = (id: string, url: string, title: string, excerpt: string) =>
  ({ id, url, title, retrieved_at: "2026-10-12T00:00:00.000Z", excerpt });
const found = (text: string, source: string) => ({ text, source, estimate: null });
const est = (text: string, estimate: string) => ({ text, source: null, estimate });
const plain = (text: string) => ({ text, source: null, estimate: null });

const section = (price: AlternativesSection["alternatives"][number]["price"], extra?: Partial<AlternativesSection>): AlternativesSection => ({
  alternatives: [{
    name: "Fund-ops platforms", examples: "Arcesium", workaround: false,
    what_it_does: "Run the fund back office.",
    price, weakness: [plain("Sold as a whole platform.")],
  }],
  market_gap: [plain("A single-task tool is open.")],
  scorecard: { rating: "mixed", key_figure: { value: "1", unit: "alternatives" }, finding: "Whole platforms, no focused tool.", source: null, estimate: "Count of the alternatives listed" },
  ...extra,
});

describe("stripStoreIds", () => {
  it("drops parenthetical, bracketed and bare store ids", () => {
    expect(stripStoreIds("(S19 median rate)")).toBe("median rate");
    expect(stripStoreIds("Analyst hours [S12] per statement")).toBe("Analyst hours per statement");
    expect(stripStoreIds("From S19 and S2")).toBe("From and");
  });

  it("leaves Amazon S3 and Galaxy S23 in citation-shaped stripping", () => {
    expect(stripStoreCites("Amazon S3 and Galaxy S23")).toBe("Amazon S3 and Galaxy S23");
  });
});

describe("sourceText", () => {
  it("keeps a title that overlaps the excerpt, including the Page S27 fixture", () => {
    expect(sourceText(src("S27", "https://fundops.example/pricing", "Page S27", "Quote from S27"))).toBe("Page S27");
    expect(contentWords("Page S27").has("s27")).toBe(true);
  });

  it("labels a money excerpt by host when the title is about something else", () => {
    expect(sourceText(src(
      "S53", "https://preuve.ai/blog/validation",
      "How we validate SaaS pricing pages",
      "The standard US rate is 2.9% + 30¢ per successful card charge.",
    ))).toMatch(/^preuve\.ai — The standard US rate is 2\.9%/);
    expect(sourceText(src(
      "S66", "https://wearefounders.uk/stripe-fees",
      "Stripe transaction fees in 2026",
      "Vercel Pro is $20 per month for the team plan.",
    ))).toBe("wearefounders.uk — Vercel Pro is $20 per month for the team plan.");
  });

  it("does not switch on a short excerpt or one with no currency mark", () => {
    expect(sourceText(src("S1", "https://a.example/p", "Unrelated title here", "Short note without money"))).toBe("Unrelated title here");
    expect(hostLabel("https://www.preuve.ai/x")).toBe("preuve.ai");
  });
});

describe("buildPartialReport citations", () => {
  const stripe = src("S53", "https://stripe.com/pricing", "Stripe pricing", "Cards are 2.9% + 30¢.");
  const vercel = src("S66", "https://vercel.com/pricing", "Vercel pricing", "Pro is $20 a month.");
  const store: SourceStore = [stripe, vercel];

  const draft = (first: string, second: string): AlternativesSection => ({
    alternatives: [
      {
        name: "Card fees", examples: "Stripe", workaround: false, what_it_does: "Takes a cut of each payment.",
        price: found("2.9% + 30¢", first), weakness: [plain("A cut of every charge.")],
      },
      {
        name: "Host", examples: "Vercel", workaround: false, what_it_does: "Hosts the site.",
        price: found("$20 / month", second), weakness: [plain("A monthly platform fee.")],
      },
    ],
    market_gap: [plain("A cheaper stack is open.")],
    scorecard: { rating: "mixed", key_figure: { value: "2", unit: "alternatives" }, finding: "Fees sit on every sale.", source: first, estimate: null },
  });

  it("numbers sources in order of first use, not store-id order", () => {
    const a = buildPartialReport({ alternatives: draft("S53", "S66") }, store);
    expect(a.sources.map((s) => s.url)).toEqual(["https://stripe.com/pricing", "https://vercel.com/pricing"]);
    expect(a.alternatives![0].price).toMatchObject({ source: 1 });
    expect(a.alternatives![1].price).toMatchObject({ source: 2 });

    const b = buildPartialReport({ alternatives: draft("S66", "S53") }, store);
    expect(b.sources.map((s) => s.url)).toEqual(["https://vercel.com/pricing", "https://stripe.com/pricing"]);
    expect(b.alternatives![0].price).toMatchObject({ source: 1 });
    expect(b.alternatives![1].price).toMatchObject({ source: 2 });
  });

  it("keeps Amazon S3 and Galaxy S23 in idea fields through assemble", () => {
    const report = buildPartialReport(
      {
        alternatives: section(est("$4.80", "median rate of similar tools")),
        idea: {
          name: "Amazon S3 backup",
          headline: "Galaxy S23 photo backup",
          customer: "Phone owners on Amazon S3",
          problem: "Galaxy S23 photos fill the camera roll.",
          revenue: "One-time fee.",
        },
      },
      [src("S1", "https://a.example", "Page S1", "Quote from S1")],
    );
    expect(report.idea).toMatchObject({ name: "Amazon S3 backup", headline: "Galaxy S23 photo backup" });
  });

  it("strips a store id out of an estimate method before the sources page sees it", () => {
    const report = buildPartialReport(
      { alternatives: section(est("$4.80", "(S19 median rate) of similar tools")) },
      [src("S1", "https://a.example", "Page S1", "Quote from S1")],
    );
    expect(report.sources.some((s) => /\bS\d+\b/.test(s.text))).toBe(false);
    expect(report.sources.find((s) => s.basis === "estimated")?.text).toBe("Estimate. median rate of similar tools");
    expect(report.alternatives![0].price).toMatchObject({ text: "$4.80", basis: "estimated" });
  });
});

describe("parseReport store ids", () => {
  it("rejects an estimated source line that still names a store id", () => {
    const report = structuredClone(SAMPLE_REPORT);
    const estimated = report.sources.find((s) => s.basis === "estimated");
    expect(estimated).toBeDefined();
    estimated!.text = "Estimate. (S19 median rate)";
    expect(() => parseReport(report)).toThrow(/source id/);
  });

  it("allows S3 in a found page title", () => {
    const report = structuredClone(SAMPLE_REPORT);
    const foundSource = report.sources.find((s) => s.basis === "found")!;
    foundSource.text = "Amazon S3 pricing";
    expect(parseReport(report).sources.find((s) => s.url === foundSource.url)?.text).toBe("Amazon S3 pricing");
  });

  it("allows Amazon S3 and Galaxy S23 in idea fields and writer prose", () => {
    const report = structuredClone(SAMPLE_REPORT);
    report.idea.name = "Amazon S3 backup for founders";
    report.idea.headline = "Galaxy S23 cases sold as a kit";
    report.alternatives[0].weakness = "Amazon S3 holds Galaxy S23 photos.";
    const parsed = parseReport(report);
    expect(parsed.idea.name).toContain("Amazon S3");
    expect(parsed.idea.headline).toContain("Galaxy S23");
    expect(parsed.alternatives[0].weakness).toBe("Amazon S3 holds Galaxy S23 photos.");
  });

  it("still rejects a citation-shaped store id in writer prose", () => {
    const report = structuredClone(SAMPLE_REPORT);
    report.alternatives[0].weakness = "Holds photos (S12).";
    expect(() => parseReport(report)).toThrow(/source id/);
  });
});

describe("Report branding", () => {
  it("shows Tearitdown in the sheet header and cover eyebrow", () => {
    const html = renderToStaticMarkup(createElement(Report, { report: SAMPLE_REPORT, label: "Sample report" }));
    expect(html).toContain(">Tearitdown</div>");
    expect(html).toContain('class="td-eyebrow">Idea teardown · Sample report</div>');
    expect(html).not.toContain('class="td-eyebrow">Tearitdown');
    expect(html).not.toMatch(/class="td-brand">teardown</);
  });
});
