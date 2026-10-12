import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { IdeaSpec } from "../intake";
import { STAGE_MODELS, addUsage, anthropic, assertFinished, costUsd, loadPrompt, type StageRun } from "../llm";
import { buildReport, liveSourceBudget } from "../report";
import {
  EXCERPT_MAX, buildSourceStore, normalizeUrl, notesText, searchLoop, searchParams,
  type SearchResponse, type Source, type SourceStore,
} from "../research";

// Existing Alternatives: the section's own web research, then a writer call
// that turns the sources into `alternatives`, `market_gap` and
// `scorecard.alternatives`. The pattern for the other sections.

export const ALTERNATIVES_RESEARCH_PROMPT = "alternatives-research.v1";
export const ALTERNATIVES_WRITE_PROMPT = "alternatives-write.v1";

/** Default web searches for the section's research. Override with the maxSearches option. */
export const ALTERNATIVES_MAX_SEARCHES = 6;
/** Writer calls allowed: the first, plus one retry that is told what failed validation. */
const WRITE_ATTEMPTS = 2;

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
 * Merges a section's new sources into the shared store. Existing ids never
 * change: a page already in the store keeps its id and gains any new quotes;
 * new pages get the next ids. Returns the merged store and the rows that are
 * new or changed, for saving.
 */
export function mergeSources(base: SourceStore, added: SourceStore): { sources: SourceStore; changed: SourceStore } {
  const sources = base.map((s) => ({ ...s }));
  const byUrl = new Map(sources.map((s) => [normalizeUrl(s.url), s]));
  const changed = new Map<string, Source>();
  let next = Math.max(0, ...base.map((s) => Number(s.id.slice(1)) || 0)) + 1;

  for (const a of added) {
    const s = byUrl.get(normalizeUrl(a.url));
    if (!s) {
      const fresh = { ...a, id: `S${next++}` };
      sources.push(fresh);
      byUrl.set(normalizeUrl(a.url), fresh);
      changed.set(fresh.id, fresh);
      continue;
    }
    const quotes = a.excerpt.split(" … ").filter((q) => !s.excerpt.includes(q.replace(/…$/, "")));
    if (!quotes.length || s.excerpt.length >= EXCERPT_MAX) continue;
    const excerpt = [s.excerpt, ...quotes].join(" … ");
    s.excerpt = excerpt.length > EXCERPT_MAX ? `${excerpt.slice(0, EXCERPT_MAX - 1)}…` : excerpt;
    changed.set(s.id, s);
  }
  return { sources, changed: [...changed.values()] };
}

/**
 * Checks the writer's JSON against the section rules and the report's limits.
 * Throws with a message that names the field, so the writer can be told what to fix.
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
    check(a.price, `alternatives[${i}].price`);
    a.weakness.forEach((w, j) => check(w, `alternatives[${i}].weakness[${j}]`));
  });
  section.market_gap.forEach((m, i) => check(m, `market_gap[${i}]`));
  check(section.scorecard, "scorecard");

  if (section.alternatives.filter((a) => a.workaround).length > 1) throw new Error("alternatives: at most one workaround row");
  if (cited.size > maxSources) throw new Error(`cites ${cited.size} distinct sources and estimate methods; the limit is ${maxSources}`);
  // Applies the report's own lengths and counts.
  buildReport(section, store);
  return section;
}

export function researchRequest(spec: IdeaSpec, store: SourceStore, notes: string): string {
  return [
    `Here is the idea spec from intake, as JSON:\n\n${JSON.stringify(spec, null, 2)}`,
    `Pages the first research pass already found:\n\n${store.map((s) => `- ${s.title} (${hostOf(s.url)})`).join("\n")}`,
    `The first pass's notes:\n\n${notes}`,
  ].join("\n\n");
}

export function writeRequest(spec: IdeaSpec, store: SourceStore, notes: string[]): string {
  const sources = store.map((s) => `[${s.id}] ${s.title}\nURL: ${s.url}\nQuoted: ${s.excerpt}`).join("\n\n");
  return [
    `Idea spec, as JSON:\n\n${JSON.stringify(spec, null, 2)}`,
    `Sources:\n\n${sources}`,
    `Research notes:\n\n${notes.filter(Boolean).join("\n\n---\n\n")}`,
  ].join("\n\n");
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export interface AlternativesOptions {
  model?: string;
  maxSearches?: number;
}

/**
 * Runs the section's own searches, merges what they find into the store, and
 * writes the section. Research and writer usage are recorded as one stage run.
 */
export async function runAlternatives(spec: IdeaSpec, store: SourceStore, notes: string, options: AlternativesOptions = {}): Promise<{
  section: AlternativesSection;
  /** The shared store plus this section's new sources. */
  sources: SourceStore;
  /** Rows of `sources` that are new or gained quotes. */
  changed: SourceStore;
  /** The section research's notes, tagged with ids from `sources`. */
  notes: string;
  run: StageRun;
  responses: SearchResponse[];
}> {
  const started = new Date();
  const model = options.model ?? STAGE_MODELS.alternatives;
  const maxSearches = options.maxSearches ?? ALTERNATIVES_MAX_SEARCHES;

  const research = await searchLoop("alternatives", (continuation) => searchParams({
    model, maxSearches, system: loadPrompt(ALTERNATIVES_RESEARCH_PROMPT), request: researchRequest(spec, store, notes),
  }, continuation));
  let usage = research.usage;
  const { sources, changed } = mergeSources(store, buildSourceStore(research.responses));
  const sectionNotes = notesText(research.responses, sources);

  const maxSources = liveSourceBudget();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: writeRequest(spec, sources, [notes, sectionNotes]) }];
  let section: AlternativesSection | undefined;
  for (let attempt = 1; !section; attempt++) {
    const msg = await anthropic().messages.parse({
      model,
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(AlternativesSchema) },
      system: loadPrompt(ALTERNATIVES_WRITE_PROMPT).replaceAll("{{max_sources}}", String(maxSources)),
      messages,
    });
    usage = addUsage(usage, msg.usage);
    assertFinished(msg, "alternatives");
    try {
      section = parseAlternatives(msg.parsed_output, sources, maxSources);
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err);
      if (attempt >= WRITE_ATTEMPTS) throw new Error(`alternatives: writer output invalid: ${problem}`);
      messages.push(
        { role: "assistant", content: JSON.stringify(msg.parsed_output) },
        { role: "user", content: `That JSON failed validation: ${problem}\nFix this and anything like it, and return the whole JSON again.` },
      );
    }
  }

  return {
    section,
    sources,
    changed,
    notes: sectionNotes,
    run: {
      stage: "alternatives",
      prompt_version: `${ALTERNATIVES_RESEARCH_PROMPT}+${ALTERNATIVES_WRITE_PROMPT}`,
      model: research.responses[0].message.model,
      usage,
      cost_usd: costUsd(model, usage),
      started_at: started.toISOString(),
      duration_ms: Date.now() - started.getTime(),
    },
    responses: research.responses,
  };
}
