import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { STAGE_MODELS, ZERO_USAGE, addUsage, anthropic, assertFinished, costUsd, loadPrompt, type ClaimCheck, type StageRun } from "./llm";
import { isNotPublic, liveSourceBudget } from "./report";
import type { SourceStore } from "./research";
import { parseAlternatives, type AlternativesSection, type Part } from "./sections/alternatives";
import { PRICE_NOT_PUBLIC } from "./types";

// Fact-check: for every claim a section cites as found, does the cited
// excerpt actually say it? One call over all claims, with each claim's excerpt
// inline, so it needs none of the writers' cached context. Unsupported claims
// are rewritten to what the source says, re-tagged as estimates, or dropped;
// partly supported ones may be narrowed. Every fix is re-validated against the
// section rules and reverted if it breaks them.

export const FACTCHECK_PROMPT = "factcheck.v1";
const CHECK_ATTEMPTS = 2;
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

const ResultSchema = z.object({
  results: z.array(z.object({
    id: z.string(),
    verdict: z.enum(["supported", "partial", "unsupported"]),
    reason: z.string(),
    action: z.enum(["keep", "rewrite", "estimate", "drop"]),
    text: z.string().nullable(),
    method: z.string().nullable(),
  })),
});
export type CheckResult = z.infer<typeof ResultSchema>["results"][number];

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

export function factcheckRequest(claims: CheckClaim[], store: SourceStore): string {
  const byId = new Map(store.map((s) => [s.id, s]));
  return JSON.stringify(claims.map((c) => {
    const s = byId.get(c.source);
    return { id: c.id, context: c.context, claim: c.text, source: { id: c.source, title: s?.title, url: s?.url, quoted_text: s?.excerpt ?? "(missing)" } };
  }), null, 2);
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
    const entry = { id: c.id, text: c.text, source: c.source, verdict: r.verdict, reason: r.reason };
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
    const tries: How[] = r.verdict === "partial" ? [wanted] : [...new Set<How>([wanted, ...fallbacks])];
    let applied: { s: AlternativesSection; how: (typeof tries)[number] } | null = null;
    for (const how of tries) {
      const s = valid(fix(current, loc, how, r));
      if (s) {
        applied = { s, how };
        break;
      }
    }
    if (!applied) {
      log.push({ ...entry, action: r.verdict === "partial" ? "kept" : "unresolved" });
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
  // Report the log in section order.
  const index = new Map(claims.map((c, i) => [c.id, i]));
  log.sort((a, b) => index.get(a.id)! - index.get(b.id)!);
  return { section: current, log };
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

/** Asks the checker for a verdict on every cited claim. Retries once if it skips a claim. */
export async function checkClaims(
  section: AlternativesSection,
  store: SourceStore,
  { model = STAGE_MODELS.factcheck }: { model?: string } = {},
): Promise<{ claims: CheckClaim[]; results: CheckResult[]; run: StageRun | null }> {
  const claims = collectClaims(section);
  if (!claims.length) return { claims, results: [], run: null };
  const started = new Date();
  let usage = ZERO_USAGE;
  let modelId = model;
  for (let attempt = 1; ; attempt++) {
    const msg = await anthropic().messages.parse({
      model,
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(ResultSchema) },
      system: loadPrompt(FACTCHECK_PROMPT),
      messages: [{ role: "user", content: factcheckRequest(claims, store) }],
    });
    usage = addUsage(usage, msg.usage);
    modelId = msg.model;
    assertFinished(msg, "factcheck");
    const results = msg.parsed_output?.results ?? [];
    const got = new Set(results.map((r) => r.id));
    const missing = claims.filter((c) => !got.has(c.id)).map((c) => c.id);
    if (!missing.length) {
      return {
        claims,
        results: claims.map((c) => results.find((r) => r.id === c.id)!),
        run: {
          stage: "factcheck", prompt_version: FACTCHECK_PROMPT, model: modelId, usage,
          cost_usd: costUsd(model, usage), started_at: started.toISOString(), duration_ms: Date.now() - started.getTime(),
        },
      };
    }
    if (attempt >= CHECK_ATTEMPTS) throw new Error(`factcheck: no verdict for ${missing.join(", ")}`);
  }
}

/** Checks every cited claim and applies the fixes. The run's `claims` logs each verdict and action. */
export async function runFactcheck(section: AlternativesSection, store: SourceStore, options: { model?: string } = {}): Promise<{
  section: AlternativesSection;
  log: ClaimCheck[];
  results: CheckResult[];
  run: StageRun | null;
}> {
  const { claims, results, run } = await checkClaims(section, store, options);
  const applied = applyFactcheck(section, claims, results, store);
  return { section: applied.section, log: applied.log, results, run: run && { ...run, claims: applied.log } };
}
