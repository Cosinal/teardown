import { afterEach, describe, expect, it, vi } from "vitest";
import { adminCookieValue, isAdminCookie, isAdminKey } from "../lib/admin";

afterEach(() => vi.unstubAllEnvs());

describe("admin gate", () => {
  it("accepts only the exact key", () => {
    vi.stubEnv("ADMIN_KEY", "s3cret");
    expect(isAdminKey("s3cret")).toBe(true);
    expect(isAdminKey("s3cre")).toBe(false);
    expect(isAdminKey("")).toBe(false);
    expect(isAdminKey(null)).toBe(false);
  });

  it("accepts the derived cookie, not the raw key", () => {
    vi.stubEnv("ADMIN_KEY", "s3cret");
    expect(adminCookieValue()).not.toContain("s3cret");
    expect(isAdminCookie(adminCookieValue())).toBe(true);
    expect(isAdminCookie("s3cret")).toBe(false);
    expect(isAdminCookie(undefined)).toBe(false);
  });

  it("fails closed without ADMIN_KEY", () => {
    vi.stubEnv("ADMIN_KEY", "");
    expect(isAdminKey("")).toBe(false);
    expect(isAdminCookie("")).toBe(false);
  });
});
