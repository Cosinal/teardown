import { init, sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public: exposes only the total number of signups.
export async function GET() {
  await init();
  const [r] = await sql()`SELECT count(*)::int AS n FROM signups`;
  return Response.json({ count: r.n as number }, { headers: { "Cache-Control": "no-store" } });
}
