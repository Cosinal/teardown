import { z } from "zod";
import type { Fixed, SectionCheck } from "../factcheck";
import { STAGE_MODELS, loadPrompt } from "../llm";
import type { Assumption, Rating } from "../types";
import { LIMITS } from "../validate";
import { INTERNAL_NOTE, REPORT_SOURCE, checkFigures, internalRewrite, internalSource, pointsElsewhere } from "./brief";
import { runWriter, type SectionOptions } from "./common";
import type { LaterContext } from "./later";

// Riskiest Assumptions: up to three things that must be true, riskiest first.
// Each names the scorecard section whose evidence it rests on, and says what
// that section found. The riskiest must rest on a lowest-rated section, so the
// ranking follows the weakest evidence. The `evidence` line is fact-checked
// against the finished sections; it isn't printed.

export const ASSUMPTIONS_WRITE_PROMPT = "assumptions-write.v1";

export const RESTS_ON = ["alternatives", "demand_evidence", "economics", "distribution", "blockers"] as const;
const LABEL: Record<(typeof RESTS_ON)[number], string> = {
  alternatives: "Existing Alternatives", demand_evidence: "Demand Evidence", economics: "Economics", distribution: "Distribution", blockers: "Blockers",
};

export const AssumptionsSchema = z.object({
  assumptions: z.array(z.object({
    statement: z.string(),
    short: z.string(),
    if_false: z.string(),
    rests_on: z.enum(RESTS_ON),
    evidence: z.string(),
  })),
});

export type AssumptionsSection = z.infer<typeof AssumptionsSchema>;

const ORDER: Record<Rating, number> = { weak: 0, mixed: 1, strong: 2 };

/** Scorecard sections with the lowest rating. */
export function weakestSections(ctx: LaterContext): (typeof RESTS_ON)[number][] {
  const sc = ctx.report.scorecard ?? {};
  const rated = RESTS_ON.filter((k) => sc[k]);
  const low = Math.min(...rated.map((k) => ORDER[sc[k]!.rating]));
  return rated.filter((k) => ORDER[sc[k]!.rating] === low);
}

export function assumptionsReport(a: AssumptionsSection): Assumption[] {
  return a.assumptions.map(({ statement, short, if_false }) => ({ statement, short, if_false }));
}

export function parseAssumptions(raw: unknown, ctx: LaterContext): AssumptionsSection {
  const section = AssumptionsSchema.parse(raw);
  const list = section.assumptions;
  if (!list.length || list.length > LIMITS.riskiest_assumptions) throw new Error(`assumptions: 1 to ${LIMITS.riskiest_assumptions}`);
  list.forEach((a, i) => {
    const path = `assumptions[${i}]`;
    for (const [k, max] of [["statement", 90], ["short", 100], ["if_false", 100], ["evidence", 200]] as const) {
      if (!a[k].trim()) throw new Error(`${path}.${k}: empty`);
      if (a[k].length > max) throw new Error(`${path}.${k}: ${a[k].length} characters, at most ${max}`);
      checkFigures(a[k], ctx.known, `${path}.${k}`);
    }
  });
  if (pointsElsewhere(list[0].short)) throw new Error("assumptions[0].short: it stands alone on page 1, so don't refer to other pages or to \"above\" or \"below\"");
  const weakest = weakestSections(ctx);
  if (!weakest.includes(list[0].rests_on)) {
    throw new Error(`assumptions[0].rests_on: the riskiest assumption must rest on the weakest evidence, a section rated lowest: ${weakest.join(" or ")}`);
  }
  if (new Set(list.map((a) => a.statement)).size < list.length) throw new Error("assumptions: two have the same statement");
  return section;
}

/** The finished sections as a source, for checking each assumption's evidence line. */
export function reportSource(ctx: LaterContext) {
  return internalSource(REPORT_SOURCE, "This report's finished sections", ctx.brief);
}

/** Fact-check's view: each evidence line against the finished sections. Reworded to fit them, never dropped. */
export function assumptionsCheck(ctx: LaterContext): () => SectionCheck<AssumptionsSection> {
  const index = (id: string) => Number(id.match(/^assumptions\[(\d+)\]\.evidence$/)![1]);
  return () => ({
    claims: (s) => s.assumptions.map((a, i) => ({
      id: `assumptions[${i}].evidence`,
      text: a.evidence,
      source: REPORT_SOURCE,
      context: `What the report's ${LABEL[a.rests_on]} section found, as the evidence behind riskiest assumption ${i + 1}: "${a.statement}". ${INTERNAL_NOTE}`,
    })),
    fix(section, id, how, r): Fixed<AssumptionsSection> | null {
      const text = internalRewrite(how, r);
      if (!text) return null;
      const s = structuredClone(section);
      s.assumptions[index(id)].evidence = text;
      return { section: s, action: "rewritten", result: text };
    },
    fallbacks: () => [],
    rank: (id) => [index(id)],
    row: () => undefined,
    parse: (s) => parseAssumptions(s, ctx),
  });
}

export function assumptionsPrompt(ctx: LaterContext): string {
  const sc = ctx.report.scorecard ?? {};
  const ratings = RESTS_ON.filter((k) => sc[k]).map((k) => `${k} (${LABEL[k]}): ${sc[k]!.rating}`).join("; ");
  return loadPrompt(ASSUMPTIONS_WRITE_PROMPT)
    .replaceAll("{{ratings}}", ratings)
    .replaceAll("{{weakest}}", weakestSections(ctx).join(" or "));
}

export function writeAssumptions(ctx: LaterContext, options: SectionOptions = {}) {
  return runWriter("riskiest_assumptions", {
    model: options.model ?? STAGE_MODELS.riskiest_assumptions,
    context: ctx.context,
    finished: ctx.finished,
    sectionPrompt: assumptionsPrompt(ctx),
    promptVersion: ASSUMPTIONS_WRITE_PROMPT,
    parse: (json) => parseAssumptions(json, ctx),
  });
}
