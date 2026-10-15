import { init, sql } from "@/lib/db";
import { EVENT_RETENTION_DAYS, pruneEvents } from "@/lib/events";
import type { StageRun } from "@/lib/engine/llm";

// Pure aggregation for the admin dashboard, plus the Neon loader.
// The page never selects emails, ideas, reports or errors.

/** Wall-clock time at or above this counts as close to Vercel's 300 s cap (the engine's soft budget). */
export const NEAR_LIMIT_MS = 240_000;
export const DAY_MS = 86_400_000;
export const DASHBOARD_TZ = "America/Halifax";
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
  currency?: unknown;
  stage_runs: unknown;
};

export type SignupRow = { created_at?: unknown; day?: unknown; ref: unknown; n?: unknown };
export type EventCount = {
  kind: unknown;
  path: unknown;
  ref: unknown;
  referrer: unknown;
  utm_source: unknown;
  utm_medium: unknown;
  utm_campaign: unknown;
  n?: unknown;
};

export type PeriodSales = {
  paid: number;
  revenueCents: number;
  refunds: number;
  refundCents: number;
  netRevenueCents: number;
  failed: number;
};
export type CountPoint = { key: string; count: number };
export type SalesPoint = { key: string; paid: number; revenueCents: number; netRevenueCents: number };
export type SourceMix = { key: string; signups: number; checkouts: number; views: number };
export type UtmMix = { source: string; medium: string; campaign: string; views: number; checkouts: number };
export type CurrencyMix = { currency: string; paid: number; amountCents: number };

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
    paidUnknownCurrency: number;
    nonUsd: CurrencyMix[];
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
    windowDays: number;
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

/** Calendar day in America/Halifax, e.g. 2026-10-15. */
export function zonedDay(d: Date, timeZone = DASHBOARD_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** ISO week of the America/Halifax calendar date, e.g. 2026-W42. */
export function zonedWeek(d: Date, timeZone = DASHBOARD_TZ): string {
  return isoWeekFromYmd(zonedDay(d, timeZone));
}

export function utcWeek(d: Date): string {
  return isoWeekFromYmd(utcDay(d));
}

function isoWeekFromYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function addYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function parseStageRuns(stageRuns: unknown): StageRun[] {
  if (!Array.isArray(stageRuns)) return [];
  return stageRuns.filter((r): r is StageRun => {
    if (!r || typeof r !== "object") return false;
    const row = r as StageRun;
    return typeof row.started_at === "string" && typeof row.duration_ms === "number";
  }).toSorted((a, b) => a.started_at.localeCompare(b.started_at));
}

/**
 * Re-runs append to stage_runs (lib/engine/store.ts). A new attempt starts at
 * the last `intake` row; older attempts are ignored for wall time.
 */
export function latestRunStages(stageRuns: unknown): StageRun[] {
  const runs = parseStageRuns(stageRuns);
  if (!runs.length) return [];
  let start = 0;
  for (let i = 0; i < runs.length; i++) if (runs[i].stage === "intake") start = i;
  return runs.slice(start);
}

/** Wall-clock span of the latest attempt from stored stage timings. */
export function runWallMs(stageRuns: unknown): number | null {
  const runs = latestRunStages(stageRuns);
  if (!runs.length) return null;
  const t0 = Date.parse(runs[0].started_at);
  const end = Math.max(...runs.map((r) => Date.parse(r.started_at) + r.duration_ms));
  if (!Number.isFinite(t0) || !Number.isFinite(end) || end < t0) return null;
  return end - t0;
}

export function isUsd(currency: unknown): boolean {
  return typeof currency === "string" && currency.trim().toLowerCase() === "usd";
}

function rate(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

function sourceKey(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "(none)";
}

function emptyPeriod(): PeriodSales {
  return { paid: 0, revenueCents: 0, refunds: 0, refundCents: 0, netRevenueCents: 0, failed: 0 };
}

function finishPeriod(p: PeriodSales) {
  p.netRevenueCents = p.revenueCents - p.refundCents;
  return p;
}

function dayKeys(today: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addYmd(today, -(n - 1 - i)));
}

function weekKeys(today: string, n: number): string[] {
  const keys: string[] = [];
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (day - 1) - (n - 1) * 7);
  for (let i = 0; i < n; i++) {
    keys.push(isoWeekFromYmd(date.toISOString().slice(0, 10)));
    date.setUTCDate(date.getUTCDate() + 7);
  }
  return keys;
}

function topCounts(map: Map<string, number>, n = 15): CountPoint[] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([key, count]) => ({ key, count }));
}

function eventN(row: EventCount): number {
  const n = asNum(row.n);
  return n != null && n > 0 ? Math.round(n) : 1;
}

function signupN(row: SignupRow): number {
  const n = asNum(row.n);
  return n != null && n > 0 ? Math.round(n) : 1;
}

function signupDay(row: SignupRow): string | null {
  if (typeof row.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.day)) return row.day;
  if (row.created_at == null) return null;
  const at = asDate(row.created_at);
  return Number.isNaN(at.getTime()) ? null : zonedDay(at);
}

export function assembleDashboard(
  teardowns: TeardownRow[],
  signups: SignupRow[],
  events: EventCount[],
  now = new Date(),
): DashboardData {
  const todayKey = zonedDay(now);
  const weekStart = addYmd(todayKey, -6);
  const days = dayKeys(todayKey, DAY_POINTS);
  const weeks = weekKeys(todayKey, WEEK_POINTS);
  const byDay = new Map(days.map((k) => [k, { key: k, paid: 0, revenueCents: 0, netRevenueCents: 0 }]));
  const byWeek = new Map(weeks.map((k) => [k, { key: k, paid: 0, revenueCents: 0, netRevenueCents: 0 }]));
  const today = emptyPeriod();
  const week = emptyPeriod();
  const all = emptyPeriod();

  let checkoutStarted = 0;
  let paid = 0;
  let refunds = 0;
  let refundCents = 0;
  let failedPaid = 0;
  let paidWithoutAmount = 0;
  let paidUnknownCurrency = 0;
  let failed = 0;
  let settled = 0;
  const statusMap = new Map<string, number>();
  const costs: number[] = [];
  const runtimes: number[] = [];
  const nonUsdMap = new Map<string, CurrencyMix>();

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
    const usd = isUsd(row.currency);
    if (cents != null && !usd) {
      if (typeof row.currency === "string" && row.currency.trim()) {
        const cur = row.currency.trim().toLowerCase();
        const mix = nonUsdMap.get(cur) ?? { currency: cur, paid: 0, amountCents: 0 };
        mix.paid++;
        mix.amountCents += cents;
        nonUsdMap.set(cur, mix);
      } else {
        paidUnknownCurrency++;
      }
    }
    const usdCents = usd ? cents : null;
    const saleAt = asDate(row.paid_at ?? row.created_at);
    if (Number.isNaN(saleAt.getTime())) continue;
    const day = zonedDay(saleAt);
    const wk = zonedWeek(saleAt);
    const inToday = day === todayKey;
    const inWeek = day >= weekStart && day <= todayKey;
    const add = (p: PeriodSales) => {
      p.paid++;
      if (usdCents != null) p.revenueCents += usdCents;
      if (isRefunded) {
        p.refunds++;
        if (usdCents != null) p.refundCents += usdCents;
      }
      if (status === "failed") p.failed++;
    };
    add(all);
    if (inWeek) add(week);
    if (inToday) add(today);
    const dayRow = byDay.get(day);
    if (dayRow) {
      dayRow.paid++;
      if (usdCents != null) {
        dayRow.revenueCents += usdCents;
        if (isRefunded) dayRow.netRevenueCents -= usdCents;
      }
    }
    const weekRow = byWeek.get(wk);
    if (weekRow) {
      weekRow.paid++;
      if (usdCents != null) {
        weekRow.revenueCents += usdCents;
        if (isRefunded) weekRow.netRevenueCents -= usdCents;
      }
    }
    if (isRefunded) {
      refunds++;
      if (usdCents != null) refundCents += usdCents;
    }
  }

  for (const row of byDay.values()) row.netRevenueCents += row.revenueCents;
  for (const row of byWeek.values()) row.netRevenueCents += row.revenueCents;
  finishPeriod(today);
  finishPeriod(week);
  finishPeriod(all);

  const signupDays = new Map(days.map((k) => [k, 0]));
  const signupSources = new Map<string, number>();
  let signupTotal = 0;
  for (const row of signups) {
    const n = signupN(row);
    signupTotal += n;
    const day = signupDay(row);
    if (day && signupDays.has(day)) signupDays.set(day, (signupDays.get(day) ?? 0) + n);
    const src = sourceKey(row.ref);
    signupSources.set(src, (signupSources.get(src) ?? 0) + n);
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
    const n = eventN(row);
    if (kind === "page_view") {
      pageViews += n;
      mix(src).views += n;
      if (path) pathMap.set(path, (pathMap.get(path) ?? 0) + n);
      const host = typeof row.referrer === "string" && row.referrer ? row.referrer : "(none)";
      referrerMap.set(host, (referrerMap.get(host) ?? 0) + n);
    } else if (kind === "checkout_start") {
      checkoutStarts += n;
      mix(src).checkouts += n;
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
      if (kind === "page_view") utm.views += n;
      if (kind === "checkout_start") utm.checkouts += n;
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
      refunds, refundCents, failedPaid, paidWithoutAmount, paidUnknownCurrency,
      nonUsd: [...nonUsdMap.values()].sort((a, b) => b.paid - a.paid || a.currency.localeCompare(b.currency)),
    },
    waitlist: {
      total: signupTotal,
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
      windowDays: EVENT_RETENTION_DAYS,
    },
  };
}

export async function loadDashboard(now = new Date()): Promise<DashboardData> {
  if (!process.env.DATABASE_URL) return assembleDashboard([], [], [], now);
  await init();
  await pruneEvents();
  const q = sql();
  const [teardowns, signups, events] = await Promise.all([
    q`SELECT status, created_at, cost_usd, payment_intent, refunded_at, paid_at, amount_cents, currency,
        (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'stage', e->>'stage', 'started_at', e->>'started_at', 'duration_ms', (e->>'duration_ms')::int
        ) ORDER BY e->>'started_at'), '[]'::jsonb)
         FROM jsonb_array_elements(coalesce(stage_runs, '[]'::jsonb)) e) AS stage_runs
      FROM teardowns`,
    q`SELECT to_char(timezone('America/Halifax', created_at), 'YYYY-MM-DD') AS day, ref, count(*)::int AS n
      FROM signups GROUP BY 1, 2`,
    q`SELECT kind, path, ref, referrer, utm_source, utm_medium, utm_campaign, count(*)::int AS n
      FROM events WHERE created_at > now() - interval '90 days'
      GROUP BY 1, 2, 3, 4, 5, 6, 7`,
  ]);
  return assembleDashboard(teardowns as TeardownRow[], signups as SignupRow[], events as EventCount[], now);
}
