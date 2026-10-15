import { describe, expect, it } from "vitest";
import {
  NEAR_LIMIT_MS,
  assembleDashboard,
  percentile,
  runWallMs,
  utcDay,
  utcWeek,
  type EventRow,
  type SignupRow,
  type TeardownRow,
} from "../lib/admin-metrics";
import { parseEvent, referrerHost } from "../lib/events";

const NOW = new Date("2026-10-15T15:00:00.000Z");

function run(started: string, duration_ms: number) {
  return { stage: "intake" as const, prompt_version: "v1", model: "claude-haiku-5-5", usage: {}, cost_usd: 0, started_at: started, duration_ms };
}

function paid(over: Partial<TeardownRow> & { created_at: string }): TeardownRow {
  return {
    status: "done",
    payment_intent: "pi_1",
    refunded_at: null,
    paid_at: over.created_at,
    amount_cents: 700,
    cost_usd: 0.4,
    stage_runs: [run(over.created_at, 10_000)],
    ...over,
  };
}

describe("time helpers", () => {
  it("utc day and ISO week", () => {
    expect(utcDay(NOW)).toBe("2026-10-15");
    expect(utcWeek(NOW)).toBe("2026-W42");
    expect(utcWeek(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-W01");
  });

  it("percentile is nearest-rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 90)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it("run wall clock spans first start to last end", () => {
    expect(runWallMs([])).toBeNull();
    expect(runWallMs([run("2026-10-15T00:00:00.000Z", 5_000), run("2026-10-15T00:00:04.000Z", 3_000)])).toBe(7_000);
  });
});

describe("sales", () => {
  const rows: TeardownRow[] = [
    paid({ created_at: "2026-10-15T10:00:00.000Z", amount_cents: 700 }),
    paid({ created_at: "2026-10-14T10:00:00.000Z", amount_cents: 700, status: "failed" }),
    paid({ created_at: "2026-10-01T10:00:00.000Z", amount_cents: 900, refunded_at: "2026-10-02T00:00:00.000Z", status: "failed" }),
    { status: "awaiting_payment", created_at: "2026-10-15T11:00:00.000Z", payment_intent: null, refunded_at: null, paid_at: null, amount_cents: null, cost_usd: null, stage_runs: [] },
    { status: "queued", created_at: "2026-10-15T11:30:00.000Z", payment_intent: null, refunded_at: null, paid_at: null, amount_cents: null, cost_usd: null, stage_runs: [] },
    paid({ created_at: "2026-10-15T12:00:00.000Z", amount_cents: null, paid_at: null }),
  ];

  it("counts paid and revenue for today, last 7 days, and all time", () => {
    const { sales } = assembleDashboard(rows, [], [], NOW);
    expect(sales.today).toEqual({ paid: 2, revenueCents: 700, refunds: 0, failed: 0 });
    expect(sales.week).toEqual({ paid: 3, revenueCents: 1400, refunds: 0, failed: 1 });
    expect(sales.all).toEqual({ paid: 4, revenueCents: 2300, refunds: 1, failed: 2 });
    expect(sales.paidWithoutAmount).toBe(1);
    expect(sales.refunds).toBe(1);
    expect(sales.refundCents).toBe(900);
    expect(sales.failedPaid).toBe(2);
  });

  it("conversion is paid / (awaiting_payment or paid), excluding admin skip-payment", () => {
    const { sales } = assembleDashboard(rows, [], [], NOW);
    expect(sales.checkoutStarted).toBe(5);
    expect(sales.paid).toBe(4);
    expect(sales.conversion).toBeCloseTo(0.8);
  });

  it("puts sales on the paid_at day when that is stored", () => {
    const { sales } = assembleDashboard([
      paid({ created_at: "2026-10-01T00:00:00.000Z", paid_at: "2026-10-15T09:00:00.000Z", amount_cents: 500 }),
    ], [], [], NOW);
    expect(sales.today.paid).toBe(1);
    expect(sales.today.revenueCents).toBe(500);
    expect(sales.byDay.find((d) => d.key === "2026-10-15")).toEqual({ key: "2026-10-15", paid: 1, revenueCents: 500 });
  });
});

describe("waitlist", () => {
  const signups: SignupRow[] = [
    { created_at: "2026-10-15T01:00:00.000Z", ref: "twitter" },
    { created_at: "2026-10-15T02:00:00.000Z", ref: "twitter" },
    { created_at: "2026-10-14T02:00:00.000Z", ref: null },
    { created_at: "2026-09-01T02:00:00.000Z", ref: "hn" },
  ];

  it("totals signups by day and source", () => {
    const { waitlist } = assembleDashboard([], signups, [], NOW);
    expect(waitlist.total).toBe(4);
    expect(waitlist.byDay.find((d) => d.key === "2026-10-15")?.count).toBe(2);
    expect(waitlist.byDay.find((d) => d.key === "2026-10-14")?.count).toBe(1);
    expect(waitlist.bySource).toEqual([
      { key: "twitter", count: 2 },
      { key: "(none)", count: 1 },
      { key: "hn", count: 1 },
    ]);
  });
});

describe("runs", () => {
  const rows: TeardownRow[] = [
    paid({
      created_at: "2026-10-10T00:00:00.000Z",
      cost_usd: "0.50",
      stage_runs: [run("2026-10-10T00:00:00.000Z", 100_000), run("2026-10-10T00:01:00.000Z", 50_000)], // wall 110s
    }),
    paid({
      created_at: "2026-10-11T00:00:00.000Z",
      cost_usd: 0.30,
      status: "failed",
      stage_runs: [run("2026-10-11T00:00:00.000Z", NEAR_LIMIT_MS + 1_000)],
    }),
    {
      status: "awaiting_payment",
      created_at: "2026-10-12T00:00:00.000Z",
      payment_intent: null, refunded_at: null, paid_at: null, amount_cents: null, cost_usd: null, stage_runs: [],
    },
  ];

  it("counts ideas, status, cost, runtime percentiles, failure and near-limit", () => {
    const { runs, sales } = assembleDashboard(rows, [], [], NOW);
    expect(runs.ideas).toBe(3);
    expect(runs.byStatus).toEqual([
      { status: "awaiting_payment", count: 1 },
      { status: "done", count: 1 },
      { status: "failed", count: 1 },
    ]);
    expect(runs.avgCostUsd).toBeCloseTo(0.4);
    expect(runs.avgRuntimeMs).toBeCloseTo((110_000 + NEAR_LIMIT_MS + 1_000) / 2);
    expect(runs.p50Ms).toBe(110_000);
    expect(runs.p90Ms).toBe(NEAR_LIMIT_MS + 1_000);
    expect(runs.failureRate).toBeCloseTo(0.5);
    expect(runs.refundRate).toBe(0);
    expect(runs.nearLimit).toBe(1);
    expect(runs.timed).toBe(2);
    expect(sales.failedPaid).toBe(1);
  });
});

describe("traffic", () => {
  const events: EventRow[] = [
    { kind: "page_view", path: "/", ref: "twitter", referrer: "t.co", utm_source: "twitter", utm_medium: "social", utm_campaign: "launch", created_at: NOW },
    { kind: "page_view", path: "/", ref: "twitter", referrer: "t.co", utm_source: "twitter", utm_medium: "social", utm_campaign: "launch", created_at: NOW },
    { kind: "page_view", path: "/privacy", ref: null, referrer: null, utm_source: null, utm_medium: null, utm_campaign: null, created_at: NOW },
    { kind: "checkout_start", path: "/new", ref: "twitter", referrer: null, utm_source: "twitter", utm_medium: "social", utm_campaign: "launch", created_at: NOW },
  ];
  const signups: SignupRow[] = [{ created_at: NOW, ref: "twitter" }, { created_at: NOW, ref: null }];

  it("mixes page views, checkout starts, refs and UTM", () => {
    const { traffic } = assembleDashboard([], signups, events, NOW);
    expect(traffic.pageViews).toBe(3);
    expect(traffic.checkoutStarts).toBe(1);
    expect(traffic.byPath[0]).toEqual({ key: "/", count: 2 });
    expect(traffic.byReferrer[0]).toEqual({ key: "t.co", count: 2 });
    expect(traffic.byRef.find((r) => r.key === "twitter")).toEqual({ key: "twitter", signups: 1, checkouts: 1, views: 2 });
    expect(traffic.byUtm[0]).toMatchObject({ source: "twitter", medium: "social", campaign: "launch", views: 2, checkouts: 1 });
  });
});

describe("event parsing", () => {
  it("keeps a public page view and strips the referrer to a hostname", () => {
    expect(parseEvent({
      kind: "page_view",
      path: "/",
      ref: "twitter",
      referrer: "https://t.co/abc?x=1",
      utm_source: "twitter",
      selfHost: "teardown.ing",
    })).toEqual({
      kind: "page_view",
      path: "/",
      ref: "twitter",
      referrer: "t.co",
      utm_source: "twitter",
      utm_medium: null,
      utm_campaign: null,
    });
  });

  it("drops admin paths, unknown kinds, same-site referrers and junk tokens", () => {
    expect(parseEvent({ kind: "page_view", path: "/admin" })).toBeNull();
    expect(parseEvent({ kind: "page_view", path: "/t/abc" })).toBeNull();
    expect(parseEvent({ kind: "click", path: "/" })).toBeNull();
    expect(parseEvent({ kind: "page_view", path: "/" })?.ref).toBeNull();
    expect(referrerHost("https://teardown.ing/privacy", "teardown.ing")).toBeNull();
    expect(referrerHost("https://www.teardown.ing/", "teardown.ing")).toBeNull();
    expect(parseEvent({ kind: "checkout_start", path: "/new", ref: "has space" })?.ref).toBeNull();
  });

  it("allows a checkout start on /new or a teardown resume path", () => {
    expect(parseEvent({ kind: "checkout_start", path: "/new" })?.kind).toBe("checkout_start");
    expect(parseEvent({ kind: "checkout_start", path: "/t/Ab1_-" })?.path).toBe("/t/Ab1_-");
    expect(parseEvent({ kind: "checkout_start", path: "/t/../x" })).toBeNull();
  });
});
