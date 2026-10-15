import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, adminCookieValue, isAdminKey } from "@/lib/admin";

// /new?key=ADMIN_KEY or /admin?key=ADMIN_KEY sets the admin cookie and
// redirects to the same path without the key, so it doesn't stay in the
// address bar or history. The pages and their server actions check the cookie
// themselves and 404 without it; this only turns a key into one.
export function proxy(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (key === null || !isAdminKey(key)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.searchParams.delete("key");
  const res = NextResponse.redirect(url);
  res.cookies.set(ADMIN_COOKIE, adminCookieValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    // "/" so /t/<id> sees it too (failed-run errors and re-run).
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

export const config = { matcher: ["/new", "/admin"] };
