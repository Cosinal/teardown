import type { IdeaSpec } from "../intake";
import { buildPartialReport, laterBudgets, sourcesUsed, type BuildOptions, type Drafts } from "../report";
import type { SourceStore } from "../research";
import type { PartialReport } from "../validate";
import { knownFigures, reportBrief, specText, type KnownFigures } from "./brief";

// What a section written from the others (searches: 0 in config.ts) gets: the
// shared writer context, unchanged so it is read from cache, plus the finished
// sections so far as text, plus the figures it may use.

export interface LaterContext {
  spec: IdeaSpec;
  /** The current store, with fact-check's page quotes. Ids are the ones the writer context shows. */
  store: SourceStore;
  /** The finished, fact-checked sections this section writes from. */
  drafts: Partial<Drafts>;
  /** `drafts` built as a validated partial report. */
  report: PartialReport;
  /** `report` as text: what the writer reads and what summaries are checked against. */
  brief: string;
  /** Figures in the finished sections and the founder's input. */
  known: KnownFigures;
  /** The shared writer context, byte-identical to the first writers' so it is read from cache. */
  context: string;
  /** The block after the context: the brief and the figures list. */
  finished: string;
  build: BuildOptions;
  /** Distinct sources Distribution and Blockers may each add to the report. */
  budgets: { distribution: number; blockers: number };
}

export function laterContext(spec: IdeaSpec, store: SourceStore, drafts: Partial<Drafts>, context: string): LaterContext {
  const build: BuildOptions = { billing: spec.revenue_model.billing };
  const report = buildPartialReport(drafts, store, build);
  const brief = reportBrief(report);
  const known = knownFigures(brief, specText(spec));
  const { alternatives, demand_evidence, economics } = drafts;
  const budgets = laterBudgets(sourcesUsed({ alternatives, demand_evidence, economics }, store, build));
  const finished = [
    "# Finished sections",
    "The report's sections written so far, after fact-check. (found) marks a figure taken from a cited source, (estimated) the report's own calculation. The section you write must agree with them: it may add to them but never contradict them.",
    brief,
    "# Figures",
    `Every figure in the finished sections and the founder's input, as written: ${known.shown.join(", ")}.`,
    "When you state one of these figures, copy it exactly as written here. Never recompute one, round it differently or restate it in a new form (a margin as a dollar amount, a monthly figure as a yearly one).",
  ].join("\n\n");
  return { spec, store, drafts, report, brief, known, context, finished, build, budgets };
}
