import { isAdminKey } from "@/lib/admin";
import { init, sql, POLICY_VERSION } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REF_RE = /^[A-Za-z0-9._~-]{1,64}$/;

function cleanRef(v: unknown) {
  const s = typeof v === "string" ? v.trim() : "";
  return REF_RE.test(s) ? s : null;
}

// Admin: list all signups. GET /api/subscribe?key=ADMIN_KEY
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (!isAdminKey(params.get("key"))) return Response.json({ error: "unauthorized" }, { status: 401 });
  await init();
  const rows = await sql()`SELECT email, created_at, consent, policy_version, ref FROM signups ORDER BY created_at`;
  return Response.json({ count: rows.length, signups: rows });
}

// Admin: delete one signup. DELETE /api/subscribe?key=ADMIN_KEY&email=...
export async function DELETE(req: Request) {
  const params = new URL(req.url).searchParams;
  if (!isAdminKey(params.get("key"))) return Response.json({ error: "unauthorized" }, { status: 401 });
  await init();
  const email = String(params.get("email") || "").trim().toLowerCase();
  const r = await sql()`DELETE FROM signups WHERE email = ${email} RETURNING id`;
  return Response.json({ deleted: r.length });
}

// Public: join the waitlist. Body: { email, consent: true, ref? }
export async function POST(req: Request) {
  let b: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object") b = parsed;
  } catch {}
  const email = String(b.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return Response.json({ error: "Please enter a valid email." }, { status: 400 });
  if (b.consent !== true) return Response.json({ error: "Please agree to the Privacy Policy to join." }, { status: 400 });
  const ref = cleanRef(b.ref);
  await init();
  const r = await sql()`INSERT INTO signups (email, consent, policy_version, ref) VALUES (${email}, true, ${POLICY_VERSION}, ${ref}) ON CONFLICT (email) DO NOTHING RETURNING id`;
  if (!r.length) return Response.json({ error: "This email is already on the waitlist." }, { status: 409 });
  return Response.json({ ok: true });
}
