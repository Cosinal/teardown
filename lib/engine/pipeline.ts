import { factcheckSection, runFactcheck, type CheckOptions, type CheckResult, type FactcheckOutput, type SectionCheck } from "./factcheck";
import { memoryPageCache } from "./fetch";
import type { IntakeInput } from "./input";
import { runIntake, type IdeaSpec } from "./intake";
import { DeadlineError, STAGE_MODELS, currentBudget, type ClaimCheck, type StageRun } from "./llm";
import { buildReport, type Drafts } from "./report";
import { runResearch, type ResearchOptions, type SearchResponse, type Source, type SourceStore } from "./research";
import { ALTERNATIVES_RESEARCH_PROMPT, writeAlternatives, type AlternativesOptions, type AlternativesSection } from "./sections/alternatives";
import { assumptionsCheck, reportSource, writeAssumptions, type AssumptionsSection } from "./sections/assumptions";
import { blockersCheck, writeBlockers, type BlockersSection } from "./sections/blockers";
import { factcheckInternal, reviseFeedback } from "./sections/brief";
import { WriterError, mergeResearch, searchSection, warmWriterCache, writerContext, type Revision, type SectionOptions } from "./sections/common";
import { SECTIONS } from "./sections/config";
import { DEMAND_RESEARCH_PROMPT, demandCheck, writeDemand, type DemandSection } from "./sections/demand";
import { distributionCheck, writeDistribution, type DistributionSection } from "./sections/distribution";
import { ECONOMICS_RESEARCH_PROMPT, economicsCheck, founderPrice, writeEconomics, type EconomicsSection } from "./sections/economics";
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
export type TeardownStatus = "awaiting_payment" | "queued" | "intake" | "research" | "section_research" | "writing" | "factcheck" | "drafted" | "failed" | "done";

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

type RecordRun = (run: StageRun | null) => Promise<void>;

/**
 * Writers run at once. Every writer's spend is recorded, a failed one's too,
 * before the first failure is rethrown (the caller records that one's: see store.ts).
 */
async function together<P extends readonly Promise<{ run: StageRun }>[]>(record: RecordRun, writes: P): Promise<{ -readonly [K in keyof P]: Awaited<P[K]> }> {
  const settled = await Promise.allSettled(writes);
  const failed = settled.find((o) => o.status === "rejected");
  for (const o of settled) {
    if (o.status === "fulfilled") await record(o.value.run);
    else if (o !== failed && o.reason instanceof WriterError) await record(o.reason.run);
  }
  if (failed) throw failed.reason;
  return settled.map((o) => (o as PromiseFulfilledResult<unknown>).value) as { -readonly [K in keyof P]: Awaited<P[K]> };
}

/**
 * The three sections with their own research, written from the shared
 * context. A one-token call writes the context to the cache first, so all
 * three start at once and read it. If that call fails, Existing Alternatives
 * is written first (writing the cache) and the other two after it, as before.
 */
export async function writeFirstSections(context: string, sources: SourceStore, input: IntakeInput, options: StageOptions, record: RecordRun) {
  const rest = () => [
    writeDemand(context, sources, options.demand_evidence),
    writeEconomics(context, sources, options.economics, founderPrice(input)),
  ] as const;
  const warm = await warmWriterCache(options.alternatives?.model ?? STAGE_MODELS.alternatives, context).catch((err: unknown) => {
    if (err instanceof DeadlineError || currentBudget()?.expired) throw err;
    console.error(`Writer cache warm-up failed, writing Existing Alternatives first: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (warm) {
    await record(warm);
    return together(record, [writeAlternatives(context, sources, options.alternatives), ...rest()] as const);
  }
  const [alt] = await together(record, [writeAlternatives(context, sources, options.alternatives)] as const);
  const [demand, econ] = await together(record, rest());
  return [alt, demand, econ] as const;
}

/**
 * Intake, shared research, the three searching sections' own research (all at
 * once, merged in a fixed order), their writers, then fact-check of each.
 * Every section's research finishes before any writer starts, so all writers
 * share one cached context: a one-token call writes it, then the three
 * writers run at once and read it. Then the six sections with no research,
 * each from the same context plus the finished, fact-checked sections so far:
 * Idea, Distribution and Blockers together, then Riskiest Assumptions (ranked
 * by their scorecard), then Next Tests (each checks an assumption by rank),
 * then Verdict (with the page summaries) last. Fact-check runs one section at
 * a time, so each sees the page quotes the previous one added, with one page cache.
 * Within the run's time budget (llm.ts Budget, set by runStages): past the soft
 * limit fact-check revisions are skipped, and at the hard deadline the run throws.
 * Billable: callers must gate this behind payment (see CLAUDE.md).
 */
export async function runPipeline(input: IntakeInput, options: StageOptions = {}, hooks: PipelineHooks = {}): Promise<StagesResult> {
  const runs: StageRun[] = [];
  const record: RecordRun = async (run) => {
    if (!run) return;
    runs.push(run);
    await hooks.run?.(run);
  };
  const status = async (s: TeardownStatus) => {
    currentBudget()?.check();
    await hooks.status?.(s);
  };

  await status("intake");
  const intake = await runIntake(input, options.intake);
  await hooks.intake?.(intake.spec);
  await record(intake.run);
  const spec = intake.spec;

  await status("research");
  const research = await runResearch(spec, options.research);
  await hooks.research?.(research.sources, research.notes);
  await record(research.run);

  // Only the searching sections make research calls; config.ts gives the rest 0 searches.
  await status("section_research");
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

  await status("writing");
  const context = writerContext(spec, sources, [
    { label: "Shared research", text: research.notes },
    ...SEARCHING.map((name) => ({ label: `${LABELS[name]} research`, text: own[name].notes })),
  ]);
  const [altWrite, demandWrite, econWrite] = await writeFirstSections(context, sources, input, options, record);

  await status("factcheck");
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

  // Idea, Riskiest Assumptions and Verdict are checked against the founder's
  // idea or the finished sections. The checker only judges; if it finds a
  // claim it doesn't fully support, the writer revises once with its reasons,
  // and the revision stands if the check supports at least as many claims.
  const supported = (c: FactcheckOutput<unknown>) => c.log.filter((l) => l.verdict === "supported").length;
  const internal = async <T>(
    name: string, draft: T, write: (revise: Revision) => Promise<{ value: T; run: StageRun }>,
    check: () => SectionCheck<T>, own: Source[],
  ): Promise<SectionResult<T>> => {
    const run = (section: T) => factcheckInternal(name, check, section, sources, own, fc);
    let checked = await run(draft);
    const feedback = reviseFeedback(checked.log);
    // A revision is optional: past the soft time limit the checked first draft stands.
    if (feedback && !currentBudget()?.overSoft) {
      try {
        const revised = await write({ draft, feedback });
        await record(revised.run);
        const again = await run(revised.value);
        const better = supported(again) >= supported(checked);
        await record((better ? checked : again).run);
        if (better) checked = again;
      } catch (err) {
        // The first draft stands; the failed revision's spend still counts.
        if (!(err instanceof WriterError)) throw err;
        await record(err.run);
      }
    }
    return finish(name, draft, checked);
  };

  // The sections with no research, in rounds. Each round's writers get the
  // same cached context plus the sections finished before it.
  const drafts: Partial<Drafts> = { alternatives: alternatives.section, demand_evidence: demand.section, economics: economics.section };
  const round = () => laterContext(spec, sources, drafts, context);

  await status("writing");
  let ctx = round();
  const [ideaWrite, distWrite, blockWrite] = await together(record, [writeIdea(ctx), writeDistribution(ctx), writeBlockers(ctx)] as const);
  await status("factcheck");
  const round1 = ctx;
  const idea = await internal("idea", ideaWrite.value, (r) => writeIdea(round1, {}, r), ideaCheck(round1), [ideaSource(round1)]);
  const distribution = await finish("distribution", distWrite.value,
    await factcheckSection("distribution", distributionCheck(ctx), distWrite.value, sources, fc));
  const blockers = await finish("blockers", blockWrite.value,
    await factcheckSection("blockers", blockersCheck(ctx), blockWrite.value, sources, fc));
  Object.assign(drafts, { idea: idea.section, distribution: distribution.section, blockers: blockers.section });

  await status("writing");
  ctx = round();
  const assumeWrite = await writeAssumptions(ctx);
  await record(assumeWrite.run);
  await status("factcheck");
  const round2 = ctx;
  const assumptions = await internal("riskiest_assumptions", assumeWrite.value, (r) => writeAssumptions(round2, {}, r),
    assumptionsCheck(round2), [reportSource(round2)]);
  drafts.riskiest_assumptions = assumptions.section;

  await status("writing");
  ctx = round();
  const testsWrite = await writeTests(ctx);
  await record(testsWrite.run);
  const tests = await finish("next_tests", testsWrite.value, await factcheckSection("next_tests", testsCheck(ctx), testsWrite.value, sources, fc));
  drafts.next_tests = tests.section;

  // Last: the verdict reads the other eight sections after their fact-check.
  ctx = round();
  const verdictWrite = await writeVerdict(ctx);
  await record(verdictWrite.run);
  await status("factcheck");
  const round4 = ctx;
  const verdict = await internal("verdict", verdictWrite.value, (r) => writeVerdict(round4, {}, r), verdictCheck(round4), [reportSource(round4)]);
  drafts.verdict = verdict.section;

  const report = buildReport(drafts as Drafts, sources, ctx.build);
  await hooks.report?.(report);
  await status("done");
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
