import { z } from "zod";

// What a founder submits on /new. Shared by the form's server action and the engine.

const text = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required.`).max(max, `${label} must be ${max} characters or fewer.`);

const optional = (label: string, max: number) =>
  z.string().trim().max(max, `${label} must be ${max} characters or fewer.`).transform((s) => s || undefined).optional();

export const BILLING = ["one_time", "subscription", "other"] as const;
export const STAGES = ["idea", "building", "launched"] as const;

export const IntakeInputSchema = z.object({
  /** 1 to 3 sentences. */
  idea: text("Idea", 600).refine((s) => s.length >= 10, "Describe the idea in at least one sentence."),
  target_customer: text("Target customer", 200),
  /** As written by the founder, e.g. "$80 per groom". */
  price: text("Price", 80),
  billing: z.enum(BILLING, { error: "Choose one-time, subscription or other." }),
  /** Country or city, or "online". */
  geography: text("Geography", 120),
  known_competitors: optional("Known competitors", 400),
  biggest_worry: optional("Biggest worry", 400),
  stage: z.enum(STAGES).optional(),
});

export type IntakeInput = z.infer<typeof IntakeInputSchema>;
