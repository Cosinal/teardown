"use server";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import { init, sql } from "@/lib/db";
import { IntakeInputSchema } from "@/lib/engine/input";
import { startRun } from "@/lib/engine/run";
import { createTeardown, skipPayment, updateDraft } from "@/lib/engine/store";
import { OWNER_COOKIE_OPTIONS, isOwnerToken, newOwnerToken, ownerCookie, requestOrigin } from "@/lib/payments";
import { createCheckout } from "@/lib/stripe";

export type FormState = { errors: Partial<Record<string, string>>; values: Record<string, string> };

/** The unpaid teardown this browser came back to from a cancelled checkout, if it owns it (or is admin). */
async function ownedDraft(id: string, admin: boolean): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  await init();
  const rows = await sql()`SELECT owner_token_hash FROM teardowns WHERE id = ${id} AND status = 'awaiting_payment'`;
  if (!rows.length) return null;
  const token = (await cookies()).get(ownerCookie(id))?.value;
  return admin || isOwnerToken(token, rows[0].owner_token_hash) ? id : null;
}

// Saves the teardown as awaiting_payment and sends the founder to Stripe
// Checkout; the webhook starts the run once payment completes. An admin can
// skip payment: the run then starts after this response.
export async function submitIdea(_prev: FormState, form: FormData): Promise<FormState> {
  // Server actions can be invoked from any route, so the /new gate is checked here too.
  // The gate stays until /privacy and /data cover intake and payment data (see CLAUDE.md).
  const admin = isAdminCookie((await cookies()).get(ADMIN_COOKIE)?.value);
  if (!admin) notFound();
  const values: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") values[k] = v;

  const parsed = IntakeInputSchema.safeParse({ ...values, stage: values.stage || undefined, billing: values.billing || undefined });
  if (!parsed.success) {
    const errors: FormState["errors"] = {};
    for (const issue of parsed.error.issues) errors[String(issue.path[0])] ??= issue.message;
    return { errors, values };
  }
  const skip = admin && values.skip_payment === "on";

  let id: string;
  try {
    // Back from a cancelled checkout: update that teardown instead of starting another.
    const draft = values.draft ? await ownedDraft(values.draft, admin) : null;
    if (draft && (await updateDraft(draft, parsed.data))) {
      id = draft;
    } else {
      const owner = newOwnerToken();
      id = await createTeardown(parsed.data, owner.hash);
      (await cookies()).set(ownerCookie(id), owner.token, OWNER_COOKIE_OPTIONS);
    }
  } catch (err) {
    console.error("createTeardown failed", err);
    return { errors: { form: "Something went wrong saving your idea. Please try again." }, values };
  }

  if (skip) {
    // Scheduled before redirect(), which throws. Runs within the page's maxDuration.
    if (await skipPayment(id)) after(() => startRun(id));
    redirect(`/t/${id}`);
  }

  let url: string;
  try {
    url = await createCheckout(id, await requestOrigin());
  } catch (err) {
    console.error(`Teardown ${id}: could not create checkout`, err);
    return { errors: { form: "Something went wrong opening checkout. Please try again." }, values: { ...values, draft: id } };
  }
  redirect(url);
}
