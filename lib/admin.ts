import { createHmac, createHash, timingSafeEqual } from "node:crypto";

// ADMIN_KEY checks. Everything fails closed: with no ADMIN_KEY set, nothing is admin.

/** Cookie that unlocks /new after the key has been entered once via /new?key=... */
export const ADMIN_COOKIE = "td_admin";

// Hashing both sides first gives equal-length buffers, so the compare leaks neither content nor length.
function safeEqual(a: string, b: string) {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

export function isAdminKey(key: string | null | undefined): boolean {
  const a = process.env.ADMIN_KEY || "";
  return !!a && typeof key === "string" && safeEqual(key, a);
}

/** The cookie holds an HMAC derived from ADMIN_KEY, never the key itself. Rotating the key revokes it. */
export function adminCookieValue(): string {
  const a = process.env.ADMIN_KEY || "";
  if (!a) throw new Error("ADMIN_KEY is not set");
  return createHmac("sha256", a).update("teardown-admin-cookie-v1").digest("base64url");
}

export function isAdminCookie(value: string | null | undefined): boolean {
  return !!process.env.ADMIN_KEY && typeof value === "string" && safeEqual(value, adminCookieValue());
}
