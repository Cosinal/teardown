import { z } from "zod";
import type { SectionCheck } from "../factcheck";
import { STAGE_MODELS, loadPrompt } from "../llm";
import { buildPartialReport } from "../report";
import { LEN, overLen } from "../validate";
import { INTERNAL_NOTE, REPORT_SOURCE, checkFigures, pointsElsewhere } from "./brief";
import { runWriter, type Revision, type SectionOptions } from "./common";
import { THIN } from "./demand";
import type { LaterContext } from "./later";

// Verdict: written last, from the other eight sections after their
// fact-check, with the one-paragraph summaries at the top of pages 2 to 4. It
// may only restate them: no figure the report doesn't already give, and each
// summary is fact-checked against the finished sections, and revised by the
// writer if the check finds a claim they don't fully support. Page 1 must stand
// alone, so the summary can't point to other pages. The call is held to the
// scorecard: no "pursue" on weak or thin evidence.

export const VERDICT_WRITE_PROMPT = "verdict-write.v1";

export const VerdictSchema = z.object({
  call: z.enum(["pursue", "test_first", "drop"]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  page_summaries: z.object({ market: z.string(), business: z.string(), next_steps: z.string() }),
});

export type VerdictSection = z.infer<typeof VerdictSchema>;

const FIELDS = ["summary", "market", "business", "next_steps"] as const;
type Field = (typeof FIELDS)[number];
const get = (s: VerdictSection, k: Field) => (k === "summary" ? s.summary : s.page_summaries[k]);

/** Why "pursue" or high confidence isn't open, or null when it is. */
export function verdictLimits(ctx: LaterContext): { noPursue: string | null; noHigh: string | null } {
  const sc = ctx.report.scorecard ?? {};
  const weak = Object.entries(sc).filter(([, s]) => s?.rating === "weak").map(([k]) => k);
  const thin = !!sc.demand_evidence?.finding.startsWith(THIN);
  return {
    noPursue: weak.length ? `rated weak: ${weak.join(", ")}` : thin ? "demand evidence is thin" : null,
    noHigh: thin ? "demand evidence is thin" : null,
  };
}

export function parseVerdict(raw: unknown, ctx: LaterContext): VerdictSection {
  const section = VerdictSchema.parse(raw);
  for (const k of FIELDS) {
    const v = get(section, k);
    const path = k === "summary" ? "summary" : `page_summaries.${k}`;
    if (!v.trim()) throw new Error(`${path}: empty`);
    if (v.length > LEN.sentence) throw new Error(overLen(path, v.length, LEN.sentence));
    checkFigures(v, ctx.known, path);
  }
  if (pointsElsewhere(section.summary)) throw new Error("summary: page 1 stands alone, so don't refer to other pages or to \"above\" or \"below\"");
  const { noPursue, noHigh } = verdictLimits(ctx);
  if (section.call === "pursue" && noPursue) throw new Error(`call: "pursue" needs no weak section and real demand evidence, but ${noPursue}`);
  if (section.confidence === "high" && noHigh) throw new Error(`confidence: not "high" when ${noHigh}`);
  buildPartialReport({ ...ctx.drafts, verdict: section }, ctx.store, ctx.build);
  return section;
}

/** Fact-check's view: the summary and each page summary judged against the other eight sections. */
export function verdictCheck(ctx: LaterContext): () => SectionCheck<VerdictSection> {
  const context: Record<Field, string> = {
    summary: "The verdict on page 1, which justifies the call and must only restate what the report's sections say",
    market: "The summary at the top of the Market page (Existing Alternatives and Demand Evidence), which must only restate those sections",
    business: "The summary at the top of the Business page (Economics and Distribution), which must only restate those sections",
    next_steps: "The summary at the top of the Next steps page (Blockers, Riskiest assumptions, Next tests), which must only restate those sections",
  };
  return () => ({
    claims: (s) => FIELDS.map((k) => ({ id: k, text: get(s, k), source: REPORT_SOURCE, context: `${context[k]} (call: ${s.call.replace("_", " ")}). ${INTERNAL_NOTE}` })),
    // Judged only: the writer revises (see reviseFeedback in brief.ts).
    fix: () => null,
    fallbacks: () => [],
    rank: (id) => [FIELDS.indexOf(id as Field)],
    row: () => undefined,
    parse: (s) => parseVerdict(s, ctx),
  });
}

export function verdictPrompt(ctx: LaterContext): string {
  const { noPursue, noHigh } = verdictLimits(ctx);
  const limits = [
    noPursue && `"pursue" is not open: ${noPursue}.`,
    noHigh && `"high" confidence is not open: ${noHigh}.`,
  ].filter(Boolean).join(" ");
  return loadPrompt(VERDICT_WRITE_PROMPT).replaceAll("{{limits}}", limits || "Every call is open.");
}

export function writeVerdict(ctx: LaterContext, options: SectionOptions = {}, revise?: Revision) {
  return runWriter("verdict", {
    model: options.model ?? STAGE_MODELS.verdict,
    context: ctx.context,
    finished: ctx.finished,
    sectionPrompt: verdictPrompt(ctx),
    promptVersion: VERDICT_WRITE_PROMPT,
    revise,
    parse: (json) => parseVerdict(json, ctx),
  });
}
