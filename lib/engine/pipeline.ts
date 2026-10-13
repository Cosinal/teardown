import { factcheckSection, runFactcheck, type CheckOptions, type CheckResult, type FactcheckOutput } from "./factcheck";
import { memoryPageCache } from "./fetch";
import type { IntakeInput } from "./input";
import { runIntake, type IdeaSpec } from "./intake";
import { STAGE_MODELS, type ClaimCheck, type StageRun } from "./llm";
import { runResearch, type ResearchOptions, type SearchResponse, type SourceStore } from "./research";
import { ALTERNATIVES_RESEARCH_PROMPT, writeAlternatives, type AlternativesOptions, type AlternativesSection } from "./sections/alternatives";
import { mergeResearch, searchSection, writerContext, type SectionOptions } from "./sections/common";
import { SECTIONS } from "./sections/config";
import { DEMAND_RESEARCH_PROMPT, demandCheck, writeDemand, type DemandSection } from "./sections/demand";
import { ECONOMICS_RESEARCH_PROMPT, economicsCheck, writeEconomics, type EconomicsSection } from "./sections/economics";

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
  demand_evidence?: SectionOptions;
  economics?: SectionOptions;
  factcheck?: CheckOptions;
}

/** One live section as written and checked. */
export interface SectionResult<T> {
  /** As written, before fact-check. */
  draft: T;
  /** After fact-check fixes. This is what the report uses. */
  section: T;
  /** The section research's notes. */
  notes: string;
  /** Sources this section's research added or extended. */
  added: SourceStore;
  responses: SearchResponse[];
  factcheck: { log: ClaimCheck[]; results: CheckResult[]; excerptResults: CheckResult[] };
}

export interface StagesResult {
  spec: IdeaSpec;
  /** The shared research's sources plus the sections' own, with fact-check's page quotes added to excerpts. */
  sources: SourceStore;
  /** The shared research's notes. */
  notes: string;
  alternatives: SectionResult<AlternativesSection>;
  demand_evidence: SectionResult<DemandSection>;
  economics: SectionResult<EconomicsSection>;
  /** Existing Alternatives' fact-check (also in alternatives.factcheck). */
  factcheck: SectionResult<AlternativesSection>["factcheck"];
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

const LABELS = { alternatives: "Existing Alternatives", demand_evidence: "Demand Evidence", economics: "Economics" } as const;
const RESEARCH_PROMPTS = { alternatives: ALTERNATIVES_RESEARCH_PROMPT, demand_evidence: DEMAND_RESEARCH_PROMPT, economics: ECONOMICS_RESEARCH_PROMPT } as const;
type Live = keyof typeof LABELS;
const LIVE = Object.keys(LABELS) as Live[];

/**
 * Intake, shared research, each live section's own research (all at once,
 * merged in a fixed order), the section writers, then fact-check of each
 * section. Every section's research finishes before any writer starts, so all
 * writers share one cached context: the first writer writes it, and the other
 * two start after it and read it. Fact-check runs one section at a time, so
 * each sees the page quotes the previous one added, with one page cache.
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
  const searched = await Promise.all(LIVE.map((name) => searchSection(name, {
    spec: intake.spec, store: research.sources, notes: research.notes,
    searches: options[name]?.maxSearches ?? SECTIONS[name].searches,
    model: options[name]?.model ?? STAGE_MODELS[name],
    prompt: RESEARCH_PROMPTS[name],
  })));
  let sources = research.sources;
  const own = {} as Record<Live, ReturnType<typeof mergeResearch>>;
  for (const [i, name] of LIVE.entries()) {
    own[name] = mergeResearch(sources, searched[i]);
    sources = own[name].sources;
    await hooks.sources?.(own[name].changed);
    await record(own[name].run);
  }

  await hooks.status?.("writing");
  const context = writerContext(intake.spec, sources, [
    { label: "Shared research", text: research.notes },
    ...LIVE.map((name) => ({ label: `${LABELS[name]} research`, text: own[name].notes })),
  ]);
  const altWrite = await writeAlternatives(context, sources, options.alternatives);
  await record(altWrite.run);
  const [demandWrite, econWrite] = await Promise.all([
    writeDemand(context, sources, options.demand_evidence),
    writeEconomics(context, sources, options.economics),
  ]);
  await record(demandWrite.run);
  await record(econWrite.run);

  await hooks.status?.("factcheck");
  const fc = { ...options.factcheck, pages: options.factcheck?.pages ?? memoryPageCache() };
  const finish = async <T>(name: Live, draft: T, checked: FactcheckOutput<T>): Promise<SectionResult<T>> => {
    sources = checked.sources;
    if (checked.changed.length) await hooks.sources?.(checked.changed);
    await record(checked.run);
    await hooks.section?.(name, { draft, section: checked.section, notes: own[name].notes });
    return {
      draft, section: checked.section, notes: own[name].notes, added: own[name].changed, responses: own[name].responses,
      factcheck: { log: checked.log, results: checked.results, excerptResults: checked.excerptResults },
    };
  };
  const alternatives = await finish("alternatives", altWrite.value, await runFactcheck(altWrite.value, sources, fc));
  const demand = await finish("demand_evidence", demandWrite.value,
    await factcheckSection("demand_evidence", (s) => demandCheck(s), demandWrite.value, sources, fc));
  const economics = await finish("economics", econWrite.value,
    await factcheckSection("economics", (s) => economicsCheck(s), econWrite.value, sources, fc));

  await hooks.status?.("drafted");
  return {
    spec: intake.spec,
    sources,
    notes: research.notes,
    alternatives,
    demand_evidence: demand,
    economics,
    factcheck: alternatives.factcheck,
    writerContext: context,
    runs,
    responses: research.responses,
  };
}
