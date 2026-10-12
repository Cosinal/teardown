import { runFactcheck, type CheckResult } from "./factcheck";
import type { IntakeInput } from "./input";
import { runIntake, type IdeaSpec } from "./intake";
import type { ClaimCheck, StageRun } from "./llm";
import { runResearch, type ResearchOptions, type SearchResponse, type SourceStore } from "./research";
import { researchAlternatives, writeAlternatives, type AlternativesOptions, type AlternativesSection } from "./sections/alternatives";
import { writerContext } from "./sections/common";

/**
 * queued -> intake -> research -> section_research -> writing -> factcheck ->
 * drafted, or failed at any step. "drafted" means the live sections are
 * written and checked but there is no report yet. "done" means a report exists.
 */
export type TeardownStatus = "queued" | "intake" | "research" | "section_research" | "writing" | "factcheck" | "drafted" | "failed" | "done";

export interface StageOptions {
  intake?: { model?: string };
  research?: ResearchOptions;
  alternatives?: AlternativesOptions;
  factcheck?: { model?: string };
}

export interface StagesResult {
  spec: IdeaSpec;
  /** The shared research's sources plus the sections' own. */
  sources: SourceStore;
  /** The shared research's notes. */
  notes: string;
  alternatives: {
    /** As written, before fact-check. */
    draft: AlternativesSection;
    /** After fact-check fixes. This is what the report uses. */
    section: AlternativesSection;
    notes: string;
    /** Sources this section's research added or extended. */
    added: SourceStore;
    responses: SearchResponse[];
  };
  factcheck: { log: ClaimCheck[]; results: CheckResult[] };
  /** The cached prefix every section writer shares. */
  writerContext: string;
  runs: StageRun[];
  /** Raw shared-research responses, for debugging. */
  responses: SearchResponse[];
}

/** Called as the pipeline goes, so a caller can record each step (see store.ts). */
export interface PipelineHooks {
  status?(status: TeardownStatus): Promise<void>;
  run?(run: StageRun): Promise<void>;
  intake?(spec: IdeaSpec): Promise<void>;
  research?(sources: SourceStore, notes: string): Promise<void>;
  /** Sources that are new or gained quotes since the last call. */
  sources?(changed: SourceStore): Promise<void>;
  section?(name: string, data: unknown): Promise<void>;
}

/**
 * Intake, shared research, each live section's own research, the section
 * writers, then fact-check. Every section's research finishes before any
 * writer starts, so all writers share one cached context.
 * Billable: callers must gate this behind payment (see CLAUDE.md).
 */
export async function runPipeline(input: IntakeInput, options: StageOptions = {}, hooks: PipelineHooks = {}): Promise<StagesResult> {
  const runs: StageRun[] = [];
  const record = async (run: StageRun | null) => {
    if (!run) return;
    runs.push(run);
    await hooks.run?.(run);
  };

  await hooks.status?.("intake");
  const intake = await runIntake(input, options.intake);
  await hooks.intake?.(intake.spec);
  await record(intake.run);

  await hooks.status?.("research");
  const research = await runResearch(intake.spec, options.research);
  await hooks.research?.(research.sources, research.notes);
  await record(research.run);

  // Sections with searches > 0 add to the store; the rest are no-ops.
  await hooks.status?.("section_research");
  const altResearch = await researchAlternatives(intake.spec, research.sources, research.notes, options.alternatives);
  await hooks.sources?.(altResearch.changed);
  await record(altResearch.run);
  const sources = altResearch.sources;

  await hooks.status?.("writing");
  const context = writerContext(intake.spec, sources, [
    { label: "Shared research", text: research.notes },
    { label: "Existing Alternatives research", text: altResearch.notes },
  ]);
  const altWrite = await writeAlternatives(context, sources, options.alternatives);
  await record(altWrite.run);

  await hooks.status?.("factcheck");
  const checked = await runFactcheck(altWrite.value, sources, options.factcheck);
  await record(checked.run);
  await hooks.section?.("alternatives", { draft: altWrite.value, section: checked.section, notes: altResearch.notes });

  await hooks.status?.("drafted");
  return {
    spec: intake.spec,
    sources,
    notes: research.notes,
    alternatives: {
      draft: altWrite.value, section: checked.section, notes: altResearch.notes, added: altResearch.changed, responses: altResearch.responses,
    },
    factcheck: { log: checked.log, results: checked.results },
    writerContext: context,
    runs,
    responses: research.responses,
  };
}
