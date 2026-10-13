import { factcheckSection, runFactcheck, type CheckOptions, type CheckResult, type FactcheckOutput } from "./factcheck";
import { memoryPageCache } from "./fetch";
import type { IntakeInput } from "./input";
import { runIntake, type IdeaSpec } from "./intake";
import { STAGE_MODELS, type ClaimCheck, type StageRun } from "./llm";
import { buildReport, type Drafts } from "./report";
import { runResearch, type ResearchOptions, type SearchResponse, type SourceStore } from "./research";
import { ALTERNATIVES_RESEARCH_PROMPT, writeAlternatives, type AlternativesOptions, type AlternativesSection } from "./sections/alternatives";
import { assumptionsCheck, reportSource, writeAssumptions, type AssumptionsSection } from "./sections/assumptions";
import { blockersCheck, writeBlockers, type BlockersSection } from "./sections/blockers";
import { factcheckInternal } from "./sections/brief";
import { mergeResearch, searchSection, writerContext, type SectionOptions } from "./sections/common";
import { SECTIONS } from "./sections/config";
import { DEMAND_RESEARCH_PROMPT, demandCheck, writeDemand, type DemandSection } from "./sections/demand";
import { distributionCheck, writeDistribution, type DistributionSection } from "./sections/distribution";
import { ECONOMICS_RESEARCH_PROMPT, economicsCheck, writeEconomics, type EconomicsSection } from "./sections/economics";
import { ideaCheck, ideaSource, writeIdea, type IdeaSection } from "./sections/idea";
import { laterContext } from "./sections/later";
import { testsCheck, writeTests, type TestsSection } from "./sections/tests";
import { verdictCheck, writeVerdict, type VerdictSection } from "./sections/verdict";
import type { TeardownReport } from "./types";

/**
 * queued -> intake -> research -> section_research -> writing -> factcheck ->
 * (writing -> factcheck, once per round of the sections written from the
 * others) -> done, or failed at any step. "done" means a report exists.
 * "drafted" is kept for older rows: their searching sections were written
 * and checked, with no report.
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

/** One section as written and checked. */
export interface SectionResult<T> {
  /** As written, before fact-check. */
  draft: T;
  /** After fact-check fixes. This is what the report uses. */
  section: T;
  /** The section research's notes. Empty for sections with no searches. */
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
  idea: SectionResult<IdeaSection>;
  distribution: SectionResult<DistributionSection>;
  blockers: SectionResult<BlockersSection>;
  riskiest_assumptions: SectionResult<AssumptionsSection>;
  next_tests: SectionResult<TestsSection>;
  verdict: SectionResult<VerdictSection>;
  /** Existing Alternatives' fact-check (also in alternatives.factcheck). */
  factcheck: SectionResult<AlternativesSection>["factcheck"];
  /** The cached prefix every section writer shares. */
  writerContext: string;
  report: TeardownReport;
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
  report?(report: TeardownReport): Promise<void>;
}

const LABELS = { alternatives: "Existing Alternatives", demand_evidence: "Demand Evidence", economics: "Economics" } as const;
const RESEARCH_PROMPTS = { alternatives: ALTERNATIVES_RESEARCH_PROMPT, demand_evidence: DEMAND_RESEARCH_PROMPT, economics: ECONOMICS_RESEARCH_PROMPT } as const;
type Searching = keyof typeof LABELS;
const SEARCHING = Object.keys(LABELS) as Searching[];

/**
 * Intake, shared research, the three searching sections' own research (all at
 * once, merged in a fixed order), their writers, then fact-check of each.
 * Every section's research finishes before any writer starts, so all writers
 * share one cached context: the first writer writes it, and the rest read it.
 * Then the six sections with no research, each from the same context plus the
 * finished, fact-checked sections so far: Idea, Distribution and Blockers
 * together, then Riskiest Assumptions, then Next Tests, then Verdict (with the
 * page summaries) last. Fact-check runs one section at a time, so each sees
 * the page quotes the previous one added, with one page cache.
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
  const spec = intake.spec;

  await hooks.status?.("research");
  const research = await runResearch(spec, options.research);
  await hooks.research?.(research.sources, research.notes);
  await record(research.run);

  // Only the searching sections make research calls; config.ts gives the rest 0 searches.
  await hooks.status?.("section_research");
  const searched = await Promise.all(SEARCHING.map((name) => searchSection(name, {
    spec, store: research.sources, notes: research.notes,
    searches: options[name]?.maxSearches ?? SECTIONS[name].searches,
    model: options[name]?.model ?? STAGE_MODELS[name],
    prompt: RESEARCH_PROMPTS[name],
  })));
  let sources = research.sources;
  const own = {} as Record<Searching, ReturnType<typeof mergeResearch>>;
  for (const [i, name] of SEARCHING.entries()) {
    own[name] = mergeResearch(sources, searched[i]);
    sources = own[name].sources;
    await hooks.sources?.(own[name].changed);
    await record(own[name].run);
  }

  await hooks.status?.("writing");
  const context = writerContext(spec, sources, [
    { label: "Shared research", text: research.notes },
    ...SEARCHING.map((name) => ({ label: `${LABELS[name]} research`, text: own[name].notes })),
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
  const finish = async <T>(name: string, draft: T, checked: FactcheckOutput<T>, research?: ReturnType<typeof mergeResearch>): Promise<SectionResult<T>> => {
    sources = checked.sources;
    if (checked.changed.length) await hooks.sources?.(checked.changed);
    await record(checked.run);
    const notes = research?.notes ?? "";
    await hooks.section?.(name, { draft, section: checked.section, notes });
    return {
      draft, section: checked.section, notes, added: research?.changed ?? [], responses: research?.responses ?? [],
      factcheck: { log: checked.log, results: checked.results, excerptResults: checked.excerptResults },
    };
  };
  const alternatives = await finish("alternatives", altWrite.value, await runFactcheck(altWrite.value, sources, fc), own.alternatives);
  const demand = await finish("demand_evidence", demandWrite.value,
    await factcheckSection("demand_evidence", (s) => demandCheck(s), demandWrite.value, sources, fc), own.demand_evidence);
  const economics = await finish("economics", econWrite.value,
    await factcheckSection("economics", (s) => economicsCheck(s), econWrite.value, sources, fc), own.economics);

  // The sections with no research, in rounds. Each round's writers get the
  // same cached context plus the sections finished before it.
  const drafts: Partial<Drafts> = { alternatives: alternatives.section, demand_evidence: demand.section, economics: economics.section };
  const round = () => laterContext(spec, sources, drafts, context);

  await hooks.status?.("writing");
  let ctx = round();
  const [ideaWrite, distWrite, blockWrite] = await Promise.all([writeIdea(ctx), writeDistribution(ctx), writeBlockers(ctx)]);
  for (const w of [ideaWrite, distWrite, blockWrite]) await record(w.run);
  await hooks.status?.("factcheck");
  const idea = await finish("idea", ideaWrite.value,
    await factcheckInternal("idea", ideaCheck(ctx), ideaWrite.value, sources, [ideaSource(ctx)], fc));
  const distribution = await finish("distribution", distWrite.value,
    await factcheckSection("distribution", distributionCheck(ctx), distWrite.value, sources, fc));
  const blockers = await finish("blockers", blockWrite.value,
    await factcheckSection("blockers", blockersCheck(ctx), blockWrite.value, sources, fc));
  Object.assign(drafts, { idea: idea.section, distribution: distribution.section, blockers: blockers.section });

  await hooks.status?.("writing");
  ctx = round();
  const assumeWrite = await writeAssumptions(ctx);
  await record(assumeWrite.run);
  await hooks.status?.("factcheck");
  const assumptions = await finish("riskiest_assumptions", assumeWrite.value,
    await factcheckInternal("riskiest_assumptions", assumptionsCheck(ctx), assumeWrite.value, sources, [reportSource(ctx)], fc));
  drafts.riskiest_assumptions = assumptions.section;

  await hooks.status?.("writing");
  ctx = round();
  const testsWrite = await writeTests(ctx);
  await record(testsWrite.run);
  const tests = await finish("next_tests", testsWrite.value, await factcheckSection("next_tests", testsCheck(ctx), testsWrite.value, sources, fc));
  drafts.next_tests = tests.section;

  // Last: the verdict reads the other eight sections after their fact-check.
  ctx = round();
  const verdictWrite = await writeVerdict(ctx);
  await record(verdictWrite.run);
  await hooks.status?.("factcheck");
  const verdict = await finish("verdict", verdictWrite.value,
    await factcheckInternal("verdict", verdictCheck(ctx), verdictWrite.value, sources, [reportSource(ctx)], fc));
  drafts.verdict = verdict.section;

  const report = buildReport(drafts as Drafts, sources, ctx.build);
  await hooks.report?.(report);
  await hooks.status?.("done");
  return {
    spec,
    sources,
    notes: research.notes,
    alternatives,
    demand_evidence: demand,
    economics,
    idea,
    distribution,
    blockers,
    riskiest_assumptions: assumptions,
    next_tests: tests,
    verdict,
    factcheck: alternatives.factcheck,
    writerContext: context,
    report,
    runs,
    responses: research.responses,
  };
}
