import type Anthropic from "@anthropic-ai/sdk";
import type { IdeaSpec } from "../intake";
import { ZERO_USAGE, addUsage, anthropic, assertFinished, costUsd, loadPrompt, requestOptions, type Stage, type StageRun } from "../llm";
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
/**
 * Writer calls allowed per section: the first, plus two retries that are told
 * what failed. One retry lost whole teardowns (tests/runs-summary.md); no
 * writer in the runs of 2026-10-13/14 needed more than two. A retry only
 * re-reads the cached context, and when the problem is one text field it asks
 * for that field alone (see runWriter), so it is short.
 */
export const WRITE_ATTEMPTS = 3;

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

/** Per-section overrides, e.g. for test runs. Writers must share one model to share the cached context. */
export interface SectionOptions {
  model?: string;
  maxSearches?: number;
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
 * A section's own searches, against the shared research. Null when it runs no
 * searches. The results are merged into the store separately (mergeResearch),
 * so several sections can search at once and still merge in a fixed order.
 */
export async function searchSection(
  stage: Stage,
  { spec, store, notes, searches, model, prompt }: { spec: IdeaSpec; store: SourceStore; notes: string; searches: number; model: string; prompt: string },
): Promise<{ responses: SearchResponse[]; run: StageRun } | null> {
  if (searches <= 0) return null;
  const started = new Date();
  const { responses, usage } = await searchLoop(stage, (continuation) => searchParams({
    model, maxSearches: searches, system: loadPrompt(prompt), request: sectionResearchRequest(spec, store, notes),
  }, continuation));
  return {
    responses,
    run: {
      stage, step: "research", prompt_version: prompt, model: responses[0].message.model, usage,
      cost_usd: costUsd(model, usage), started_at: started.toISOString(), duration_ms: Date.now() - started.getTime(),
    },
  };
}

/** Merges a section's search results into the store. Notes are tagged with ids from the merged store. */
export function mergeResearch(store: SourceStore, searched: { responses: SearchResponse[]; run: StageRun } | null): SectionResearch {
  if (!searched) return { sources: store, changed: [], notes: "", run: null, responses: [] };
  const { sources, changed } = mergeSources(store, buildSourceStore(searched.responses));
  return { sources, changed, notes: notesText(searched.responses, sources), run: searched.run, responses: searched.responses };
}

/**
 * A section's own web research, merged into the shared store. With 0 searches
 * it makes no API call and returns the store unchanged.
 */
export async function runSectionResearch(
  stage: Stage,
  args: { spec: IdeaSpec; store: SourceStore; notes: string; searches: number; model: string; prompt: string },
): Promise<SectionResearch> {
  return mergeResearch(args.store, await searchSection(stage, args));
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

/**
 * One writer request: the shared context (cached), then, for sections written
 * from the others, the finished sections so far (cached too: a round's writers
 * and their retries share it), then the section's own instructions.
 */
export function writerParams(
  { model, context, finished, sectionPrompt }: { model: string; context: string; finished?: string; sectionPrompt: string },
  messages: Anthropic.MessageParam[],
  maxTokens = 16000,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: maxTokens,
    output_config: { effort: WRITER_EFFORT },
    system: [
      { type: "text", text: context, cache_control: { type: "ephemeral" } },
      ...(finished ? [{ type: "text" as const, text: finished, cache_control: { type: "ephemeral" as const } }] : []),
      { type: "text", text: sectionPrompt },
    ],
    messages,
  };
}

/**
 * Writes the shared writer context to the cache with a one-token call, so the
 * first three writers can start at once and all read it. Started together
 * without it, each would write the ~20k-token context itself. Same model,
 * effort and system blocks as every writer, so the prefix matches. The reply
 * is cut at max_tokens on purpose and not used.
 */
export async function warmWriterCache(model: string, context: string): Promise<StageRun> {
  const started = new Date();
  const msg = await anthropic().messages.create(
    writerParams({ model, context, sectionPrompt: "Reply with OK." }, [{ role: "user", content: "OK?" }], 1),
    requestOptions(),
  );
  const usage = addUsage(ZERO_USAGE, msg.usage);
  return {
    stage: "alternatives", step: "warm", prompt_version: WRITER_SHARED_PROMPT, model: msg.model, usage,
    cost_usd: costUsd(model, usage), started_at: started.toISOString(), duration_ms: Date.now() - started.getTime(),
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
 * The field a validation problem names, e.g. "tests[0].description" from
 * "tests[0].description: 68 characters, at most 64", or null.
 */
export function problemField(problem: string): string | null {
  return problem.match(/^([A-Za-z_]\w*(?:\[\d+\]|\.[A-Za-z_]\w*)*): /)?.[1] ?? null;
}

function pathKeys(path: string): (string | number)[] {
  return [...path.matchAll(/([A-Za-z_]\w*)|\[(\d+)\]/g)].map((m) => (m[2] === undefined ? m[1] : Number(m[2])));
}

/** The string at `path` in `json`, or undefined if there is none. */
export function stringAt(json: unknown, path: string): string | undefined {
  let v: unknown = json;
  for (const k of pathKeys(path)) {
    if (typeof v !== "object" || v === null) return undefined;
    v = (v as Record<string | number, unknown>)[k];
  }
  return typeof v === "string" ? v : undefined;
}

/** A copy of `json` with the string at `path` replaced. The path must hold a string (see stringAt). */
export function withString(json: unknown, path: string, value: string): unknown {
  const copy = structuredClone(json);
  const keys = pathKeys(path);
  let v = copy as Record<string | number, unknown>;
  for (const k of keys.slice(0, -1)) v = v[k] as Record<string | number, unknown>;
  v[keys.at(-1)!] = value;
  return copy;
}

/** A writer that never produced valid JSON, with what its calls cost. */
export class WriterError extends Error {
  constructor(message: string, readonly run: StageRun) {
    super(message);
  }
}

/** An earlier draft and what fact-check found wrong with it. */
export interface Revision {
  draft: unknown;
  feedback: string;
}

/**
 * Calls a section writer and validates its JSON with `parse`. On a validation
 * error it retries (up to WRITE_ATTEMPTS calls in all), telling the writer what
 * failed. When the problem is one text field in its reply (most are a field
 * over its character limit), the retry asks for that field alone and puts it
 * into the last reply, so the writer doesn't write the whole section again.
 * Anything else (invalid JSON, a rule across fields, a field the reply
 * doesn't have) asks for the whole object again.
 */
export async function runWriter<T>(
  stage: Stage,
  { model, context, finished, sectionPrompt, promptVersion, parse, revise }: {
    model: string; context: string; finished?: string; sectionPrompt: string; promptVersion: string; parse: (json: unknown) => T;
    /** Revise an earlier draft: the writer sees it and what fact-check found. */
    revise?: Revision;
  },
): Promise<{ value: T; run: StageRun }> {
  const started = new Date();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: WRITE_INSTRUCTION }];
  if (revise) messages.push({ role: "assistant", content: JSON.stringify(revise.draft) }, { role: "user", content: revise.feedback });
  let usage = ZERO_USAGE;
  let modelId = model;
  const retries: string[] = [];
  /** The last whole reply that was valid JSON, and the field the last retry asked for, if it asked for one. */
  let last: unknown;
  let patching: string | null = null;
  for (let attempt = 1; ; attempt++) {
    const msg = await anthropic().messages.create(writerParams({ model, context, finished, sectionPrompt }, messages), requestOptions());
    usage = addUsage(usage, msg.usage);
    modelId = msg.model;
    assertFinished(msg, stage);
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let json: unknown;
    try {
      json = parseJsonText(text);
      if (patching) {
        // Asked for as {"<path>": "..."}; a reply nested as the section's own shape is accepted too.
        const fixed = (json as Record<string, unknown>)[patching] ?? stringAt(json, patching);
        if (typeof fixed !== "string") throw new Error(`the reply has no string for ${patching}`);
        json = withString(last, patching, fixed);
      }
      last = json;
      // Parsers may change what they are given; `last` must stay the reply as sent.
      const value = parse(structuredClone(json));
      return {
        value,
        run: {
          stage, step: revise ? "revise" : "write", prompt_version: `${WRITER_SHARED_PROMPT}+${promptVersion}`, model: modelId, usage,
          cost_usd: costUsd(model, usage), started_at: started.toISOString(), duration_ms: Date.now() - started.getTime(),
          ...(retries.length && { retries }),
        },
      };
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err);
      if (attempt >= WRITE_ATTEMPTS) {
        // The spend is real even though the section failed; callers that recover from this can record it.
        throw new WriterError(`${stage}: writer output invalid: ${problem}`, {
          stage, step: revise ? "revise" : "write", prompt_version: `${WRITER_SHARED_PROMPT}+${promptVersion}`, model: modelId, usage,
          cost_usd: costUsd(model, usage), started_at: started.toISOString(), duration_ms: Date.now() - started.getTime(), retries: [...retries, problem.slice(0, 500)],
        });
      }
      retries.push(problem.slice(0, 500));
      const field = problemField(problem);
      patching = last !== undefined && field && stringAt(last, field) !== undefined ? field : null;
      messages.push(
        { role: "assistant", content: text || "(empty reply)" },
        {
          role: "user",
          content: patching
            ? `That JSON failed validation: ${problem}\nRewrite only that field to fix this (count its characters), keeping every rule above. Reply with a JSON object holding just that field, as {${JSON.stringify(patching)}: "..."}.`
            : `That JSON failed validation: ${problem}\nFix this and anything like it (count the characters of every field that has a limit), and reply with the whole JSON object again.`,
        },
      );
    }
  }
}
