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
 * Writer calls allowed per section for structural errors: the first, plus two
 * retries that are told what failed. Length overruns on display-text fields are
 * different (see runWriter): a word-boundary trim when the overrun is at most
 * 50% over the cap and safe, otherwise up to two cheap repairs, then a safe
 * trim, so a 60-character scorecard.finding does not kill the run.
 *
 * Two length repairs fit in these three attempts: the first write and the
 * first repair can each request another call (`attempt < WRITE_ATTEMPTS`);
 * the third attempt then trims or fails. Structural retries stay bounded
 * here and do not need a higher cap.
 */
export const WRITE_ATTEMPTS = 3;

/** Extra writer calls to shorten over-limit display-text fields. Then we trim if safe. */
export const LENGTH_REPAIR_ATTEMPTS = 2;

/** Overruns this far over the cap (inclusive) are trimmed locally, with no extra call. */
export const TRIM_OVERRUN_RATIO = 0.5;

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
 * Writes the shared writer context to the cache with a call that generates
 * nothing (max_tokens 0, as the cache probe in tests/runs-summary.md), so the
 * first three writers can start at once and all read it. Started together
 * without it, each would write the ~20k-token context itself. Same model,
 * effort and system blocks as every writer, so the prefix matches. The reply
 * is empty and not used.
 */
export async function warmWriterCache(model: string, context: string): Promise<StageRun> {
  const started = new Date();
  const msg = await anthropic().messages.create(
    writerParams({ model, context, sectionPrompt: "Reply with OK." }, [{ role: "user", content: "OK?" }], 0),
    requestOptions(),
  );
  const usage = addUsage(ZERO_USAGE, msg.usage);
  return {
    stage: "alternatives", step: "warm", prompt_version: WRITER_SHARED_PROMPT, model: msg.model, usage,
    cost_usd: costUsd(model, usage), started_at: started.toISOString(), duration_ms: Date.now() - started.getTime(),
  };
}

/**
 * Every complete JSON value in a writer's reply, in order. Writers sometimes
 * emit a valid object and then more text — a second object, a fence, or a
 * comment that still contains `}`. JSON.parse of first `{` to last `}` then
 * throws V8's "Unexpected non-whitespace character after JSON at position N
 * (line 3 column 1)", which is the live demand_evidence error. That shape
 * repeated on the same idea, so a retry produces the same reply; callers
 * pick a value that passes the section parser instead.
 */
export function jsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const brace = text.indexOf("{", i);
    const bracket = text.indexOf("[", i);
    const start = [brace, bracket].filter((n) => n >= 0).sort((a, b) => a - b)[0];
    if (start === undefined) break;
    const slice = text.slice(start);
    try {
      values.push(JSON.parse(slice));
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const after = msg.match(/after JSON at position (\d+)/);
      if (after) {
        try {
          values.push(JSON.parse(slice.slice(0, Number(after[1]))));
          i = start + Number(after[1]);
          continue;
        } catch {
          // The prefix V8 pointed at still isn't a value; skip this opener.
        }
      }
      i = start + 1;
    }
  }
  return values;
}

/** Top-level objects in the reply. A wrapping array contributes its object elements. */
export function jsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const take = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) take(x);
    } else if (v !== null && typeof v === "object") {
      objects.push(v as Record<string, unknown>);
    }
  };
  for (const v of jsonValues(text)) take(v);
  return objects;
}

/** The JSON object in a writer's reply, tolerating a code fence, a sentence around it, or extra text after the first value. */
export function parseJsonText(text: string): unknown {
  const values = jsonValues(text);
  if (values.length) return values[0];
  const start = text.search(/[{[]/);
  if (start < 0) throw new Error("no JSON object in the reply");
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (end < start) throw new Error("no JSON object in the reply");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`the reply is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

export const WRITE_INSTRUCTION = "Write the section now. Reply with the JSON object only.";

const FIELD_PATH = /^([A-Za-z_]\w*(?:\[\d+\]|\.[A-Za-z_]\w*)*)/;

/**
 * The field a validation problem names, e.g. "tests[0].description" from
 * "tests[0].description: 68 characters, at most 64", or null.
 */
export function problemField(problem: string): string | null {
  return problem.match(/^([A-Za-z_]\w*(?:\[\d+\]|\.[A-Za-z_]\w*)*): /)?.[1] ?? null;
}

/**
 * A display-text length overrun, or null when the problem is anything else
 * (missing fields, wrong types, source rules). Only this shape is repaired
 * then trimmed when safe; structural errors stay fatal.
 */
export interface LengthOverrun {
  field: string;
  max: number;
  length?: number;
}

export function lengthOverrun(problem: string): LengthOverrun | null {
  const msg = problem.trim();
  const field = FIELD_PATH.exec(msg)?.[1];
  if (!field || msg[field.length] !== ":") return null;
  const rest = msg.slice(field.length + 2);
  let m = rest.match(/^(\d+) characters, at most (\d+)$/);
  if (m) return { field, max: Number(m[2]), length: Number(m[1]) };
  m = rest.match(/^(\d+) characters; .* at most (\d+)$/);
  if (m) return { field, max: Number(m[2]), length: Number(m[1]) };
  m = rest.match(/^longer than (\d+) characters \((\d+)\)$/);
  if (m) return { field, max: Number(m[1]), length: Number(m[2]) };
  m = rest.match(/^longer than (\d+) characters(?: in total)?$/);
  if (m) return { field, max: Number(m[1]) };
  m = rest.match(/longer than (\d+) characters combined$/);
  if (m) return { field, max: Number(m[1]) };
  return null;
}

/** True when `length` is at most 50% over `max` (a 60-character finding vs 56 is trimmable). */
export function isTrimmableOverrun(length: number, max: number): boolean {
  return length <= Math.ceil(max * (1 + TRIM_OVERRUN_RATIO));
}

const FIGURE_TOKEN = /\$?\d[\d,]*(?:\.\d+)?(?:\s*[KkMm](?![A-Za-z]))?%?/g;

/** Figure tokens in `text` ($80, 6,600, 40%, $1.2M). */
export function figureTokens(text: string): string[] {
  return [...text.matchAll(FIGURE_TOKEN)].map((m) => m[0].trim()).filter(Boolean);
}

/** True when a figure in `original` is missing from `next`. */
export function figuresLost(original: string, next: string): boolean {
  return figureTokens(original).some((t) => !next.includes(t));
}

function pathKeys(path: string): (string | number)[] {
  return [...path.matchAll(/([A-Za-z_]\w*)|\[(\d+)\]/g)].map((m) => (m[2] === undefined ? m[1] : Number(m[2])));
}

/** The value at `path` in `json`, or undefined if there is none. */
export function valueAt(json: unknown, path: string): unknown {
  let v: unknown = json;
  for (const k of pathKeys(path)) {
    if (typeof v !== "object" || v === null) return undefined;
    v = (v as Record<string | number, unknown>)[k];
  }
  return v;
}

/** The string at `path` in `json`, or undefined if there is none. */
export function stringAt(json: unknown, path: string): string | undefined {
  const v = valueAt(json, path);
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

/**
 * The path of a truncatable string in writer JSON. Report validation names
 * scorecard rows as `scorecard.alternatives.finding`; writers use `scorecard.finding`.
 */
export function resolveTextPath(json: unknown, path: string): string | undefined {
  if (stringAt(json, path) !== undefined) return path;
  const mapped = path.replace(/^scorecard\.[a-z_]+\./, "scorecard.");
  if (mapped !== path && stringAt(json, mapped) !== undefined) return mapped;
  if (stringAt(json, `${path}.text`) !== undefined) return `${path}.text`;
  if (mapped !== path && stringAt(json, `${mapped}.text`) !== undefined) return `${mapped}.text`;
  if (path.endsWith(".text")) {
    const parent = path.slice(0, -5);
    if (Array.isArray(valueAt(json, parent)) && stringAt(json, `${parent}[0].text`) !== undefined) {
      return `${parent}[0].text`;
    }
  }
  return undefined;
}

function partTextPaths(json: unknown, path: string): string[] {
  const mapped = path.replace(/^scorecard\.[a-z_]+\./, "scorecard.");
  const at = Array.isArray(valueAt(json, path)) ? path : Array.isArray(valueAt(json, mapped)) ? mapped : null;
  if (!at) return [];
  const v = valueAt(json, at) as unknown[];
  return v.flatMap((_, i) => {
    const p = `${at}[${i}]`;
    if (typeof valueAt(json, p) === "string") return [p];
    if (stringAt(json, `${p}.text`) !== undefined) return [`${p}.text`];
    return [];
  });
}

/** Cut `s` to `max` characters at a word boundary, with an ellipsis. */
export function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return "";
  const ellipsis = "…";
  if (max <= ellipsis.length) return ellipsis.slice(0, max);
  const budget = max - ellipsis.length;
  let cut = s.slice(0, budget);
  const sp = cut.lastIndexOf(" ");
  if (sp >= Math.min(8, Math.max(1, Math.floor(budget * 0.5)))) cut = cut.slice(0, sp);
  cut = cut.replace(/[\s.,;:!?]+$/, "");
  const out = `${cut}${ellipsis}`;
  return out.length <= max ? out : `${s.slice(0, max - ellipsis.length)}${ellipsis}`;
}

/** Shorten the named display-text field (or the texts of its parts) to `overrun.max`. */
export function applyLengthOverrun(json: unknown, overrun: LengthOverrun): unknown {
  const stringPath = resolveTextPath(json, overrun.field);
  if (stringPath) return withString(json, stringPath, truncateAtWord(stringAt(json, stringPath)!, overrun.max));
  const parts = partTextPaths(json, overrun.field);
  if (!parts.length) return json;
  let total = parts.reduce((n, p) => n + stringAt(json, p)!.length, 0);
  if (total <= overrun.max) return json;
  let out = json;
  for (let i = parts.length - 1; i >= 0 && total > overrun.max; i--) {
    const s = stringAt(out, parts[i])!;
    const others = total - s.length;
    const room = overrun.max - others;
    const next = room < 1
      ? (i === 0 ? truncateAtWord(s, Math.max(1, overrun.max)) : "…")
      : truncateAtWord(s, room);
    out = withString(out, parts[i], next);
    total = others + next.length;
  }
  return out;
}

function isFigureField(path: string): boolean {
  return /(^|\.)(value|unit|amount)$/.test(path) || path.includes("key_figure");
}

function isCitedPath(json: unknown, path: string): boolean {
  if (!path.endsWith(".text")) return false;
  const src = valueAt(json, `${path.slice(0, -5)}.source`);
  return typeof src === "string" && src.trim().length > 0;
}

function overrunChars(json: unknown, overrun: LengthOverrun): number | undefined {
  if (overrun.length != null) return overrun.length;
  const path = resolveTextPath(json, overrun.field);
  if (path) return stringAt(json, path)?.length;
  const parts = partTextPaths(json, overrun.field);
  if (!parts.length) return undefined;
  return parts.reduce((n, p) => n + (stringAt(json, p)?.length ?? 0), 0);
}

/**
 * True when a word-boundary trim of this overrun would not drop a cited fact
 * or a figure. Figure fields (values, units, amounts) are never trimmed.
 */
export function trimIsSafe(json: unknown, overrun: LengthOverrun): boolean {
  if (isFigureField(overrun.field)) return false;
  const path = resolveTextPath(json, overrun.field);
  if (path) {
    if (isCitedPath(json, path)) return false;
    const original = stringAt(json, path)!;
    const trimmed = truncateAtWord(original, overrun.max);
    return Boolean(trimmed.trim()) && !figuresLost(original, trimmed);
  }
  const parts = partTextPaths(json, overrun.field);
  if (!parts.length) return false;
  const next = applyLengthOverrun(json, overrun);
  if (JSON.stringify(next) === JSON.stringify(json)) return false;
  for (const p of parts) {
    const before = stringAt(json, p)!;
    const after = stringAt(next, p)!;
    if (before === after) continue;
    if (isCitedPath(json, p) || figuresLost(before, after)) return false;
  }
  return true;
}

function recoverLength<T>(json: unknown, parse: (v: unknown) => T, first: LengthOverrun): { value: T; notes: string[] } | null {
  const notes: string[] = [];
  let cur = json;
  let overrun: LengthOverrun | null = first;
  for (let i = 0; i < 32 && overrun; i++) {
    if (!trimIsSafe(cur, overrun)) return null;
    const next = applyLengthOverrun(cur, overrun);
    if (JSON.stringify(next) === JSON.stringify(cur)) return null;
    notes.push(`truncated ${overrun.field} to at most ${overrun.max} characters`);
    cur = next;
    try {
      return { value: parse(structuredClone(cur)), notes };
    } catch (err) {
      overrun = lengthOverrun(err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}

function lengthRepairAsk(problem: string, overrun: LengthOverrun, patching: string | null): string {
  const count = overrun.length != null ? ` (it is ${overrun.length} characters)` : "";
  if (patching) {
    return `That JSON failed validation: ${problem}\n${patching} is over its hard limit of ${overrun.max} characters${count}. Rewrite only that field shorter (count its characters), keeping every rule above. Reply with a JSON object holding just that field, as {${JSON.stringify(patching)}: "..."}.`;
  }
  return `That JSON failed validation: ${problem}\nShorten ${overrun.field} to at most ${overrun.max} characters${count} (count them), and any other display-text field over its hard limit. Reply with the whole JSON object again.`;
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
 * Calls a section writer and validates its JSON with `parse`. Extra text after
 * a complete object is stripped (see jsonValues); when several objects are in
 * the reply, the last one that passes `parse` wins — a short stub then the
 * real section is the demand_evidence shape, and taking the stub would still
 * fail the run.
 *
 * A length overrun on a display-text field is not fatal. An overrun of at
 * most 50% over the cap is trimmed at a word boundary when that would not
 * drop a cited fact or figure. Otherwise up to two repair calls ask the
 * writer to shorten the named fields (same cached research, no new searches);
 * if they are still over, a safe trim is applied. Cited text and figure
 * fields are never trimmed: those fail the run if the writer cannot shorten
 * them. Structural errors (missing fields, wrong types, citation rules)
 * still retry up to WRITE_ATTEMPTS calls and then fail. When the problem is
 * one text field in its reply, the retry asks for that field alone and puts
 * it into the last reply.
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
  let lengthRepairs = 0;
  let pendingRepair = false;
  let repairUsage = ZERO_USAGE;
  const repairCost = () => {
    const n = costUsd(model, repairUsage);
    return n > 0 ? { repair_cost_usd: n } : {};
  };
  const done = (value: T) => ({
    value,
    run: {
      stage, step: (revise ? "revise" : "write") as "revise" | "write", prompt_version: `${WRITER_SHARED_PROMPT}+${promptVersion}`, model: modelId, usage,
      cost_usd: costUsd(model, usage), started_at: started.toISOString(), duration_ms: Date.now() - started.getTime(),
      ...repairCost(),
      ...(retries.length && { retries }),
    },
  });
  const fail = (problem: string): never => {
    throw new WriterError(`${stage}: writer output invalid: ${problem}`, {
      stage, step: revise ? "revise" : "write", prompt_version: `${WRITER_SHARED_PROMPT}+${promptVersion}`, model: modelId, usage,
      cost_usd: costUsd(model, usage), started_at: started.toISOString(), duration_ms: Date.now() - started.getTime(), ...repairCost(), retries: [...retries, problem.slice(0, 500)],
    });
  };
  for (let attempt = 1; ; attempt++) {
    const msg = await anthropic().messages.create(writerParams({ model, context, finished, sectionPrompt }, messages), requestOptions());
    usage = addUsage(usage, msg.usage);
    if (pendingRepair) {
      repairUsage = addUsage(repairUsage, msg.usage);
      pendingRepair = false;
    }
    modelId = msg.model;
    assertFinished(msg, stage);
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    try {
      const candidates = jsonObjects(text);
      if (!candidates.length) {
        parseJsonText(text);
        throw new Error("no JSON object in the reply");
      }
      let problem: Error = new Error("no JSON object in the reply");
      // Last object first: the model's final JSON, not a stub it wrote before it.
      for (const [i, raw] of [...candidates].reverse().entries()) {
        try {
          let json: unknown = raw;
          if (patching) {
            // Asked for as {"<path>": "..."}; a reply nested as the section's own shape is accepted too.
            const fixed = (json as Record<string, unknown>)[patching] ?? stringAt(json, patching);
            if (typeof fixed !== "string") throw new Error(`the reply has no string for ${patching}`);
            json = withString(last, patching, fixed);
            last = json;
          } else if (i === 0) {
            last = json;
          }
          // Parsers may change what they are given; `last` must stay the reply as sent.
          const value = parse(structuredClone(json));
          last = json;
          return done(value);
        } catch (err) {
          problem = err instanceof Error ? err : new Error(String(err));
        }
      }
      throw problem;
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err);
      const overrun = last !== undefined ? lengthOverrun(problem) : null;
      if (overrun && last !== undefined) {
        const chars = overrunChars(last, overrun);
        const trimmable = chars != null && isTrimmableOverrun(chars, overrun.max);
        const tryTrim = () => recoverLength(last, parse, overrun);
        if (trimmable) {
          const recovered = tryTrim();
          if (recovered) {
            retries.push(problem.slice(0, 500), ...recovered.notes);
            return done(recovered.value);
          }
        }
        if (lengthRepairs < LENGTH_REPAIR_ATTEMPTS && attempt < WRITE_ATTEMPTS) {
          lengthRepairs++;
          pendingRepair = true;
          retries.push(problem.slice(0, 500));
          const named = resolveTextPath(last, overrun.field);
          patching = named ?? null;
          messages.push(
            { role: "assistant", content: text || "(empty reply)" },
            { role: "user", content: lengthRepairAsk(problem, overrun, patching) },
          );
          continue;
        }
        const recovered = tryTrim();
        if (recovered) {
          retries.push(problem.slice(0, 500), ...recovered.notes);
          return done(recovered.value);
        }
        fail(problem);
      }
      if (attempt >= WRITE_ATTEMPTS) fail(problem);
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
