import { z } from "zod";
import type { Fixed, SectionCheck } from "../factcheck";
import { STAGE_MODELS, loadPrompt } from "../llm";
import { buildPartialReport } from "../report";
import { SPEC_SOURCE, checkFigures, internalRewrite, internalSource, specText } from "./brief";
import { runWriter, type SectionOptions } from "./common";
import type { LaterContext } from "./later";

// The Idea as Understood: the founder's idea restated in one line plus
// customer, problem and revenue, for page 1. It describes, it doesn't judge,
// and it is fact-checked against intake's reading of the founder's own words.
// The name is intake's, set by code.

export const IDEA_WRITE_PROMPT = "idea-write.v1";

export const IdeaSchema = z.object({
  headline: z.string(),
  customer: z.string(),
  problem: z.string(),
  revenue: z.string(),
});

export type IdeaSection = z.infer<typeof IdeaSchema> & { name: string };

const FIELDS = ["headline", "customer", "problem", "revenue"] as const;
const MAX = { headline: 64, customer: 90, problem: 90, revenue: 90 } as const;

export function parseIdea(raw: unknown, ctx: LaterContext): IdeaSection {
  const fields = IdeaSchema.parse(raw);
  for (const k of FIELDS) {
    if (!fields[k].trim()) throw new Error(`${k}: empty`);
    if (fields[k].length > MAX[k]) throw new Error(`${k}: ${fields[k].length} characters, at most ${MAX[k]}`);
    checkFigures(fields[k], ctx.known, k);
  }
  const section = { name: ctx.spec.name.slice(0, 70), ...fields };
  buildPartialReport({ ...ctx.drafts, idea: section }, ctx.store, ctx.build);
  return section;
}

/** The founder's idea as a source, for the fact-check. */
export function ideaSource(ctx: LaterContext) {
  return internalSource(SPEC_SOURCE, "The founder's idea, as intake read it", specText(ctx.spec));
}

/** Fact-check's view: each field against the founder's idea. A field is reworded to fit it, never dropped. */
export function ideaCheck(ctx: LaterContext): () => SectionCheck<IdeaSection> {
  const label = { headline: "the idea in one line", customer: "who the customer is", problem: "the problem it solves", revenue: "how it makes money" };
  return () => ({
    claims: (s) => FIELDS.map((k) => ({ id: k, text: s[k], source: SPEC_SOURCE, context: `The idea as understood, ${label[k]}: a restatement of the founder's idea, which must not add to it. The source is the founder's idea as intake read it.` })),
    fix(section, id, how, r): Fixed<IdeaSection> | null {
      const text = internalRewrite(how, r);
      if (!text) return null;
      return { section: { ...section, [id]: text }, action: "rewritten", result: text };
    },
    fallbacks: () => [],
    rank: (id) => [FIELDS.indexOf(id as (typeof FIELDS)[number])],
    row: () => undefined,
    parse: (s) => parseIdea({ headline: s.headline, customer: s.customer, problem: s.problem, revenue: s.revenue }, ctx),
  });
}

export function writeIdea(ctx: LaterContext, options: SectionOptions = {}) {
  return runWriter("idea", {
    model: options.model ?? STAGE_MODELS.idea,
    context: ctx.context,
    finished: ctx.finished,
    sectionPrompt: loadPrompt(IDEA_WRITE_PROMPT),
    promptVersion: IDEA_WRITE_PROMPT,
    parse: (json) => parseIdea(json, ctx),
  });
}
