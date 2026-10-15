import { init, sql } from "@/lib/db";
import type { StageRun } from "@/lib/engine/llm";

// Pure aggregation for the admin dashboard, plus the Neon loader.
// The page never selects emails, ideas, reports or errors.

/** Wall-clock time at or above this counts as close to Vercel's 300 s cap (the engine's soft budget). */
export const NEAR_LIMIT_MS = 240_000;
export const DAY_MS = 86_400_000;
const DAY_POINTS = 14;
const WEEK_POINTS = 12;

export type TeardownRow = {
  id?: string;
  status: string;
  created_at: unknown;
  updated_at?: unknown;
  cost_usd: unknown;
  payment_intent: unknown;
  refunded_at: unknown;
  paid_at: unknown;
  amount_cents: unknown;
  stage_runs: unknown;
};

export type SignupRow = { created_at: unknown; ref: unknown };
export type EventRow = {
  kind: unknown;
  path: unknown;
  ref: unknown;
  referrer: unknown;
  utm_source: unknown;
  utm_medium: unknown;
  utm_campaign: unknown;
  created_at: unknown;
};

export type PeriodSales = { paid: number; revenueCents: number; refunds: number; failed: number };
export type CountPoint = { key: string; count: number };
export type SalesPoint = { key: string; paid: number; revenueCents: number };
export type SourceMix = { key: string; signups: number; checkouts: number; views: number };
export type UtmMix = { source: string; medium: string; campaign: string; views: number; checkouts: number };

export type DashboardData = {
  sales: {
    today: PeriodSales;
    week: PeriodSales;
    all: PeriodSales;
    byDay: SalesPoint[];
    byWeek: SalesPoint[];
    checkoutStarted: number;
    paid: number;
    conversion: number | null;
    refunds: number;
    refundCents: number;
    failedPaid: number;
    paidWithoutAmount: number;
  };
  waitlist: { total: number; byDay: CountPoint[]; bySource: CountPoint[] };
  runs: {
    ideas: number;
    byStatus: { status: string; count: number }[];
    avgCostUsd: number | null;
    avgRuntimeMs: number | null;
    p50Ms: number | null;
    p90Ms: number | null;
    failed: number;
    settled: number;
    failureRate: number | null;
    refundRate: number | null;
    nearLimit: number;
    timed: number;
  };
  traffic: {
    pageViews: number;
    checkoutStarts: number;
    byPath: CountPoint[];
    byReferrer: CountPoint[];
    byRef: SourceMix[];
    byUtm: UtmMix[];
  };
};

export function asDate(v: unknown): Date {
  if (v instanceof Date) return v;
  return new Date(typeof v === "string" || typeof v === "number" ? v : NaN);
}

export function asNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO week in UTC, e.g. 2026-W42. */
export function utcWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** Wall-clock span of a run from its stored stage timings, same method as scripts/stage-timings.ts. */
export function runWallMs(stageRuns: unknown): number | null {
  if (!Array.isArray(stageRuns) || !stageRuns.length) return null;
  const runs = stageRuns.filter((r): r is StageRun => {
    if (!r || typeof r !== "object") return false;
    const row = r as StageRun;
    return typeof row.started_at === "string" && typeof row.duration_ms === "number";
  });
  if (!runs.length) return null;
  const t0 = Math.min(...runs.map((r) => Date.parse(r.started_at)));
  const end = Math.max(...runs.map((r) => Date.parse(r.started_at) + r.duration_ms));
  if (!Number.isFinite(t0) || !Number.isFinite(end) || end < t0) return null;
  return end - t0;
}

function rate(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

function sourceKey(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "(none)";
}

function emptyPeriod(): PeriodSales {
  return { paid: 0, revenueCents: 0, refunds: 0, failed: 0 };
}

function dayKeys(now: Date, n: number): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: n }, (_, i) => utcDay(new Date(end - (n - 1 - i) * DAY_MS)));
}

function weekKeys(now: Date, n: number): string[] {
  const keys: string[] = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1) - (n - 1) * 7);
  for (let i = 0; i < n; i++) {
    keys.push(utcWeek(d));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return keys;
}

function topCounts(map: Map<string, number>, n = 15): CountPoint[] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([key, count]) => ({ key, count }));
}

export function assembleDashboard(
  teardowns: TeardownRow[],
  signups: SignupRow[],
  events: EventRow[],
  now = new Date(),
): DashboardData {
  const todayKey = utcDay(now);
  const weekAgo = now.getTime() - 7 * DAY_MS;
  const days = dayKeys(now, DAY_POINTS);
  const weeks = weekKeys(now, WEEK_POINTS);
  const byDay = new Map(days.map((k) => [k, { key: k, paid: 0, revenueCents: 0 }]));
  const byWeek = new Map(weeks.map((k) => [k, { key: k, paid: 0, revenueCents: 0 }]));
  const today = emptyPeriod();
  const week = emptyPeriod();
  const all = emptyPeriod();

  let checkoutStarted = 0;
  let paid = 0;
  let refunds = 0;
  let refundCents = 0;
  let failedPaid = 0;
  let paidWithoutAmount = 0;
  let failed = 0;
  let settled = 0;
  const statusMap = new Map<string, number>();
  const costs: number[] = [];
  const runtimes: number[] = [];

  for (const row of teardowns) {
    const status = typeof row.status === "string" && row.status ? row.status : "unknown";
    statusMap.set(status, (statusMap.get(status) ?? 0) + 1);
    const intent = typeof row.payment_intent === "string" && row.payment_intent ? row.payment_intent : null;
    const isPaid = !!intent;
    const isRefunded = row.refunded_at != null && row.refunded_at !== "";
    if (isPaid || status === "awaiting_payment") checkoutStarted++;
    if (status === "done" || status === "failed") settled++;
    if (status === "failed") failed++;
    if (isPaid && status === "failed") failedPaid++;

    const cost = asNum(row.cost_usd);
    if (cost != null) costs.push(cost);
    const wall = runWallMs(row.stage_runs);
    if (wall != null) runtimes.push(wall);

    if (!isPaid) continue;
    paid++;
    const amount = asNum(row.amount_cents);
    const cents = amount != null && amount >= 0 ? Math.round(amount) : null;
    if (cents == null) paidWithoutAmount++;
    const saleAt = asDate(row.paid_at ?? row.created_at);
    if (Number.isNaN(saleAt.getTime())) continue;
    const day = utcDay(saleAt);
    const wk = utcWeek(saleAt);
    const inToday = day === todayKey;
    const inWeek = saleAt.getTime() >= weekAgo;
    const add = (p: PeriodSales) => {
      p.paid++;
      if (cents != null) p.revenueCents += cents;
      if (isRefunded) p.refunds++;
      if (status === "failed") p.failed++;
    };
    add(all);
    if (inWeek) add(week);
    if (inToday) add(today);
    const dayRow = byDay.get(day);
    if (dayRow) {
      dayRow.paid++;
      if (cents != null) dayRow.revenueCents += cents;
    }
    const weekRow = byWeek.get(wk);
    if (weekRow) {
      weekRow.paid++;
      if (cents != null) weekRow.revenueCents += cents;
    }
    if (isRefunded) {
      refunds++;
      if (cents != null) refundCents += cents;
    }
  }

  const signupDays = new Map(days.map((k) => [k, 0]));
  const signupSources = new Map<string, number>();
  for (const row of signups) {
    const at = asDate(row.created_at);
    if (!Number.isNaN(at.getTime())) {
      const key = utcDay(at);
      if (signupDays.has(key)) signupDays.set(key, (signupDays.get(key) ?? 0) + 1);
    }
    const src = sourceKey(row.ref);
    signupSources.set(src, (signupSources.get(src) ?? 0) + 1);
  }

  const pathMap = new Map<string, number>();
  const referrerMap = new Map<string, number>();
  const refMix = new Map<string, SourceMix>();
  const utmMix = new Map<string, UtmMix>();
  const mix = (key: string) => {
    let row = refMix.get(key);
    if (!row) {
      row = { key, signups: 0, checkouts: 0, views: 0 };
      refMix.set(key, row);
    }
    return row;
  };
  for (const [key, count] of signupSources) mix(key).signups = count;

  let pageViews = 0;
  let checkoutStarts = 0;
  for (const row of events) {
    const kind = row.kind;
    const path = typeof row.path === "string" ? row.path : "";
    const src = sourceKey(row.ref);
    if (kind === "page_view") {
      pageViews++;
      mix(src).views++;
      if (path) pathMap.set(path, (pathMap.get(path) ?? 0) + 1);
      const host = typeof row.referrer === "string" && row.referrer ? row.referrer : "(none)";
      referrerMap.set(host, (referrerMap.get(host) ?? 0) + 1);
    } else if (kind === "checkout_start") {
      checkoutStarts++;
      mix(src).checkouts++;
    }
    const source = typeof row.utm_source === "string" && row.utm_source ? row.utm_source : "";
    const medium = typeof row.utm_medium === "string" && row.utm_medium ? row.utm_medium : "";
    const campaign = typeof row.utm_campaign === "string" && row.utm_campaign ? row.utm_campaign : "";
    if (source || medium || campaign) {
      const key = `${source}|${medium}|${campaign}`;
      let utm = utmMix.get(key);
      if (!utm) {
        utm = { source: source || "(none)", medium: medium || "(none)", campaign: campaign || "(none)", views: 0, checkouts: 0 };
        utmMix.set(key, utm);
      }
      if (kind === "page_view") utm.views++;
      if (kind === "checkout_start") utm.checkouts++;
    }
  }

  const timed = runtimes.length;
  const sorted = runtimes.toSorted((a, b) => a - b);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    sales: {
      today, week, all,
      byDay: days.map((k) => byDay.get(k)!),
      byWeek: weeks.map((k) => byWeek.get(k)!),
      checkoutStarted, paid,
      conversion: rate(paid, checkoutStarted),
      refunds, refundCents, failedPaid, paidWithoutAmount,
    },
    waitlist: {
      total: signups.length,
      byDay: days.map((k) => ({ key: k, count: signupDays.get(k) ?? 0 })),
      bySource: topCounts(signupSources),
    },
    runs: {
      ideas: teardowns.length,
      byStatus: [...statusMap.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([status, count]) => ({ status, count })),
      avgCostUsd: avg(costs),
      avgRuntimeMs: avg(runtimes),
      p50Ms: percentile(sorted, 50),
      p90Ms: percentile(sorted, 90),
      failed, settled,
      failureRate: rate(failed, settled),
      refundRate: rate(refunds, paid),
      nearLimit: runtimes.filter((ms) => ms >= NEAR_LIMIT_MS).length,
      timed,
    },
    traffic: {
      pageViews, checkoutStarts,
      byPath: topCounts(pathMap),
      byReferrer: topCounts(referrerMap),
      byRef: [...refMix.values()].sort((a, b) => (b.signups + b.checkouts + b.views) - (a.signups + a.checkouts + a.views) || a.key.localeCompare(b.key)).slice(0, 15),
      byUtm: [...utmMix.values()].sort((a, b) => (b.views + b.checkouts) - (a.views + a.checkouts) || a.source.localeCompare(b.source)).slice(0, 15),
    },
  };
}

export async function loadDashboard(now = new Date()): Promise<DashboardData> {
  if (!process.env.DATABASE_URL) return assembleDashboard([], [], [], now);
  await init();
  const q = sql();
  const [teardowns, signups, events] = await Promise.all([
    q`SELECT id, status, created_at, updated_at, cost_usd, payment_intent, refunded_at, paid_at, amount_cents, stage_runs FROM teardowns`,
    q`SELECT created_at, ref FROM signups`,
    q`SELECT kind, path, ref, referrer, utm_source, utm_medium, utm_campaign, created_at FROM events`,
  ]);
  return assembleDashboard(teardowns as TeardownRow[], signups as SignupRow[], events as EventRow[], now);
}
