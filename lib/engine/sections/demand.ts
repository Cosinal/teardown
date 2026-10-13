import { z } from "zod";
import type { CheckClaim, Fixed, SectionCheck } from "../factcheck";
import type { IdeaSpec } from "../intake";
import { STAGE_MODELS, loadPrompt } from "../llm";
import { SOURCE_BUDGETS, buildPartialReport } from "../report";
import type { SourceStore } from "../research";
import { LIMITS } from "../validate";
import { PartSchema, type Part } from "./alternatives";
import { runSectionResearch, runWriter, type SectionOptions } from "./common";
import { SECTIONS } from "./config";

// Demand Evidence: only signals a reader can check. Each signal is a figure a
// cited source states (search volume, forum threads asking for or complaining
// about this, competitor review counts, a market size the source itself
// gives). Weak evidence is said plainly: with fewer than MIN_SIGNALS signals
// left after fact-check, the section is "Thin evidence", rated weak, whatever
// the writer said.

export const DEMAND_RESEARCH_PROMPT = "demand-research.v1";
export const DEMAND_WRITE_PROMPT = "demand-write.v1";

export const SIGNAL_KINDS = ["search", "forum", "reviews", "market_size"] as const;
/** Fewer signals than this is thin evidence. */
export const MIN_SIGNALS = 2;
export const THIN = "Thin evidence";
/** Cited by a scorecard whose key figure is the number of signals. */
export const COUNT_METHOD = "Count of the checkable demand signals listed in this section";

const SignalSchema = z.object({
  kind: z.enum(SIGNAL_KINDS),
  signal: z.string(),
  rating: z.enum(["strong", "mixed", "weak"]),
  value: z.string(),
  detail: PartSchema,
});

export const DemandSchema = z.object({
  signals: z.array(SignalSchema),
  evidence: z.enum(["solid", "mixed", "thin"]),
  scorecard: z.object({
    rating: z.enum(["strong", "mixed", "weak"]),
    /** The `value` of the signal shown as the key figure, or null for the number of signals. */
    headline: z.string().nullable(),
    /** What the headline value counts, e.g. "searches/mo". Ignored when headline is null. */
    unit: z.string(),
    finding: z.string(),
  }),
});

export type DemandSection = z.infer<typeof DemandSchema>;
export type DemandSignalDraft = DemandSection["signals"][number];

/** The headline signal, if the scorecard names one that is still in the section. */
function headlineSignal(section: DemandSection): DemandSignalDraft | undefined {
  return section.scorecard.headline === null ? undefined : section.signals.find((s) => s.value === section.scorecard.headline);
}

/**
 * Makes the verdict follow the signals that are left: too few is thin
 * evidence, rated weak, with a finding that says so; a headline whose signal
 * is gone falls back to the count.
 */
export function settleDemand(section: DemandSection): DemandSection {
  const s = structuredClone(section);
  if (s.scorecard.headline !== null && !headlineSignal(s)) s.scorecard.headline = null;
  if (s.signals.length < MIN_SIGNALS) s.evidence = "thin";
  if (s.evidence === "thin") {
    s.scorecard.rating = "weak";
    if (!s.scorecard.finding.startsWith(THIN)) {
      s.scorecard.finding = `${THIN}: ${s.signals.length ? "only one" : "no"} checkable signal found.`;
    }
  }
  return s;
}

/** The scorecard entry as a part: the headline signal's source, or the count method. */
export function demandScore(section: DemandSection): { rating: DemandSection["scorecard"]["rating"]; key_figure: { value: string; unit: string }; finding: string; part: Part } {
  const sc = section.scorecard;
  const h = headlineSignal(section);
  const n = section.signals.length;
  return {
    rating: sc.rating,
    key_figure: h ? { value: h.value, unit: sc.unit } : { value: String(n), unit: n === 1 ? "signal" : "signals" },
    finding: sc.finding,
    part: h ? { text: sc.finding, source: h.detail.source, estimate: null } : { text: sc.finding, source: null, estimate: COUNT_METHOD },
  };
}

/**
 * Checks the writer's JSON against the section rules and the report's limits.
 * Throws with a message that names the field, so the writer can be told what
 * to fix.
 */
export function parseDemand(raw: unknown, store: SourceStore, maxSources = SOURCE_BUDGETS.demand_evidence): DemandSection {
  const section = DemandSchema.parse(raw);
  const ids = new Set(store.map((s) => s.id));
  const cited = new Set<string>();
  if (section.signals.length > LIMITS.demand_evidence) throw new Error(`signals: at most ${LIMITS.demand_evidence}`);
  section.signals.forEach((s, i) => {
    const path = `signals[${i}]`;
    if (!s.detail.source || s.detail.estimate) throw new Error(`${path}.detail: must cite the source that states the figure (no estimates)`);
    if (!ids.has(s.detail.source)) throw new Error(`${path}.detail: ${s.detail.source} is not in the source list`);
    if (!/\d/.test(s.value)) throw new Error(`${path}.value: must be the figure the source states`);
    for (const [field, text, max] of [["signal", s.signal, 26], ["value", s.value, 6], ["detail.text", s.detail.text, 50]] as const) {
      if (text.length > max) throw new Error(`${path}.${field}: ${text.length} characters, at most ${max}`);
    }
    cited.add(s.detail.source);
  });
  if (new Set(section.signals.map((s) => s.value)).size < section.signals.length) throw new Error("signals: two signals have the same value");
  if (section.signals.length < MIN_SIGNALS && section.evidence !== "thin") throw new Error(`evidence: fewer than ${MIN_SIGNALS} signals is "thin"`);
  const sc = section.scorecard;
  if (section.evidence === "thin" && (sc.rating !== "weak" || !sc.finding.startsWith(THIN))) {
    throw new Error(`scorecard: thin evidence is rated "weak" and the finding starts with "${THIN}"`);
  }
  if (sc.headline !== null && !headlineSignal(section)) throw new Error("scorecard.headline: must be the value of one of the signals, or null");
  if (sc.finding.length > 56) throw new Error(`scorecard.finding: ${sc.finding.length} characters, at most 56`);
  if (/\d/.test(sc.finding)) throw new Error("scorecard.finding: no figures (the key figure carries the number)");
  if (sc.headline === null) cited.add(`estimate:${COUNT_METHOD}`);
  if (cited.size > maxSources) throw new Error(`cites ${cited.size} distinct sources and estimate methods; the limit is ${maxSources}`);
  return section;
}

/** Validates against the section rules and, through a report build, the page limits. */
function parseForReport(raw: unknown, store: SourceStore, maxSources: number): DemandSection {
  const section = parseDemand(raw, store, maxSources);
  buildPartialReport({ demand_evidence: section }, store);
  return section;
}

/** Fact-check's view of the section. A signal whose figure its source doesn't state is dropped, never reworded. */
export function demandCheck(store: SourceStore, maxSources = SOURCE_BUDGETS.demand_evidence): SectionCheck<DemandSection> {
  const index = (id: string) => {
    const m = id.match(/^signals\[(\d+)\]$/);
    if (!m) throw new Error(`unknown claim id ${id}`);
    return Number(m[1]);
  };
  return {
    claims: (section) => section.signals.flatMap((s, i): CheckClaim[] => (s.detail.source ? [{
      id: `signals[${i}]`,
      text: `${s.value} ${s.detail.text}`,
      source: s.detail.source,
      context: `Demand evidence, signal "${s.signal}" (${s.kind.replace("_", " ")}): the figure ${s.value} and what it counts`,
    }] : [])),
    fix(section, id, how): Fixed<DemandSection> | null {
      // A rewrite or estimate would change the words but not the figure shown beside them.
      if (how !== "drop" && how !== "drop_row") return null;
      const s = structuredClone(section);
      s.signals.splice(index(id), 1);
      return { section: settleDemand(s), action: "dropped", result: "(signal dropped)" };
    },
    fallbacks: () => ["drop"],
    rank: (id) => [index(id)],
    row: () => undefined,
    parse: (s) => parseForReport(s, store, maxSources),
    finish: (_draft, fixed) => settleDemand(fixed),
  };
}

/** The section's own instructions, after the shared writer context. */
export function demandPrompt(maxSources = SOURCE_BUDGETS.demand_evidence): string {
  return loadPrompt(DEMAND_WRITE_PROMPT)
    .replaceAll("{{max_sources}}", String(maxSources))
    .replaceAll("{{min_signals}}", String(MIN_SIGNALS));
}

/** The section's own searches, merged into the store. */
export function researchDemand(spec: IdeaSpec, store: SourceStore, notes: string, options: SectionOptions = {}) {
  return runSectionResearch("demand_evidence", {
    spec, store, notes,
    searches: options.maxSearches ?? SECTIONS.demand_evidence.searches,
    model: options.model ?? STAGE_MODELS.demand_evidence,
    prompt: DEMAND_RESEARCH_PROMPT,
  });
}

/** Writes the section from the shared writer context. `store` must be the store the context was built from. */
export function writeDemand(context: string, store: SourceStore, options: SectionOptions = {}) {
  const maxSources = SOURCE_BUDGETS.demand_evidence;
  return runWriter("demand_evidence", {
    model: options.model ?? STAGE_MODELS.demand_evidence,
    context,
    sectionPrompt: demandPrompt(maxSources),
    promptVersion: DEMAND_WRITE_PROMPT,
    parse: (json) => parseForReport(json, store, maxSources),
  });
}
