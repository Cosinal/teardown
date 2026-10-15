import { init, sql } from "@/lib/db";

/** First-party site events: public page views and checkout starts. No IP, no cookie. */
export const EVENT_KINDS = ["page_view", "checkout_start"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const REF_RE = /^[A-Za-z0-9._~-]{1,64}$/;
const UTM_RE = /^[\w.-]{1,80}$/;
const PAGE_VIEW_PATHS = new Set(["/", "/privacy", "/data", "/new"]);

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
  if (kind === "page_view") return PAGE_VIEW_PATHS.has(path);
  return path === "/new" || /^\/t\/[A-Za-z0-9_-]{1,64}$/.test(path);
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

/** Writes one event. Swallows errors so a tracking miss never breaks checkout or the page. */
export async function recordEvent(input: EventInput): Promise<boolean> {
  const event = parseEvent(input);
  if (!event || !process.env.DATABASE_URL) return false;
  try {
    await init();
    await sql()`INSERT INTO events (kind, path, ref, referrer, utm_source, utm_medium, utm_campaign)
      VALUES (${event.kind}, ${event.path}, ${event.ref}, ${event.referrer}, ${event.utm_source}, ${event.utm_medium}, ${event.utm_campaign})`;
    return true;
  } catch (err) {
    console.error("recordEvent failed", err);
    return false;
  }
}
