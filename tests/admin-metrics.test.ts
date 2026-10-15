import { describe, expect, it } from "vitest";
import {
  DASHBOARD_TZ,
  NEAR_LIMIT_MS,
  assembleDashboard,
  latestRunStages,
  percentile,
  runWallMs,
  utcWeek,
  zonedDay,
  zonedWeek,
  type EventCount,
  type SignupRow,
  type TeardownRow,
} from "../lib/admin-metrics";
import { EVENT_MAX_PER_BUCKET_PER_MINUTE, EVENT_MAX_PER_MINUTE, parseEvent, referrerHost, withinEventLimits } from "../lib/events";

const NOW = new Date("2026-10-15T15:00:00.000Z"); // 12:00 America/Halifax

function stage(stage: "intake" | "research", started: string, duration_ms: number) {
  return { stage, prompt_version: "v1", model: "claude-haiku-5-5", usage: {}, cost_usd: 0, started_at: started, duration_ms };
}

function paid(over: Partial<TeardownRow> & { created_at: string }): TeardownRow {
  return {
    status: "done",
    payment_intent: "pi_1",
    refunded_at: null,
    paid_at: over.created_at,
    amount_cents: 700,
    currency: "usd",
    cost_usd: 0.4,
    stage_runs: [stage("intake", over.created_at, 10_000)],
    ...over,
  };
}

describe("time helpers", () => {
  it("uses America/Halifax for the calendar day and ISO week", () => {
    expect(DASHBOARD_TZ).toBe("America/Halifax");
    expect(zonedDay(NOW)).toBe("2026-10-15");
    expect(zonedWeek(NOW)).toBe("2026-W42");
    expect(utcWeek(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-W01");
    // 02:00 UTC on Oct 15 is still Oct 14 in Halifax (ADT, UTC−3).
    expect(zonedDay(new Date("2026-10-15T02:00:00.000Z"))).toBe("2026-10-14");
  });

  it("percentile is nearest-rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 90)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it("run wall clock uses the latest attempt when stage_runs were appended", () => {
    const first = [stage("intake", "2026-10-10T00:00:00.000Z", 100_000), stage("research", "2026-10-10T00:01:00.000Z", 50_000)];
    const second = [stage("intake", "2026-10-11T00:00:00.000Z", 20_000), stage("research", "2026-10-11T00:00:20.000Z", 5_000)];
    expect(runWallMs(first)).toBe(110_000);
    expect(latestRunStages([...first, ...second]).map((r) => r.started_at)).toEqual(["2026-10-11T00:00:00.000Z", "2026-10-11T00:00:20.000Z"]);
    expect(runWallMs([...first, ...second])).toBe(25_000);
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

  it("counts paid and USD revenue for today, last 7 days, and all time", () => {
    const { sales } = assembleDashboard(rows, [], [], NOW);
    expect(sales.today).toEqual({ paid: 2, revenueCents: 700, refunds: 0, refundCents: 0, netRevenueCents: 700, failed: 0 });
    expect(sales.week).toEqual({ paid: 3, revenueCents: 1400, refunds: 0, refundCents: 0, netRevenueCents: 1400, failed: 1 });
    expect(sales.all).toEqual({ paid: 4, revenueCents: 2300, refunds: 1, refundCents: 900, netRevenueCents: 1400, failed: 2 });
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

  it("puts sales on the paid_at Halifax day when that is stored", () => {
    const { sales } = assembleDashboard([
      paid({ created_at: "2026-10-01T00:00:00.000Z", paid_at: "2026-10-15T09:00:00.000Z", amount_cents: 500 }),
    ], [], [], NOW);
    expect(sales.today.paid).toBe(1);
    expect(sales.today.revenueCents).toBe(500);
    expect(sales.byDay.find((d) => d.key === "2026-10-15")).toEqual({ key: "2026-10-15", paid: 1, revenueCents: 500, netRevenueCents: 500 });
  });

  it("counts only USD as USD revenue and flags other currencies", () => {
    const { sales } = assembleDashboard([
      paid({ created_at: "2026-10-15T10:00:00.000Z", amount_cents: 700, currency: "usd" }),
      paid({ created_at: "2026-10-15T11:00:00.000Z", amount_cents: 500, currency: "cad" }),
      paid({ created_at: "2026-10-15T12:00:00.000Z", amount_cents: 300, currency: null }),
    ], [], [], NOW);
    expect(sales.today.revenueCents).toBe(700);
    expect(sales.today.netRevenueCents).toBe(700);
    expect(sales.nonUsd).toEqual([{ currency: "cad", paid: 1, amountCents: 500 }]);
    expect(sales.paidUnknownCurrency).toBe(1);
  });
});

describe("waitlist", () => {
  const signups: SignupRow[] = [
    { created_at: "2026-10-15T16:00:00.000Z", ref: "twitter" },
    { created_at: "2026-10-15T16:00:00.000Z", ref: "twitter" },
    { created_at: "2026-10-14T16:00:00.000Z", ref: null },
    { created_at: "2026-09-01T16:00:00.000Z", ref: "hn" },
  ];

  it("totals signups by Halifax day and source", () => {
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
      stage_runs: [stage("intake", "2026-10-10T00:00:00.000Z", 100_000), stage("research", "2026-10-10T00:01:00.000Z", 50_000)],
    }),
    paid({
      created_at: "2026-10-11T00:00:00.000Z",
      cost_usd: 0.30,
      status: "failed",
      stage_runs: [stage("intake", "2026-10-11T00:00:00.000Z", NEAR_LIMIT_MS + 1_000)],
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
  const events: EventCount[] = [
    { kind: "page_view", path: "/", ref: "twitter", referrer: "t.co", utm_source: "twitter", utm_medium: "social", utm_campaign: "launch", n: 2 },
    { kind: "page_view", path: "/privacy", ref: null, referrer: null, utm_source: null, utm_medium: null, utm_campaign: null, n: 1 },
    { kind: "checkout_start", path: "/new", ref: "twitter", referrer: null, utm_source: "twitter", utm_medium: "social", utm_campaign: "launch", n: 1 },
  ];
  const signups: SignupRow[] = [{ created_at: "2026-10-15T16:00:00.000Z", ref: "twitter" }, { created_at: "2026-10-15T16:00:00.000Z", ref: null }];

  it("mixes page views, checkout starts, refs and UTM from grouped counts", () => {
    const { traffic } = assembleDashboard([], signups, events, NOW);
    expect(traffic.pageViews).toBe(3);
    expect(traffic.checkoutStarts).toBe(1);
    expect(traffic.windowDays).toBe(90);
    expect(traffic.byPath[0]).toEqual({ key: "/", count: 2 });
    expect(traffic.byReferrer[0]).toEqual({ key: "t.co", count: 2 });
    expect(traffic.byRef.find((r) => r.key === "twitter")).toEqual({ key: "twitter", signups: 1, checkouts: 1, views: 2 });
    expect(traffic.byUtm[0]).toMatchObject({ source: "twitter", medium: "social", campaign: "launch", views: 2, checkouts: 1 });
  });
});

describe("event parsing and caps", () => {
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

  it("never stores a teardown id, /new views, or admin paths", () => {
    expect(parseEvent({ kind: "page_view", path: "/admin" })).toBeNull();
    expect(parseEvent({ kind: "page_view", path: "/new" })).toBeNull();
    expect(parseEvent({ kind: "page_view", path: "/t/abc" })).toBeNull();
    expect(parseEvent({ kind: "checkout_start", path: "/t/Ab1_-" })).toBeNull();
    expect(parseEvent({ kind: "checkout_start", path: "/t/resume" })?.path).toBe("/t/resume");
    expect(parseEvent({ kind: "checkout_start", path: "/new" })?.kind).toBe("checkout_start");
    expect(parseEvent({ kind: "click", path: "/" })).toBeNull();
    expect(referrerHost("https://teardown.ing/privacy", "teardown.ing")).toBeNull();
    expect(parseEvent({ kind: "page_view", path: "/", ref: "x".repeat(65) })?.ref).toBeNull();
    expect(parseEvent({ kind: "page_view", path: "/", utm_source: "x".repeat(81) })?.utm_source).toBeNull();
    expect(parseEvent({ kind: "page_view", path: "/", ref: "ok-ref", utm_campaign: "ok" })?.ref).toBe("ok-ref");
  });

  it("caps writes per minute globally and per path+ref bucket", () => {
    expect(EVENT_MAX_PER_MINUTE).toBe(60);
    expect(EVENT_MAX_PER_BUCKET_PER_MINUTE).toBe(10);
    expect(withinEventLimits(0, 0)).toBe(true);
    expect(withinEventLimits(59, 9)).toBe(true);
    expect(withinEventLimits(60, 0)).toBe(false);
    expect(withinEventLimits(0, 10)).toBe(false);
  });
});
