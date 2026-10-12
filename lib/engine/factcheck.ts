import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { fetchPage, memoryPageCache, normalizeForMatch, pageLoader, pageWindow, quoteInText, type PageCache, type PageResult } from "./fetch";
import { STAGE_MODELS, ZERO_USAGE, addUsage, anthropic, assertFinished, costUsd, loadPrompt, sumUsage, type ClaimCheck, type StageRun, type TokenUsage } from "./llm";
import { isNotPublic, liveSourceBudget } from "./report";
import type { Source, SourceStore } from "./research";
import { parseAlternatives, type AlternativesSection, type Part } from "./sections/alternatives";
import { PRICE_NOT_PUBLIC } from "./types";

// Fact-check: for every claim a section cites as found, does its source say
// it? Each claim is judged on its own, first against the passage web search
// quoted from the page (~150 characters). A claim that excerpt doesn't fully
// support is judged again against the page's own text, fetched server-side
// (fetch.ts), twice unless the first page verdict is already "unsupported";
// the stricter verdict stands, except that the page never drops a claim the
// excerpt partly supported (the page request includes the excerpt). Support found on the page counts only with a
// passage that appears on the page word for word, and that passage is added
// to the source's excerpt so the readout shows it. Unsupported claims are then
// rewritten to what the source says, re-tagged as estimates, or dropped;
// partly supported ones may be narrowed. Every fix is re-validated against
// the section rules and reverted if it breaks them.

export const FACTCHECK_PROMPT = "factcheck.v3";
export const FACTCHECK_GAP_PROMPT = "factcheck-gap.v1";
const CHECK_ATTEMPTS = 2;
const CONCURRENCY = 8;
const QUOTE_MAX = 400;
/** Used when an unsupported scorecard citation can't be dropped or rewritten. */
const SCORECARD_METHOD = "Our summary of the alternatives listed in this section";

export interface CheckClaim {
  /** Where the claim sits, e.g. "alternatives[2].price". */
  id: string;
  text: string;
  source: string;
  /** What the claim is about, e.g. the row it sits in. */
  context: string;
}

const VerdictSchema = z.object({
  verdict: z.enum(["supported", "partial", "unsupported"]),
  reason: z.string(),
  quote: z.string().nullable(),
  action: z.enum(["keep", "rewrite", "estimate", "drop"]),
  text: z.string().nullable(),
  method: z.string().nullable(),
});
type Judged = z.infer<typeof VerdictSchema>;
export type Verdict = Judged["verdict"];

export interface CheckResult {
  id: string;
  verdict: Verdict;
  reason: string;
  action: Judged["action"];
  text: string | null;
  method: string | null;
  /** What the verdict rests on: the search excerpt, or the fetched page. */
  basis?: "excerpt" | "page";
  /** The first verdict, against the excerpt alone. */
  excerpt_verdict?: Verdict;
  /** A passage found word for word on the page that supports the claim or its rewrite. */
  quote?: string | null;
  /** Why the page couldn't be used, when it was needed. */
  fetch_error?: string;
}

export interface CheckOptions {
  model?: string;
  /** Fetched pages by URL. Defaults to a cache for this call only. */
  pages?: PageCache;
  /** Replaces the network fetch (tests). */
  fetcher?: (url: string) => Promise<PageResult>;
  /** False judges every claim on its excerpt only, as fact-check did before page fetching. */
  fetch?: boolean;
}

/** Every part the section cites as found in a source. Estimates and plain text have no excerpt to check. */
export function collectClaims(section: AlternativesSection): CheckClaim[] {
  const out: CheckClaim[] = [];
  const add = (id: string, p: Part, context: string) => {
    if (p.source && !isNotPublic(p)) out.push({ id, text: p.text, source: p.source, context });
  };
  section.alternatives.forEach((a, i) => {
    const row = `Alternatives row "${a.name}"${a.examples ? ` (${a.examples})` : ""}`;
    add(`alternatives[${i}].price`, a.price, `${row}: its price`);
    a.weakness.forEach((w, j) => add(`alternatives[${i}].weakness[${j}]`, w, `${row}: its weakness`));
  });
  section.market_gap.forEach((m, i) => add(`market_gap[${i}]`, m, "Where the open position sits among the alternatives"));
  const sc = section.scorecard;
  add("scorecard", { text: sc.finding, source: sc.source, estimate: sc.estimate },
    `One-line summary of the alternatives section; key figure ${sc.key_figure.value} ${sc.key_figure.unit}`);
  return out;
}

/** The request for one claim: its excerpt, and the page's text when it was fetched. */
export function claimRequest(c: CheckClaim, source: Source | undefined, page?: string): string {
  return JSON.stringify({
    context: c.context,
    claim: c.text,
    source: { id: c.source, title: source?.title, url: source?.url, quoted_text: source?.excerpt ?? "(missing)", ...(page && { page_text: page }) },
  }, null, 2);
}

type Location =
  | { kind: "price"; row: number }
  | { kind: "weakness"; row: number; part: number }
  | { kind: "gap"; part: number }
  | { kind: "scorecard" };

function locate(id: string): Location {
  let m = id.match(/^alternatives\[(\d+)\]\.price$/);
  if (m) return { kind: "price", row: Number(m[1]) };
  m = id.match(/^alternatives\[(\d+)\]\.weakness\[(\d+)\]$/);
  if (m) return { kind: "weakness", row: Number(m[1]), part: Number(m[2]) };
  m = id.match(/^market_gap\[(\d+)\]$/);
  if (m) return { kind: "gap", part: Number(m[1]) };
  if (id === "scorecard") return { kind: "scorecard" };
  throw new Error(`unknown claim id ${id}`);
}

/** Applies one fix to a copy of the section. Returns null when the fix has nowhere to go. */
function fix(section: AlternativesSection, loc: Location, action: "rewrite" | "estimate" | "drop" | "drop_row", r: CheckResult): AlternativesSection | null {
  const s: AlternativesSection = structuredClone(section);
  const text = r.text?.trim();
  const method = r.method?.trim();
  const edit = (p: Part): Part | null => {
    if (action === "rewrite") return text ? { ...p, text } : null;
    if (action === "estimate") return method ? { text: text || p.text, source: null, estimate: method } : null;
    return null;
  };

  if (loc.kind === "scorecard") {
    if (action === "rewrite") return text ? { ...s, scorecard: { ...s.scorecard, finding: text } } : null;
    // Never dropped: the scorecard needs a citation, so it falls back to our own summary.
    const m = action === "estimate" && method ? method : SCORECARD_METHOD;
    return { ...s, scorecard: { ...s.scorecard, ...(action === "estimate" && text && { finding: text }), source: null, estimate: m } };
  }
  if (loc.kind === "gap") {
    if (action === "drop") {
      if (s.market_gap.length < 2) return null;
      s.market_gap.splice(loc.part, 1);
      return s;
    }
    const p = edit(s.market_gap[loc.part]);
    if (!p) return null;
    s.market_gap[loc.part] = p;
    return s;
  }
  const row = s.alternatives[loc.row];
  if (action === "drop_row") {
    if (s.alternatives.length < 2) return null;
    s.alternatives.splice(loc.row, 1);
    return s;
  }
  if (loc.kind === "price") {
    // A dropped price becomes "Not public"; the section rules check the row still cites a source.
    const p = action === "drop" ? { text: PRICE_NOT_PUBLIC, source: null, estimate: null } : edit(row.price);
    if (!p) return null;
    row.price = p;
    return s;
  }
  if (action === "drop") {
    row.weakness.splice(loc.part, 1);
    return row.weakness.length ? s : null;
  }
  const p = edit(row.weakness[loc.part]);
  if (!p) return null;
  row.weakness[loc.part] = p;
  return s;
}

/** Claims in an order where removing one never shifts the index of one still to come. */
function order(claims: CheckClaim[]): CheckClaim[] {
  const rank = (id: string) => {
    const loc = locate(id);
    if (loc.kind === "scorecard") return [0, 0, 0];
    if (loc.kind === "gap") return [1, loc.part, 0];
    return [2, loc.row, loc.kind === "weakness" ? loc.part + 1 : 0];
  };
  return [...claims].sort((a, b) => {
    const x = rank(a.id), y = rank(b.id);
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
}

/**
 * Applies the checker's verdicts. Supported claims stay. A partial claim is
 * narrowed when the checker rewrote it. An unsupported claim is rewritten,
 * re-tagged as an estimate, or dropped, falling back to dropping it (or its
 * row) when the requested fix breaks the section rules. A claim no fix fits is
 * left as is and logged as unresolved.
 */
export function applyFactcheck(
  section: AlternativesSection,
  claims: CheckClaim[],
  results: CheckResult[],
  store: SourceStore,
  maxSources = liveSourceBudget(),
): { section: AlternativesSection; log: ClaimCheck[] } {
  const byId = new Map(results.map((r) => [r.id, r]));
  const valid = (s: AlternativesSection | null) => {
    if (!s) return null;
    try {
      return parseAlternatives(structuredClone(s), store, maxSources);
    } catch {
      return null;
    }
  };
  let current = section;
  const droppedRows = new Set<number>();
  const log: ClaimCheck[] = [];

  for (const c of order(claims)) {
    const r = byId.get(c.id)!;
    const loc = locate(c.id);
    const entry: Omit<ClaimCheck, "action"> = {
      id: c.id, text: c.text, source: c.source, verdict: r.verdict, reason: r.reason,
      ...(r.basis && { basis: r.basis }),
      ...(r.excerpt_verdict && r.excerpt_verdict !== r.verdict && { excerpt_verdict: r.excerpt_verdict }),
      ...(r.quote && { quote: r.quote }),
      ...(r.fetch_error && { fetch_error: r.fetch_error }),
    };
    if ("row" in loc && droppedRows.has(loc.row)) {
      log.push({ ...entry, action: "dropped", result: "(row dropped)" });
      continue;
    }
    if (r.verdict === "supported" || (r.verdict === "partial" && !(r.action === "rewrite" && r.text))) {
      log.push({ ...entry, action: "kept" });
      continue;
    }
    type How = "rewrite" | "estimate" | "drop" | "drop_row";
    const wanted: How = r.verdict === "partial" || r.action === "rewrite" ? "rewrite" : r.action === "estimate" ? "estimate" : "drop";
    // Partial claims that can't be narrowed are kept; unsupported ones fall back to dropping the claim, then its row.
    const fallbacks: How[] = loc.kind === "price" || loc.kind === "weakness" ? ["drop", "drop_row"] : ["drop"];
    // A claim the excerpt partly supported is never dropped on the page's say-so (see checkClaims): if the page's fix doesn't fit, it stays.
    const keepIfStuck = r.verdict === "partial" || (r.basis === "page" && r.excerpt_verdict === "partial");
    const tries: How[] = keepIfStuck ? [wanted] : [...new Set<How>([wanted, ...fallbacks])];
    let applied: { s: AlternativesSection; how: (typeof tries)[number] } | null = null;
    for (const how of tries) {
      const s = valid(fix(current, loc, how, r));
      if (s) {
        applied = { s, how };
        break;
      }
    }
    if (!applied) {
      log.push({ ...entry, action: keepIfStuck ? "kept" : "unresolved" });
      continue;
    }
    current = applied.s;
    const how = applied.how;
    if (how === "drop_row" && "row" in loc) {
      droppedRows.add(loc.row);
      log.push({ ...entry, action: "dropped", result: "(row dropped)" });
    } else if (loc.kind === "scorecard" && how !== "rewrite") {
      // The scorecard is never dropped: it falls back to an estimate.
      log.push({ ...entry, action: "estimated", result: current.scorecard.estimate ?? undefined });
    } else if (how === "drop") {
      log.push({ ...entry, action: "dropped", ...(loc.kind === "price" && { result: PRICE_NOT_PUBLIC }) });
    } else if (how === "estimate") {
      log.push({ ...entry, action: "estimated", result: r.method ?? undefined });
    } else {
      log.push({ ...entry, action: "rewritten", result: r.text ?? undefined });
    }
  }
  // A scorecard that counted the rows must count the rows that are left.
  const rows = current.alternatives.length;
  if (rows < section.alternatives.length && current.scorecard.key_figure.value === String(section.alternatives.length)) {
    current = { ...current, scorecard: { ...current.scorecard, key_figure: { ...current.scorecard.key_figure, value: String(rows) } } };
  }
  // Report the log in section order.
  const index = new Map(claims.map((c, i) => [c.id, i]));
  log.sort((a, b) => index.get(a.id)! - index.get(b.id)!);
  return { section: current, log };
}

const GapSchema = z.object({ parts: z.array(z.object({ keep: z.number().int().nullable(), text: z.string().nullable() })) });
export type GapReply = z.infer<typeof GapSchema>;

/** Market-gap parts whose citation changed, which may leave the rest of the paragraph pointing at nothing. */
export function gapChanged(log: ClaimCheck[]): boolean {
  return log.some((l) => l.id.startsWith("market_gap") && (l.action === "dropped" || l.action === "rewritten" || l.action === "estimated"));
}

/**
 * Builds the repaired gap from the repairer's reply. Kept parts are taken as
 * they are; new parts are plain text and may not carry figures, so the repair
 * can't add an unsourced fact. Parts in `protect` (cited claims the checker
 * called supported) stay even if the reply leaves them out, in their original
 * order. Returns null if nothing usable is left.
 */
export function assembleGap(remaining: Part[], reply: GapReply, protect: number[] = []): Part[] | null {
  const out = reply.parts.flatMap((p): { part: Part; index?: number }[] => {
    if (p.keep !== null) return remaining[p.keep] ? [{ part: remaining[p.keep], index: p.keep }] : [];
    const text = p.text?.trim();
    return text && !/\d/.test(text) ? [{ part: { text, source: null, estimate: null } }] : [];
  });
  for (const i of protect) {
    if (!remaining[i] || out.some((o) => o.index === i)) continue;
    const before = out.findIndex((o) => o.index !== undefined && o.index > i);
    out.splice(before < 0 ? out.length : before, 0, { part: remaining[i], index: i });
  }
  return out.length ? out.map((o) => o.part) : null;
}

/** Remaining gap parts that are cited claims the checker called supported. */
function supportedGapParts(remaining: Part[], log: ClaimCheck[]): number[] {
  const ok = new Set(log.filter((l) => l.id.startsWith("market_gap") && l.verdict === "supported").map((l) => `${l.source}|${l.text}`));
  return remaining.flatMap((p, i) => (p.source && ok.has(`${p.source}|${p.text}`) ? [i] : []));
}

export function gapRepairRequest(before: Part[], remaining: Part[], log: ClaimCheck[]): string {
  const cite = (p: Part) => (p.source ? `cites ${p.source}` : p.estimate ? `estimate: ${p.estimate}` : "plain");
  return JSON.stringify({
    before: before.map((p) => ({ text: p.text, cited: cite(p) })),
    remaining: remaining.map((p, i) => ({ number: i, text: p.text, cited: cite(p) })),
    changes: log.filter((l) => l.id.startsWith("market_gap") && l.action !== "kept")
      .map((l) => ({ claim: l.text, action: l.action, ...(l.result && { now: l.result }), why: l.reason })),
  }, null, 2);
}

/** Share of checked claims the checker called supported. */
export function supportRate(results: { verdict: CheckResult["verdict"] }[]) {
  const n = (v: CheckResult["verdict"]) => results.filter((r) => r.verdict === v).length;
  return {
    checked: results.length,
    supported: n("supported"),
    partial: n("partial"),
    unsupported: n("unsupported"),
    rate: results.length ? Math.round((n("supported") / results.length) * 1000) / 1000 : 1,
  };
}

const STRICTNESS: Record<Verdict, number> = { supported: 0, partial: 1, unsupported: 2 };

/** The stricter of two verdicts, with its action and text. On a tie, the first. */
export function stricter<T extends { verdict: Verdict }>(a: T, b: T): T {
  return STRICTNESS[b.verdict] > STRICTNESS[a.verdict] ? b : a;
}

/**
 * Holds a page-based verdict to its quote: support, or a rewrite, needs a
 * passage that appears word for word in the text the checker was given.
 * Without one, "supported" becomes "partial" and a rewrite is withdrawn
 * (kept as is if partial, dropped if unsupported).
 */
export function requireQuote(r: Judged, text: string): Judged {
  const quote = r.quote?.trim().slice(0, QUOTE_MAX);
  if (quote && quoteInText(quote, text)) return { ...r, quote };
  const reason = `${r.reason} (Supporting passage not found on the page${quote ? `: "${quote.slice(0, 120)}"` : ""}.)`;
  if (r.verdict === "supported") return { ...r, verdict: "partial", action: "keep", text: null, method: null, quote: null, reason };
  if (r.action === "rewrite") return { ...r, action: r.verdict === "partial" ? "keep" : "drop", text: null, quote: null, reason };
  return { ...r, quote: null };
}

/** Adds each verified page quote to its source's excerpt. Returns the new store and the sources that changed. */
export function addQuotes(store: SourceStore, results: CheckResult[], claims: CheckClaim[]): { store: SourceStore; changed: SourceStore } {
  const add = new Map<string, string[]>();
  results.forEach((r, i) => {
    if (r.basis !== "page" || !r.quote) return;
    const id = claims[i].source;
    add.set(id, [...(add.get(id) ?? []), r.quote]);
  });
  const changed: SourceStore = [];
  const next = store.map((s) => {
    const quotes = (add.get(s.id) ?? []).filter((q, j, all) => all.indexOf(q) === j && !normalizeForMatch(s.excerpt).includes(normalizeForMatch(q)));
    if (!quotes.length) return s;
    const updated = { ...s, excerpt: [s.excerpt, ...quotes].join(" … ") };
    changed.push(updated);
    return updated;
  });
  return { store: next, changed };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** One verdict on one claim. Retries once if the reply doesn't parse. */
async function judge(claim: CheckClaim, source: Source | undefined, model: string, page?: string): Promise<{ r: Judged; usage: TokenUsage; model: string }> {
  let usage = ZERO_USAGE;
  for (let attempt = 1; ; attempt++) {
    const msg = await anthropic().messages.parse({
      model,
      max_tokens: 2000,
      // Thinking off: a short verdict with no reasoning trace to diverge on.
      // Temperature can't be set on Claude 5 models (400), so this and the
      // stricter-of-two rule are what keep verdicts stable.
      thinking: { type: "disabled" },
      output_config: { effort: "medium", format: zodOutputFormat(VerdictSchema) },
      system: loadPrompt(FACTCHECK_PROMPT),
      messages: [{ role: "user", content: claimRequest(claim, source, page) }],
    });
    usage = addUsage(usage, msg.usage);
    assertFinished(msg, "factcheck");
    if (msg.parsed_output) return { r: msg.parsed_output, usage, model: msg.model };
    if (attempt >= CHECK_ATTEMPTS) throw new Error(`factcheck: no verdict for ${claim.id}`);
  }
}

/**
 * Judges every cited claim on its own: first against its excerpt, then, for
 * any claim the excerpt doesn't fully support, against the fetched page (see
 * the module comment). Returns the final verdicts, the excerpt-only ones, and
 * the store with verified page quotes added to the excerpts.
 */
export async function checkClaims(section: AlternativesSection, store: SourceStore, options: CheckOptions = {}): Promise<{
  claims: CheckClaim[];
  results: CheckResult[];
  /** Verdicts against the excerpt alone, before any page was fetched. */
  excerptResults: CheckResult[];
  store: SourceStore;
  /** Sources whose excerpt gained a page quote. */
  changed: SourceStore;
  run: StageRun | null;
}> {
  const model = options.model ?? STAGE_MODELS.factcheck;
  const claims = collectClaims(section);
  if (!claims.length) return { claims, results: [], excerptResults: [], store, changed: [], run: null };
  const started = new Date();
  const byId = new Map(store.map((s) => [s.id, s]));
  let usage = ZERO_USAGE;
  let recheck = ZERO_USAGE;
  let modelId = model;
  // Every call after the excerpt pass is a re-check, the cost page fetching adds.
  const ask = async (c: CheckClaim, phase: "excerpt" | "recheck", page?: string) => {
    const out = await judge(c, byId.get(c.source), model, page);
    modelId = out.model;
    usage = sumUsage(usage, out.usage);
    if (phase === "recheck") recheck = sumUsage(recheck, out.usage);
    return out;
  };

  const excerptResults: CheckResult[] = await mapLimit(claims, CONCURRENCY, async (c) => {
    const { r } = await ask(c, "excerpt");
    return { id: c.id, ...r, quote: null, basis: "excerpt" as const, excerpt_verdict: r.verdict };
  });

  const load = pageLoader(options.pages ?? memoryPageCache(), options.fetcher ?? fetchPage);
  const pages: NonNullable<StageRun["pages"]> = [];
  const seen = new Set<string>();
  const results = await mapLimit(claims, CONCURRENCY, async (c, i): Promise<CheckResult> => {
    const first = excerptResults[i];
    if (first.verdict === "supported" || options.fetch === false) return first;
    const source = byId.get(c.source);
    const loaded = source ? await load(source.url) : { page: { ok: false as const, error: "source missing" }, cached: false };
    if (source && !seen.has(source.url)) {
      seen.add(source.url);
      pages.push({ source: c.source, url: source.url, ok: loaded.page.ok, cached: loaded.cached,
        ...(loaded.page.ok ? { chars: loaded.page.text.length } : { error: loaded.page.error }) });
    }
    if (!loaded.page.ok) {
      // No page: a partial verdict is asked once more on the excerpt, and the stricter stands.
      if (first.verdict !== "partial") return { ...first, fetch_error: loaded.page.error };
      const { r } = await ask(c, "recheck");
      return { ...stricter(first, { id: c.id, ...r, quote: null }), basis: "excerpt", excerpt_verdict: first.verdict, fetch_error: loaded.page.error };
    }
    const window = pageWindow(loaded.page.text, { claim: c.text, excerpt: source?.excerpt ?? "", context: c.context });
    const evidence = `${window}\n${source?.excerpt ?? ""}`;
    const once = async () => requireQuote((await ask(c, "recheck", window)).r, evidence);
    let r = await once();
    if (r.verdict !== "unsupported") r = stricter(r, await once());
    // The page request includes the excerpt, so the page can't support less of
    // the claim than the excerpt did. Dropping a claim the excerpt partly
    // supports is checker noise; a rewrite to what the page says still applies.
    if (first.verdict === "partial" && r.verdict === "unsupported" && r.action === "drop") {
      return { ...first, reason: `${first.reason} (Page check: unsupported, "${r.reason}"; the excerpt's partial verdict stands.)` };
    }
    return { id: c.id, ...r, basis: "page", excerpt_verdict: first.verdict };
  });

  const quoted = addQuotes(store, results, claims);
  return {
    claims,
    results,
    excerptResults,
    store: quoted.store,
    changed: quoted.changed,
    run: {
      stage: "factcheck", prompt_version: FACTCHECK_PROMPT, model: modelId, usage,
      cost_usd: costUsd(model, usage), started_at: started.toISOString(), duration_ms: Date.now() - started.getTime(),
      pages, recheck_cost_usd: costUsd(model, recheck),
    },
  };
}

/**
 * Checks every cited claim and applies the fixes. When the market gap's cited
 * parts changed, one more call makes the rest of the paragraph consistent with
 * them. The run's `claims` logs each verdict and action, `pages` each page
 * fetched, and `repairs` the gap before and after. `sources` is the store with
 * verified page quotes added; `changed` lists the sources that gained one.
 */
export async function runFactcheck(section: AlternativesSection, store: SourceStore, options: CheckOptions = {}): Promise<{
  section: AlternativesSection;
  log: ClaimCheck[];
  results: CheckResult[];
  excerptResults: CheckResult[];
  sources: SourceStore;
  changed: SourceStore;
  run: StageRun | null;
}> {
  const model = options.model ?? STAGE_MODELS.factcheck;
  const checked = await checkClaims(section, store, { ...options, model });
  const { claims, results, excerptResults, run } = checked;
  const sources = checked.store;
  const applied = applyFactcheck(section, claims, results, sources);
  const base = { results, excerptResults, sources, changed: checked.changed };
  if (!run) return { ...applied, ...base, run };

  let out = applied.section;
  let usage = run.usage;
  const repairs: NonNullable<StageRun["repairs"]> = [];
  if (gapChanged(applied.log)) {
    const msg = await anthropic().messages.parse({
      model,
      max_tokens: 4000,
      output_config: { effort: "medium", format: zodOutputFormat(GapSchema) },
      system: loadPrompt(FACTCHECK_GAP_PROMPT),
      messages: [{ role: "user", content: gapRepairRequest(section.market_gap, out.market_gap, applied.log) }],
    });
    usage = addUsage(usage, msg.usage);
    assertFinished(msg, "factcheck");
    const gap = msg.parsed_output && assembleGap(out.market_gap, msg.parsed_output, supportedGapParts(out.market_gap, applied.log));
    const candidate = gap && { ...out, market_gap: gap };
    try {
      if (candidate) {
        out = parseAlternatives(structuredClone(candidate), sources);
        repairs.push({ field: "market_gap", before: section.market_gap.map((p) => p.text).join(" "), after: out.market_gap.map((p) => p.text).join(" ") });
      }
    } catch {
      // Keep the fact-checked gap as it is if the repair breaks the section rules.
    }
  }
  return {
    section: out,
    log: applied.log,
    ...base,
    run: {
      ...run,
      prompt_version: repairs.length ? `${FACTCHECK_PROMPT}+${FACTCHECK_GAP_PROMPT}` : run.prompt_version,
      usage,
      cost_usd: costUsd(model, usage),
      claims: applied.log,
      ...(repairs.length && { repairs }),
    },
  };
}
