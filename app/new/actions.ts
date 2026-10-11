"use server";

import { redirect } from "next/navigation";
import { IntakeInputSchema } from "@/lib/engine/input";
import { createTeardown } from "@/lib/engine/store";

export type FormState = { errors: Partial<Record<string, string>>; values: Record<string, string> };

// Queues a teardown and sends the founder to its page. It deliberately does not
// run the engine: that is billable work and waits for payment (see CLAUDE.md).
export async function submitIdea(_prev: FormState, form: FormData): Promise<FormState> {
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
  redirect(`/t/${id}`);
}
