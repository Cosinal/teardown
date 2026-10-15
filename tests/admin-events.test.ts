import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_COOKIE, adminCookieValue } from "../lib/admin";
import { EVENT_MAX_PER_BUCKET_PER_MINUTE, EVENT_MAX_PER_MINUTE } from "../lib/events";

const queries: { text: string; values: unknown[] }[] = [];
let respond: (text: string, values: unknown[]) => unknown[] = () => [];

vi.mock("@/lib/db", () => ({
  init: async () => {},
  sql: () => {
    const q = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("$").replace(/\s+/g, " ").trim();
      queries.push({ text, values });
      return Promise.resolve().then(() => respond(text, values));
    };
    return q;
  },
}));

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined) }),
}));

const { recordEvent, pruneEvents, resetEventPruneForTests, parseEvent } = await import("../lib/events");
const { loadDashboard } = await import("../lib/admin-metrics");
const { POST: postEvent } = await import("../app/api/event/route");

beforeEach(() => {
  queries.length = 0;
  respond = () => [];
  jar.clear();
  resetEventPruneForTests();
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_KEY", "s3cret");
  vi.stubEnv("DATABASE_URL", "postgres://mock");
});

describe("recordEvent limits", () => {
  it("inserts only when the per-minute caps have room, and prunes 90-day-old rows", async () => {
    respond = (t) => (t.startsWith("INSERT INTO events") ? [{ id: 1 }] : []);
    expect(await recordEvent({ kind: "page_view", path: "/", ref: "twitter" })).toBe(true);
    expect(queries.some((q) => q.text.startsWith("DELETE FROM events WHERE created_at < now() - interval '90 days'"))).toBe(true);
    const insert = queries.find((q) => q.text.startsWith("INSERT INTO events"))!;
    expect(insert.text).toContain("now() - interval '1 minute'");
    expect(insert.values).toContain(EVENT_MAX_PER_MINUTE);
    expect(insert.values).toContain(EVENT_MAX_PER_BUCKET_PER_MINUTE);
    expect(insert.values).toContain("/");
    expect(insert.values).toContain("twitter");
  });

  it("returns false when the insert is limited (no row returned)", async () => {
    respond = (t) => (t.startsWith("DELETE") ? [{ id: 9 }] : []);
    expect(await recordEvent({ kind: "page_view", path: "/" })).toBe(false);
    expect(queries.some((q) => q.text.startsWith("INSERT INTO events"))).toBe(true);
  });

  it("pruneEvents reports how many old rows it dropped", async () => {
    respond = (t) => (t.startsWith("DELETE FROM events") ? [{ id: 1 }, { id: 2 }] : []);
    expect(await pruneEvents(true)).toBe(2);
  });
});

describe("event endpoint skips admin traffic", () => {
  it("does not insert when the admin cookie is present", async () => {
    jar.set(ADMIN_COOKIE, adminCookieValue());
    const res = await postEvent(new Request("https://teardown.test/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "page_view", path: "/", ref: "twitter" }),
    }));
    expect(res.status).toBe(204);
    expect(queries).toEqual([]);
  });

  it("still 204s for a teardown-id path and writes nothing", async () => {
    expect(parseEvent({ kind: "checkout_start", path: "/t/abc123" })).toBeNull();
    const res = await postEvent(new Request("https://teardown.test/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "checkout_start", path: "/t/abc123" }),
    }));
    expect(res.status).toBe(204);
    expect(queries.filter((q) => q.text.startsWith("INSERT"))).toEqual([]);
  });
});

describe("loadDashboard queries", () => {
  it("aggregates events over 90 days and slims stage_runs instead of selecting whole tables", async () => {
    respond = () => [];
    await loadDashboard(new Date("2026-10-15T15:00:00.000Z"));
    const texts = queries.map((q) => q.text);
    expect(texts.some((t) => t.includes("FROM events") && t.includes("interval '90 days'") && t.includes("GROUP BY"))).toBe(true);
    expect(texts.some((t) => t.includes("FROM signups") && t.includes("GROUP BY"))).toBe(true);
    expect(texts.some((t) => t.includes("jsonb_build_object") && t.includes("FROM teardowns"))).toBe(true);
    expect(texts.every((t) => !/\bSELECT \* FROM/.test(t))).toBe(true);
    expect(texts.some((t) => t.includes("idea") || t.includes("report") || t.includes("input"))).toBe(false);
  });
});
