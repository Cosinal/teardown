import { factcheckSection, type CheckOptions, type FactcheckOutput, type SectionCheck } from "../factcheck";
import type { IdeaSpec } from "../intake";
import type { Source, SourceStore } from "../research";
import { PRICE_NOT_PUBLIC, type Rating, type Rich } from "../types";
import type { PartialReport } from "../validate";

// The sections written from the others (Idea, Distribution, Blockers,
// Riskiest Assumptions, Next Tests, Verdict) see the finished sections as one
// block of text, the "brief". The same text is what their summary claims are
// fact-checked against, so a verdict can only say what the report says.
//
// Figures: these sections may not make up numbers. Any figure in their plain
// text must already appear in the finished sections or the founder's input,
// written the same way (checkFigures).

/** Synthetic source ids for internal fact-checks. Never in the SourceStore or the report. */
export const REPORT_SOURCE = "REPORT";
export const SPEC_SOURCE = "SPEC";

function text(r: Rich): string {
  return (Array.isArray(r) ? r : [r]).map((p) => (typeof p === "string" ? p : `${p.text} (${p.basis})`)).join(" ");
}

function head(title: string, s?: { rating: Rating; key_figure: { value: string; unit: string }; finding: string }): string {
  return s ? `## ${title}\n\nRated ${s.rating}. Key figure: ${s.key_figure.value} ${s.key_figure.unit}. Finding: "${s.finding}"` : `## ${title}`;
}

/** The finished sections of a report, as plain text, in reading order. */
export function reportBrief(r: PartialReport): string {
  const out: string[] = [];
  const sc = r.scorecard ?? {};
  if (r.verdict) out.push(`## Verdict\n\nCall: ${r.verdict.call.replace("_", " ")}. Confidence: ${r.verdict.confidence}. ${r.verdict.summary}`);
  if (r.idea) {
    const i = r.idea;
    out.push(`## The idea as understood\n\n${i.headline}\n- Customer: ${i.customer}\n- Problem: ${i.problem}\n- Revenue: ${i.revenue}`);
  }
  if (r.alternatives) {
    const rows = r.alternatives.map((a) => `- ${a.name}${a.examples ? ` (${a.examples})` : " (a manual workaround)"}: ${a.what_it_does}. `
      + `Price: ${a.price === PRICE_NOT_PUBLIC ? PRICE_NOT_PUBLIC : text(a.price)}. Weakness: ${text(a.weakness)}`);
    out.push([head("Existing Alternatives", sc.alternatives), ...rows, ...(r.market_gap ? [`Market gap: ${text(r.market_gap)}`] : [])].join("\n"));
  }
  if (r.demand_evidence) {
    const rows = r.demand_evidence.map((d) => `- ${d.signal}: ${d.value} ${text(d.detail)}, rated ${d.rating}`);
    out.push([head("Demand Evidence", sc.demand_evidence), ...(rows.length ? rows : ["- No checkable demand signal was found."])].join("\n"));
  }
  if (r.economics) {
    const e = r.economics;
    const rows = (e.workings ?? []).map((w) => `- ${w.label}: ${w.value}. ${text(w.note)}`);
    out.push([head(`Economics (per ${e.per ?? "sale"}${e.currency ? `, in ${e.currency}` : ""})`, sc.economics), ...rows].join("\n"));
  }
  if (r.distribution) {
    const rows = r.distribution.map((c) => `- ${c.name} (${c.examples}), rated ${c.rating}: ${text(c.reason)}`);
    out.push([head("Distribution (channels for the first 100 customers)", sc.distribution), ...rows].join("\n"));
  }
  if (r.blockers) {
    const rows = r.blockers.map((b) => `- ${b.type}, ${b.severity} severity: ${b.risk}. ${text(b.detail)}`);
    out.push([head("Blockers", sc.blockers), ...(rows.length ? rows : ["- No legal, technical or platform blockers found."])].join("\n"));
  }
  if (r.riskiest_assumptions) {
    out.push(["## Riskiest assumptions (ranked, riskiest first)", ...r.riskiest_assumptions.map((a, i) => `${i + 1}. ${a.statement} ${a.if_false}`)].join("\n"));
  }
  if (r.next_tests) {
    out.push(["## Next tests (in order)", ...r.next_tests.map((t, i) => `${i + 1}. ${t.name} ${t.description} Checks assumption ${t.assumption}. `
      + `Proves: ${t.proves} Cost: ${t.cost}. Time: ${t.time}. Kill threshold: ${t.kill_threshold}`)].join("\n"));
  }
  if (r.page_summaries) {
    const p = r.page_summaries;
    out.push(`## Page summaries\n\n- Market: ${p.market}\n- Business: ${p.business}\n- Next steps: ${p.next_steps}`);
  }
  return out.join("\n\n");
}

/** The founder's idea as intake understood it, for checking "The idea as understood". */
export function specText(spec: IdeaSpec): string {
  return [
    `Name: ${spec.name}`,
    `Customer: ${spec.customer}`,
    `Problem: ${spec.problem}`,
    `Price: ${spec.revenue_model.price} (${spec.revenue_model.billing.replace("_", "-")}). ${spec.revenue_model.notes}`,
    `Category: ${spec.category}`,
    `Geography: ${[spec.geography.scope, ...spec.geography.places].join(", ")}`,
    ...spec.ambiguities.map((a) => `Assumed (${a.field}): ${a.assumption}`),
  ].join("\n");
}

/**
 * Added to every internal claim's context. Without it the checker treats the
 * report like a web page and calls a figure the report attributes to one of
 * its sources unsupported ("no third-party source here").
 */
export const INTERNAL_NOTE = "The source is this report's own text: anything it states, including what it attributes to its sources, counts as stated.";

/** A synthetic source for the internal fact-check. */
export function internalSource(id: string, title: string, excerpt: string): Source {
  return { id, url: `https://teardown.invalid/${id.toLowerCase()}`, title, retrieved_at: new Date(0).toISOString(), excerpt };
}

// ---------------------------------------------------------------------------
// Figures

const NUMBER = /(\$)?(\d[\d,]*(?:\.\d+)?)(?:\s*([KkMm])(?![A-Za-z]))?(\s*%)?/g;
/** Small counts ("three tests", "2 weeks") are free: integers up to this, without $ or %. */
const FREE_COUNT = 12;

const norm = (n: number) => String(Number(n.toFixed(4)));

function figuresIn(text: string): { raw: string; values: string[]; free: boolean }[] {
  return [...text.matchAll(NUMBER)].map((m) => {
    const n = Number(m[2].replace(/,/g, ""));
    const scale = m[3] ? (m[3].toLowerCase() === "k" ? 1e3 : 1e6) : 1;
    return {
      raw: m[0].trim(),
      values: [norm(n), norm(n * scale)],
      free: !m[1] && !m[4] && !m[3] && Number.isInteger(n) && n <= FREE_COUNT,
    };
  });
}

/** The figures a later section may use: every number in the given texts, as the reader sees them. */
export interface KnownFigures {
  values: Set<string>;
  /** As written, for the writer's instructions and retry messages. */
  shown: string[];
}

/** Economics' unrounded break-even ("= 2.9, rounded up") is a working, not a figure to repeat: the result is the rounded one. */
const UNROUNDED = /= [\d.,]+, rounded up/g;

export function knownFigures(...texts: string[]): KnownFigures {
  const values = new Set<string>();
  const shown = new Set<string>();
  for (const t of texts.map((x) => x.replace(UNROUNDED, ""))) {
    for (const f of figuresIn(t)) {
      f.values.forEach((v) => values.add(v));
      if (!f.free) shown.add(f.raw);
    }
  }
  return { values, shown: [...shown] };
}

/**
 * Throws if `text` has a figure that is not in `known`: a section that only
 * restates the report may not introduce numbers of its own.
 */
export function checkFigures(text: string, known: KnownFigures, path: string): void {
  for (const f of figuresIn(text)) {
    if (f.free || f.values.some((v) => known.values.has(v))) continue;
    throw new Error(`${path}: "${f.raw}" is not a figure in the finished sections or the founder's input. `
      + `Use a figure exactly as they give it (${known.shown.slice(0, 40).join(", ")}), or leave the figure out.`);
  }
}

/** True when the text sends the reader elsewhere ("see page 3", "below"): page 1 must stand alone. */
export function pointsElsewhere(text: string): boolean {
  return /\b(see|on) page\b|\bpage \d\b|\b(above|below)\b/i.test(text);
}

/**
 * The per-section fact-check, for claims judged against the report's own
 * sections or the founder's input rather than a web page. The synthetic
 * sources exist only for the checker: the store that comes back is the one
 * given, with no page fetches. These checks only judge: their fixes never
 * apply, because the checker's own rewrites of a summary introduced errors
 * (tests/runs-summary.md). The writer revises instead (reviseFeedback).
 */
export async function factcheckInternal<T>(
  name: string,
  makeCheck: (store: SourceStore) => SectionCheck<T>,
  section: T,
  store: SourceStore,
  internal: Source[],
  options: CheckOptions = {},
): Promise<FactcheckOutput<T>> {
  const out = await factcheckSection(name, makeCheck, section, [...store, ...internal], { ...options, fetch: false });
  return { ...out, sources: store, changed: [] };
}

/**
 * What a writer is told when the internal check found claims it doesn't fully
 * support, or null when every claim is supported.
 */
export function reviseFeedback(log: { id: string; text: string; verdict: string; reason: string }[]): string | null {
  const problems = log.filter((l) => l.verdict !== "supported");
  if (!problems.length) return null;
  return [
    "A fact-check of this draft against the finished sections found these problems:",
    ...problems.map((p) => `- ${p.id} (${p.verdict}): "${p.text}" ${p.reason}`),
    "Rewrite those fields so each says only what the finished sections say, keeping every rule above. Change nothing else, and reply with the whole JSON object again.",
  ].join("\n");
}
