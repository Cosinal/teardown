import { SAMPLE_REPORT } from "@/lib/engine/fixtures/sample";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/teardown  Body: { idea: string }  ->  TeardownReport
// Returns the sample report. runTeardown is live and billable, so this public
// route must not call it until it is gated behind payment (see CLAUDE.md).
export async function POST(req: Request) {
  let idea = "";
  try {
    const b = await req.json();
    idea = typeof b?.idea === "string" ? b.idea.trim() : "";
  } catch {}
  if (!idea || idea.length > 2000) return Response.json({ error: "Please describe your idea (1–2000 characters)." }, { status: 400 });
  return Response.json(SAMPLE_REPORT);
}
