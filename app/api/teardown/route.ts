import { runTeardown } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/teardown  Body: { idea: string }  ->  TeardownReport
// Currently returns the stub report from lib/engine. Gate this (auth/payment)
// before runTeardown does real, billable work.
export async function POST(req: Request) {
  let idea = "";
  try {
    const b = await req.json();
    idea = typeof b?.idea === "string" ? b.idea.trim() : "";
  } catch {}
  if (!idea || idea.length > 2000) return Response.json({ error: "Please describe your idea (1–2000 characters)." }, { status: 400 });
  return Response.json(await runTeardown(idea));
}
