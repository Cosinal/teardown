import type Anthropic from "@anthropic-ai/sdk";
import type { IdeaSpec } from "../intake";
import { ZERO_USAGE, addUsage, anthropic, assertFinished, costUsd, loadPrompt, type Stage, type StageRun } from "../llm";
import {
  EXCERPT_MAX, buildSourceStore, normalizeUrl, notesText, searchLoop, searchParams,
  type SearchResponse, type Source, type SourceStore,
} from "../research";

// The two halves every section shares: its own research (only when it needs
// fresh data) and a writer call. Writers return JSON as text rather than
// structured output on purpose: a JSON schema is part of the cached prefix, so
// sections with different schemas would each rewrite the whole sources block
// (measured 2026-10-12: ~11k tokens rewritten per schema; no schema, read from
// cache). Our own parsers validate the JSON instead, with one retry.

export const WRITER_SHARED_PROMPT = "writer-shared.v1";

/**
 * Fixed for every writer. Model, effort and thinking settings are part of the
 * cache key, so a section that changed any of them would stop sharing the prefix.
 */
const WRITER_EFFORT = "medium";
/** Writer calls allowed per section: the first, plus one retry that is told what failed. */
const WRITE_ATTEMPTS = 2;

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

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function sectionResearchRequest(spec: IdeaSpec, store: SourceStore, notes: string): string {
  return [
    `Here is the idea spec from intake, as JSON:\n\n${JSON.stringify(spec, null, 2)}`,
    `Pages the first research pass already found:\n\n${store.map((s) => `- ${s.title} (${hostOf(s.url)})`).join("\n")}`,
    `The first pass's notes:\n\n${notes}`,
  ].join("\n\n");
}

export interface SectionResearch {
  /** The shared store plus this section's new sources. */
  sources: SourceStore;
  /** Rows of `sources` that are new or gained quotes. */
  changed: SourceStore;
  /** The section research's notes, tagged with ids from `sources`. Empty when it ran no searches. */
  notes: string;
  /** Null when the section ran no searches. */
  run: StageRun | null;
  responses: SearchResponse[];
}

/**
 * A section's own web research, merged into the shared store. With 0 searches
 * it makes no API call and returns the store unchanged.
 */
export async function runSectionResearch(
  stage: Stage,
  { spec, store, notes, searches, model, prompt }: { spec: IdeaSpec; store: SourceStore; notes: string; searches: number; model: string; prompt: string },
): Promise<SectionResearch> {
  if (searches <= 0) return { sources: store, changed: [], notes: "", run: null, responses: [] };
  const started = new Date();
  const { responses, usage } = await searchLoop(stage, (continuation) => searchParams({
    model, maxSearches: searches, system: loadPrompt(prompt), request: sectionResearchRequest(spec, store, notes),
  }, continuation));
  const { sources, changed } = mergeSources(store, buildSourceStore(responses));
  return {
    sources,
    changed,
    notes: notesText(responses, sources),
    run: {
      stage, step: "research", prompt_version: prompt, model: responses[0].message.model, usage,
      cost_usd: costUsd(model, usage), started_at: started.toISOString(), duration_ms: Date.now() - started.getTime(),
    },
    responses,
  };
}

/**
 * The prefix every section writer shares, cached once per teardown: the
 * writing and citing rules, the spec, every source with its quoted text, and
 * all research notes. Build it after every section's research has run, so it
 * is byte-identical for every writer.
 */
export function writerContext(spec: IdeaSpec, store: SourceStore, notes: { label: string; text: string }[]): string {
  const sources = store.map((s) => `[${s.id}] ${s.title}\nURL: ${s.url}\nQuoted: ${s.excerpt}`).join("\n\n");
  return [
    loadPrompt(WRITER_SHARED_PROMPT),
    `# Idea spec\n\n${JSON.stringify(spec, null, 2)}`,
    `# Sources\n\n${sources}`,
    `# Research notes\n\n${notes.filter((n) => n.text.trim()).map((n) => `## ${n.label}\n\n${n.text}`).join("\n\n")}`,
  ].join("\n\n");
}

/** One writer request: the shared context (cached), then the section's own instructions. */
export function writerParams(
  { model, context, sectionPrompt }: { model: string; context: string; sectionPrompt: string },
  messages: Anthropic.MessageParam[],
  maxTokens = 16000,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: maxTokens,
    output_config: { effort: WRITER_EFFORT },
    system: [
      { type: "text", text: context, cache_control: { type: "ephemeral" } },
      { type: "text", text: sectionPrompt },
    ],
    messages,
  };
}

/** The JSON object in a writer's reply, tolerating a code fence or a sentence around it. */
export function parseJsonText(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in the reply");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`the reply is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

export const WRITE_INSTRUCTION = "Write the section now. Reply with the JSON object only.";

/**
 * Calls a section writer and validates its JSON with `parse`. On a validation
 * error it retries once, telling the writer what failed.
 */
export async function runWriter<T>(
  stage: Stage,
  { model, context, sectionPrompt, promptVersion, parse }: {
    model: string; context: string; sectionPrompt: string; promptVersion: string; parse: (json: unknown) => T;
  },
): Promise<{ value: T; run: StageRun }> {
  const started = new Date();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: WRITE_INSTRUCTION }];
  let usage = ZERO_USAGE;
  let modelId = model;
  for (let attempt = 1; ; attempt++) {
    const msg = await anthropic().messages.create(writerParams({ model, context, sectionPrompt }, messages));
    usage = addUsage(usage, msg.usage);
    modelId = msg.model;
    assertFinished(msg, stage);
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    try {
      const value = parse(parseJsonText(text));
      return {
        value,
        run: {
          stage, step: "write", prompt_version: `${WRITER_SHARED_PROMPT}+${promptVersion}`, model: modelId, usage,
          cost_usd: costUsd(model, usage), started_at: started.toISOString(), duration_ms: Date.now() - started.getTime(),
        },
      };
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err);
      if (attempt >= WRITE_ATTEMPTS) throw new Error(`${stage}: writer output invalid: ${problem}`);
      messages.push(
        { role: "assistant", content: text || "(empty reply)" },
        { role: "user", content: `That JSON failed validation: ${problem}\nFix this and anything like it, and reply with the whole JSON object again.` },
      );
    }
  }
}
