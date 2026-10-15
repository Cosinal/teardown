import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { IntakeInput } from "./input";
import { BILLING, BILLING_LABEL } from "./input";
import { STAGE_MODELS, ZERO_USAGE, addUsage, anthropic, assertFinished, costUsd, loadPrompt, requestOptions, type StageRun } from "./llm";

export const INTAKE_PROMPT = "intake.v2";

export const QUERY_PURPOSES = ["competitors", "pricing", "customers", "demand", "regulation"] as const;
export const GEO_SCOPES = ["local", "regional", "national", "multi_country", "online"] as const;

// Kept to types and enums only: structured outputs ignore most numeric and
// length constraints, so counts are checked in parseIdeaSpec instead.
export const IdeaSpecSchema = z.object({
  /** Two to four words, used as the report's short name. */
  name: z.string(),
  customer: z.string(),
  problem: z.string(),
  revenue_model: z.object({
    price: z.string(),
    billing: z.enum(BILLING),
    /** How the price is structured, e.g. "per groom, no packages". */
    notes: z.string(),
  }),
  /** The market category a buyer would recognise, e.g. "mobile pet grooming". */
  category: z.string(),
  geography: z.object({
    scope: z.enum(GEO_SCOPES),
    /** Countries, regions or cities, most specific first. Empty when online with no focus. */
    places: z.array(z.string()),
  }),
  search_queries: z.array(z.object({ query: z.string(), purpose: z.enum(QUERY_PURPOSES) })),
  ambiguities: z.array(z.object({
    /** Which part of the input is unclear, e.g. "price". */
    field: z.string(),
    issue: z.string(),
    /** What the spec assumes in the meantime. */
    assumption: z.string(),
  })),
});

export type IdeaSpec = z.infer<typeof IdeaSpecSchema>;

export const QUERY_LIMITS = { min: 4, max: 10 } as const;

/** Validates a spec and checks the limits the schema can't express. */
export function parseIdeaSpec(input: unknown): IdeaSpec {
  const spec = IdeaSpecSchema.parse(input);
  const n = spec.search_queries.length;
  if (n < QUERY_LIMITS.min || n > QUERY_LIMITS.max) {
    throw new Error(`IdeaSpec: expected ${QUERY_LIMITS.min} to ${QUERY_LIMITS.max} search queries, got ${n}`);
  }
  for (const k of ["name", "customer", "problem", "category"] as const) {
    if (!spec[k].trim()) throw new Error(`IdeaSpec: ${k} is empty`);
  }
  return spec;
}

/** Renders the form input as the user message. Missing optional fields are stated, not dropped. */
export function formatInput(input: IntakeInput): string {
  return [
    `Idea: ${input.idea}`,
    `Target customer: ${input.target_customer}`,
    `Price: ${input.price} (${BILLING_LABEL[input.billing]})`,
    `Geography: ${input.geography}`,
    `Known competitors: ${input.known_competitors ?? "(not given)"}`,
    `Biggest worry: ${input.biggest_worry ?? "(not given)"}`,
    `Stage: ${input.stage ?? "(not given)"}`,
  ].join("\n");
}

/** Intake: turns the form input into an IdeaSpec. One structured-output call, no tools. */
export async function runIntake(
  input: IntakeInput,
  { model = STAGE_MODELS.intake }: { model?: string } = {},
): Promise<{ spec: IdeaSpec; run: StageRun }> {
  const started = new Date();
  const msg = await anthropic().messages.parse({
    model,
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(IdeaSpecSchema) },
    system: loadPrompt(INTAKE_PROMPT),
    messages: [{ role: "user", content: formatInput(input) }],
  }, requestOptions());
  assertFinished(msg, "intake");
  if (!msg.parsed_output) throw new Error("intake: no structured output");
  const spec = parseIdeaSpec(msg.parsed_output);
  // The founder's price and billing are taken as entered, never as intake restated them.
  spec.revenue_model = { ...spec.revenue_model, price: input.price, billing: input.billing };
  const usage = addUsage(ZERO_USAGE, msg.usage);
  return {
    spec,
    run: {
      stage: "intake",
      prompt_version: INTAKE_PROMPT,
      model: msg.model,
      usage,
      cost_usd: costUsd(model, usage),
      started_at: started.toISOString(),
      duration_ms: Date.now() - started.getTime(),
    },
  };
}
