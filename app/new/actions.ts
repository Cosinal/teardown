"use server";

import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import { IntakeInputSchema } from "@/lib/engine/input";
import { startRun } from "@/lib/engine/run";
import { createTeardown } from "@/lib/engine/store";

export type FormState = { errors: Partial<Record<string, string>>; values: Record<string, string> };

// Queues a teardown, sends the founder to its page, and runs the engine after
// the response. The engine is billable: the admin cookie is the gate until payment exists (see CLAUDE.md).
export async function submitIdea(_prev: FormState, form: FormData): Promise<FormState> {
  // Server actions can be invoked from any route, so the /new gate is checked here too.
  if (!isAdminCookie((await cookies()).get(ADMIN_COOKIE)?.value)) notFound();
  const values: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") values[k] = v;

  const parsed = IntakeInputSchema.safeParse({ ...values, stage: values.stage || undefined, billing: values.billing || undefined });
  if (!parsed.success) {
    const errors: FormState["errors"] = {};
    for (const issue of parsed.error.issues) errors[String(issue.path[0])] ??= issue.message;
    return { errors, values };
  }

  let id: string;
  try {
    id = await createTeardown(parsed.data);
  } catch (err) {
    console.error("createTeardown failed", err);
    return { errors: { form: "Something went wrong saving your idea. Please try again." }, values };
  }
  // Scheduled before redirect(), which throws. Runs within the page's maxDuration.
  after(() => startRun(id));
  redirect(`/t/${id}`);
}
