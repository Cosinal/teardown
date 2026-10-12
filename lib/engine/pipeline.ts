import type { IntakeInput } from "./input";
import { runIntake, type IdeaSpec } from "./intake";
import type { StageRun } from "./llm";
import { runResearch, type ResearchOptions, type SearchResponse, type SourceStore } from "./research";
import { runAlternatives, type AlternativesOptions, type AlternativesSection } from "./sections/alternatives";

export interface StageOptions {
  intake?: { model?: string };
  research?: ResearchOptions;
  alternatives?: AlternativesOptions;
}

export interface StagesResult {
  spec: IdeaSpec;
  /** The shared research's sources plus the sections' own. */
  sources: SourceStore;
  /** The shared research's notes. */
  notes: string;
  alternatives: { section: AlternativesSection; notes: string; responses: SearchResponse[] };
  runs: StageRun[];
  /** Raw shared-research responses, for debugging. */
  responses: SearchResponse[];
}

/**
 * Intake, research, then the live sections, without the database.
 * Billable: callers must gate this behind payment (see CLAUDE.md).
 */
export async function runPipeline(input: IntakeInput, options: StageOptions = {}): Promise<StagesResult> {
  const intake = await runIntake(input, options.intake);
  const research = await runResearch(intake.spec, options.research);
  const alt = await runAlternatives(intake.spec, research.sources, research.notes, options.alternatives);
  return {
    spec: intake.spec,
    sources: alt.sources,
    notes: research.notes,
    alternatives: { section: alt.section, notes: alt.notes, responses: alt.responses },
    runs: [intake.run, research.run, alt.run],
    responses: research.responses,
  };
}
