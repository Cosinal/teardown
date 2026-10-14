"use server";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import { init, sql } from "@/lib/db";
import { startRun } from "@/lib/engine/run";

// Re-runs a failed teardown from its saved input. Earlier stage runs and cost stay on the row.
export async function rerunTeardown(id: string): Promise<void> {
  // Server actions can be invoked from any route, so the admin gate is checked here too.
  if (!isAdminCookie((await cookies()).get(ADMIN_COOKIE)?.value)) notFound();
  await init();
  const rows = await sql()`UPDATE teardowns SET status = 'queued', error = NULL, updated_at = now()
    WHERE id = ${id} AND status = 'failed' RETURNING id`;
  // Scheduled before redirect(), which throws. Runs within the page's maxDuration.
  if (rows.length) after(() => startRun(id));
  redirect(`/t/${id}`);
}
