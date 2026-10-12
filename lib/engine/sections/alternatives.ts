import { z } from "zod";
import type { IdeaSpec } from "../intake";
import { STAGE_MODELS, loadPrompt } from "../llm";
import { buildReport, isNotPublic, liveSourceBudget } from "../report";
import type { SourceStore } from "../research";
import { PRICE_NOT_PUBLIC } from "../types";
import { runSectionResearch, runWriter } from "./common";
import { SECTIONS } from "./config";

// Existing Alternatives: the section's own web research, then a writer call
// that turns the sources into `alternatives`, `market_gap` and
// `scorecard.alternatives`. The pattern for the other sections.

export const ALTERNATIVES_RESEARCH_PROMPT = "alternatives-research.v1";
export const ALTERNATIVES_WRITE_PROMPT = "alternatives-write.v3";

/** A text part. `source` is a SourceStore id; `estimate` is the method of our own estimate. Both null: plain text. */
const PartSchema = z.object({ text: z.string(), source: z.string().nullable(), estimate: z.string().nullable() });
export type Part = z.infer<typeof PartSchema>;

// Lengths are left to buildReport, which applies the report's own limits.
export const AlternativesSchema = z.object({
  alternatives: z.array(z.object({
    name: z.string(),
    examples: z.string().nullable(),
    workaround: z.boolean(),
    what_it_does: z.string(),
    price: PartSchema,
    weakness: z.array(PartSchema),
  })),
  market_gap: z.array(PartSchema),
  scorecard: z.object({
    rating: z.enum(["strong", "mixed", "weak"]),
    key_figure: z.object({ value: z.string(), unit: z.string() }),
    finding: z.string(),
    source: z.string().nullable(),
    estimate: z.string().nullable(),
  }),
});

/** The section as written, citing SourceStore ids. Stored as is; numbered only when a report is built. */
export type AlternativesSection = z.infer<typeof AlternativesSchema>;

const ESTIMATE_MAX = 90;

/**
 * Checks the writer's JSON against the section rules and the report's limits,
 * and normalises "Not public" prices. Throws with a message that names the
 * field, so the writer can be told what to fix.
 */
export function parseAlternatives(raw: unknown, store: SourceStore, maxSources = liveSourceBudget()): AlternativesSection {
  const section = AlternativesSchema.parse(raw);
  const ids = new Set(store.map((s) => s.id));
  const cited = new Set<string>();

  const check = (p: { source: string | null; estimate: string | null }, path: string) => {
    if (p.source && p.estimate) throw new Error(`${path}: give a source id or an estimate method, not both`);
    if (p.source) {
      if (!ids.has(p.source)) throw new Error(`${path}: ${p.source} is not in the source list`);
      cited.add(p.source);
    }
    if (p.estimate) {
      if (p.estimate.trim().length > ESTIMATE_MAX) throw new Error(`${path}.estimate: longer than ${ESTIMATE_MAX} characters`);
      cited.add(`estimate:${p.estimate.trim()}`);
    }
  };
  section.alternatives.forEach((a, i) => {
    const path = `alternatives[${i}]`;
    if (isNotPublic(a.price)) {
      a.price = { text: PRICE_NOT_PUBLIC, source: null, estimate: null };
      // A real competitor: something in the row must come from a source.
      if (a.workaround || !a.weakness.some((w) => w.source)) {
        throw new Error(`${path}: a "${PRICE_NOT_PUBLIC}" price needs a product row whose weakness cites a source`);
      }
    }
    check(a.price, `${path}.price`);
    a.weakness.forEach((w, j) => check(w, `${path}.weakness[${j}]`));
  });
  section.market_gap.forEach((m, i) => check(m, `market_gap[${i}]`));
  check(section.scorecard, "scorecard");

  if (section.alternatives.filter((a) => a.workaround).length > 1) throw new Error("alternatives: at most one workaround row");
  if (cited.size > maxSources) throw new Error(`cites ${cited.size} distinct sources and estimate methods; the limit is ${maxSources}`);
  // Applies the report's own lengths and counts.
  buildReport(section, store);
  return section;
}

/** The section's own instructions, after the shared writer context. */
export function alternativesPrompt(maxSources = liveSourceBudget()): string {
  return loadPrompt(ALTERNATIVES_WRITE_PROMPT).replaceAll("{{max_sources}}", String(maxSources));
}

export interface AlternativesOptions {
  model?: string;
  maxSearches?: number;
}

/** The section's own searches, merged into the store. */
export function researchAlternatives(spec: IdeaSpec, store: SourceStore, notes: string, options: AlternativesOptions = {}) {
  return runSectionResearch("alternatives", {
    spec, store, notes,
    searches: options.maxSearches ?? SECTIONS.alternatives.searches,
    model: options.model ?? STAGE_MODELS.alternatives,
    prompt: ALTERNATIVES_RESEARCH_PROMPT,
  });
}

/** Writes the section from the shared writer context. `store` must be the store the context was built from. */
export function writeAlternatives(context: string, store: SourceStore, options: AlternativesOptions = {}) {
  const maxSources = liveSourceBudget();
  return runWriter("alternatives", {
    model: options.model ?? STAGE_MODELS.alternatives,
    context,
    sectionPrompt: alternativesPrompt(maxSources),
    promptVersion: ALTERNATIVES_WRITE_PROMPT,
    parse: (json) => parseAlternatives(json, store, maxSources),
  });
}
