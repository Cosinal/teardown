import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ADMIN_COOKIE, adminCookieValue } from "../lib/admin";
import { assembleDashboard } from "../lib/admin-metrics";
import { proxy } from "../proxy";

const loadDashboard = vi.fn();
vi.mock("../lib/admin-metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/admin-metrics")>()),
  loadDashboard: (...args: unknown[]) => loadDashboard(...args),
}));

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined) }),
}));
class NotFound extends Error {}
vi.mock("next/navigation", () => ({ notFound: () => { throw new NotFound(); } }));

const { default: AdminPage } = await import("../app/admin/page");
const { POST: postEvent } = await import("../app/api/event/route");

beforeEach(() => {
  jar.clear();
  loadDashboard.mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_KEY", "s3cret");
});

describe("admin dashboard gate", () => {
  it("404s without the admin cookie and does not load data", async () => {
    await expect(AdminPage()).rejects.toBeInstanceOf(NotFound);
    expect(loadDashboard).not.toHaveBeenCalled();
  });

  it("404s with the raw key or a forged cookie", async () => {
    jar.set(ADMIN_COOKIE, "s3cret");
    await expect(AdminPage()).rejects.toBeInstanceOf(NotFound);
    jar.set(ADMIN_COOKIE, "forged");
    await expect(AdminPage()).rejects.toBeInstanceOf(NotFound);
    expect(loadDashboard).not.toHaveBeenCalled();
  });

  it("renders for the admin cookie and only then loads metrics", async () => {
    jar.set(ADMIN_COOKIE, adminCookieValue());
    loadDashboard.mockResolvedValue(assembleDashboard([], [], [], new Date("2026-10-15T15:00:00.000Z")));
    const el = await AdminPage();
    expect(loadDashboard).toHaveBeenCalledOnce();
    expect(el.type.name).toBe("Dashboard");
    expect(el.props.data.sales.paid).toBe(0);
    expect(el.props.data.waitlist.total).toBe(0);
  });

  it("fails closed when ADMIN_KEY is unset", async () => {
    vi.stubEnv("ADMIN_KEY", "");
    jar.set(ADMIN_COOKIE, "anything");
    await expect(AdminPage()).rejects.toBeInstanceOf(NotFound);
    expect(loadDashboard).not.toHaveBeenCalled();
  });
});

describe("admin key on /admin", () => {
  it("sets the cookie and strips the key from the URL", () => {
    const res = proxy(new NextRequest("http://localhost:3000/admin?key=s3cret&ref=x"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/admin?ref=x");
    expect(res.cookies.get(ADMIN_COOKIE)?.value).toBe(adminCookieValue());
  });

  it("does not set a cookie for a wrong key", () => {
    const res = proxy(new NextRequest("http://localhost:3000/admin?key=nope"));
    expect(res.status).toBe(200);
    expect(res.cookies.get(ADMIN_COOKIE)).toBeUndefined();
  });
});

describe("event endpoint", () => {
  it("accepts a page view and returns 204 with no body", async () => {
    const res = await postEvent(new Request("https://teardown.test/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "page_view", path: "/", ref: "twitter", referrer: "https://t.co/x" }),
    }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("ignores an admin path and still returns 204", async () => {
    const res = await postEvent(new Request("https://teardown.test/api/event", {
      method: "POST",
      body: JSON.stringify({ kind: "page_view", path: "/admin" }),
    }));
    expect(res.status).toBe(204);
  });
});
