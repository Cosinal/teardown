"use server";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import { init, sql } from "@/lib/db";
import { startRun } from "@/lib/engine/run";
import { isOwnerToken, ownerCookie, requestOrigin } from "@/lib/payments";
import { createCheckout } from "@/lib/stripe";

// Re-runs a failed teardown from its saved input. Earlier stage runs and cost
// stay on the row. Never charges: a paid row keeps its payment (and its refund, if it was refunded).
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

// "Waiting for payment" -> a fresh Checkout Session for an unpaid teardown, for its owner (or admin).
// If the founder ends up paying twice, the webhook refunds the second payment (lib/payments.ts).
export async function resumeCheckout(id: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound();
  await init();
  const rows = await sql()`SELECT owner_token_hash FROM teardowns WHERE id = ${id} AND status = 'awaiting_payment'`;
  const jar = await cookies();
  const allowed = isAdminCookie(jar.get(ADMIN_COOKIE)?.value) || isOwnerToken(jar.get(ownerCookie(id))?.value, rows[0]?.owner_token_hash);
  if (!allowed) notFound();
  // Already paid (or never existed for this viewer): the page shows where it's at.
  if (!rows.length) redirect(`/t/${id}`);
  redirect(await createCheckout(id, await requestOrigin()));
}
