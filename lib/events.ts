import { init, sql } from "@/lib/db";

/** First-party site events: public page views and checkout starts. No IP, no cookie, no teardown id. */
export const EVENT_KINDS = ["page_view", "checkout_start"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const REF_RE = /^[A-Za-z0-9._~-]{1,64}$/;
const UTM_RE = /^[\w.-]{1,80}$/;

/** Public page views only. /new is admin-gated today and is never recorded as a view. */
export const PAGE_VIEW_PATHS = ["/", "/privacy", "/data"] as const;
/** Checkout starts: the intake form, or resuming an unpaid checkout. Never a teardown id. */
export const CHECKOUT_PATHS = ["/new", "/t/resume"] as const;

export const EVENT_RETENTION_DAYS = 90;
export const EVENT_MAX_PER_MINUTE = 60;
export const EVENT_MAX_PER_BUCKET_PER_MINUTE = 10;

export type EventInput = {
  kind: unknown;
  path: unknown;
  ref?: unknown;
  referrer?: unknown;
  utm_source?: unknown;
  utm_medium?: unknown;
  utm_campaign?: unknown;
  /** Hostname of this request, so same-site referrers are dropped. */
  selfHost?: string | null;
};

export type SiteEvent = {
  kind: EventKind;
  path: string;
  ref: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
};

function token(v: unknown, re: RegExp): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return re.test(s) ? s : null;
}

/** Referring site as a hostname only. Drops the path, query, our own host, and localhost. */
export function referrerHost(raw: string | null | undefined, selfHost?: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const strip = (h: string) => (h.startsWith("www.") ? h.slice(4) : h).toLowerCase();
    const host = strip(u.hostname);
    if (!host || host === "localhost" || host === "127.0.0.1") return null;
    if (selfHost && host === strip(selfHost.split(":")[0] ?? "")) return null;
    return host.slice(0, 253);
  } catch {
    return null;
  }
}

export function allowedEventPath(kind: EventKind, path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("/admin") || path.includes("\\") || path.includes("..")) return false;
  if (kind === "page_view") return (PAGE_VIEW_PATHS as readonly string[]).includes(path);
  return (CHECKOUT_PATHS as readonly string[]).includes(path);
}

/** Returns a recordable event, or null if the payload should be ignored. */
export function parseEvent(input: EventInput): SiteEvent | null {
  const kind = EVENT_KINDS.find((k) => k === input.kind);
  const path = typeof input.path === "string" ? input.path.trim() : "";
  if (!kind || !allowedEventPath(kind, path)) return null;
  return {
    kind,
    path,
    ref: token(input.ref, REF_RE),
    referrer: referrerHost(typeof input.referrer === "string" ? input.referrer : null, input.selfHost),
    utm_source: token(input.utm_source, UTM_RE),
    utm_medium: token(input.utm_medium, UTM_RE),
    utm_campaign: token(input.utm_campaign, UTM_RE),
  };
}

/** True if another write is allowed given counts already in the last minute. */
export function withinEventLimits(globalCount: number, bucketCount: number): boolean {
  return globalCount < EVENT_MAX_PER_MINUTE && bucketCount < EVENT_MAX_PER_BUCKET_PER_MINUTE;
}

let lastPruneMs = 0;

export function resetEventPruneForTests() {
  lastPruneMs = 0;
}

/** Drops events older than 90 days. Cheap to call often: at most once a minute in-process. */
export async function pruneEvents(force = false): Promise<number> {
  if (!process.env.DATABASE_URL) return 0;
  const now = Date.now();
  if (!force && lastPruneMs && now - lastPruneMs < 60_000) return 0;
  lastPruneMs = now;
  await init();
  const rows = await sql()`DELETE FROM events WHERE created_at < now() - interval '90 days' RETURNING id`;
  return rows.length;
}

/** Writes one event if it is under the per-minute caps. Swallows errors so tracking never breaks a page. */
export async function recordEvent(input: EventInput): Promise<boolean> {
  const event = parseEvent(input);
  if (!event || !process.env.DATABASE_URL) return false;
  try {
    await init();
    await pruneEvents();
    const rows = await sql()`INSERT INTO events (kind, path, ref, referrer, utm_source, utm_medium, utm_campaign)
      SELECT ${event.kind}, ${event.path}, ${event.ref}, ${event.referrer}, ${event.utm_source}, ${event.utm_medium}, ${event.utm_campaign}
      WHERE (SELECT count(*)::int FROM events WHERE created_at > now() - interval '1 minute') < ${EVENT_MAX_PER_MINUTE}
        AND (SELECT count(*)::int FROM events WHERE created_at > now() - interval '1 minute'
          AND kind = ${event.kind} AND path = ${event.path} AND coalesce(ref, '') = coalesce(${event.ref}, '')) < ${EVENT_MAX_PER_BUCKET_PER_MINUTE}
      RETURNING id`;
    return rows.length > 0;
  } catch (err) {
    console.error("recordEvent failed", err);
    return false;
  }
}
