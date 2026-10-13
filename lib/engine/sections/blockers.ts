import { z } from "zod";
import type { CheckClaim, Fixed, SectionCheck } from "../factcheck";
import { STAGE_MODELS, loadPrompt } from "../llm";
import { sourcesUsed } from "../report";
import type { SourceStore } from "../research";
import { LIMITS } from "../validate";
import { PartSchema, type Part } from "./alternatives";
import { runWriter, type SectionOptions } from "./common";
import type { LaterContext } from "./later";

// Blockers: legal, technical or platform problems that could stop a launch,
// each with a cited or estimated detail. Zero is a valid answer. The key
// figure is the number of high-severity blockers, counted by code; any
// high-severity blocker caps the section's rating at mixed.

export const BLOCKERS_WRITE_PROMPT = "blockers-write.v1";
/** Cited by the scorecard, whose key figure is a count. */
export const BLOCKER_COUNT_METHOD = "Count of the high-severity blockers listed in Blockers";

const ESTIMATE_MAX = 90;

export const BlockersSchema = z.object({
  blockers: z.array(z.object({
    type: z.string(),
    risk: z.string(),
    severity: z.enum(["low", "medium", "high"]),
    detail: PartSchema,
  })),
  scorecard: z.object({ rating: z.enum(["strong", "mixed", "weak"]), finding: z.string() }),
});

export type BlockersSection = z.infer<typeof BlockersSchema>;

/** The section as report fields, still citing SourceStore ids. */
export function blockersReport(b: BlockersSection) {
  const high = b.blockers.filter((x) => x.severity === "high").length;
  const rating = high && b.scorecard.rating === "strong" ? "mixed" : b.scorecard.rating;
  return {
    blockers: b.blockers.map((x) => ({ type: x.type, risk: x.risk, severity: x.severity, detail: x.detail as Part })),
    score: {
      rating,
      key_figure: { value: String(high), unit: "high-severity" },
      finding: b.scorecard.finding,
      part: { text: b.scorecard.finding, source: null, estimate: BLOCKER_COUNT_METHOD } as Part,
    },
  };
}

export function parseBlockers(raw: unknown, ctx: LaterContext, store: SourceStore = ctx.store): BlockersSection {
  const section = BlockersSchema.parse(raw);
  const ids = new Set(store.map((s) => s.id));
  if (section.blockers.length > LIMITS.blockers) throw new Error(`blockers: at most ${LIMITS.blockers}`);
  section.blockers.forEach((b, i) => {
    const path = `blockers[${i}].detail`;
    const d = b.detail;
    if (d.source && d.estimate) throw new Error(`${path}: give a source id or an estimate method, not both`);
    if (!d.source && !d.estimate) throw new Error(`${path}: cite the source that states it, or give the estimate method`);
    if (d.source && !ids.has(d.source)) throw new Error(`${path}: ${d.source} is not in the source list`);
    if (d.estimate && d.estimate.trim().length > ESTIMATE_MAX) throw new Error(`${path}.estimate: longer than ${ESTIMATE_MAX} characters`);
  });
  const sc = section.scorecard;
  if (sc.finding.length > 56) throw new Error(`scorecard.finding: ${sc.finding.length} characters, at most 56`);
  if (/\d/.test(sc.finding)) throw new Error("scorecard.finding: no figures (the key figure carries the number)");

  const { alternatives, demand_evidence, economics } = ctx.drafts;
  const base = { alternatives, demand_evidence, economics };
  const added = sourcesUsed({ ...base, blockers: section }, store, ctx.build) - sourcesUsed(base, store, ctx.build);
  if (added > ctx.budgets.blockers) {
    throw new Error(`cites ${added} sources and estimate methods the report doesn't already list, counting the scorecard's count; the limit is ${ctx.budgets.blockers}`);
  }
  return section;
}

/** Fact-check's view of the section. A blocker whose detail its source doesn't support is reworded or dropped. */
export function blockersCheck(ctx: LaterContext): (store: SourceStore) => SectionCheck<BlockersSection> {
  const index = (id: string) => {
    const m = id.match(/^blockers\[(\d+)\]$/);
    if (!m) throw new Error(`unknown claim id ${id}`);
    return Number(m[1]);
  };
  return (store) => ({
    claims: (section) => section.blockers.flatMap((b, i): CheckClaim[] => (b.detail.source ? [{
      id: `blockers[${i}]`,
      text: b.detail.text,
      source: b.detail.source,
      context: `Blocker "${b.risk}" (${b.type}, ${b.severity} severity): the fact behind it`,
    }] : [])),
    fix(section, id, how, r): Fixed<BlockersSection> | null {
      const i = index(id);
      const s = structuredClone(section);
      const text = r.text?.trim();
      if (how === "rewrite") {
        if (!text) return null;
        s.blockers[i].detail = { ...s.blockers[i].detail, text };
        return { section: s, action: "rewritten", result: text };
      }
      if (how === "estimate") {
        const method = r.method?.trim();
        if (!method) return null;
        s.blockers[i].detail = { text: text || s.blockers[i].detail.text, source: null, estimate: method };
        return { section: s, action: "estimated", result: method };
      }
      s.blockers.splice(i, 1);
      return { section: s, action: "dropped", result: "(blocker dropped)" };
    },
    fallbacks: () => ["drop"],
    rank: (id) => [index(id)],
    row: () => undefined,
    parse: (s) => parseBlockers(s, ctx, store),
  });
}

export function blockersPrompt(ctx: LaterContext): string {
  return loadPrompt(BLOCKERS_WRITE_PROMPT).replaceAll("{{max_sources}}", String(ctx.budgets.blockers));
}

export function writeBlockers(ctx: LaterContext, options: SectionOptions = {}) {
  return runWriter("blockers", {
    model: options.model ?? STAGE_MODELS.blockers,
    context: ctx.context,
    finished: ctx.finished,
    sectionPrompt: blockersPrompt(ctx),
    promptVersion: BLOCKERS_WRITE_PROMPT,
    parse: (json) => parseBlockers(json, ctx),
  });
}
