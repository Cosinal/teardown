import type { IntakeInput } from "./input";
import { runPipeline, type StageOptions } from "./pipeline";
import { buildReport } from "./report";
import type { TeardownReport } from "./types";

export type * from "./types";
export { LIMITS, ReportError, parseReport } from "./validate";
export { SAMPLE_REPORT } from "./report";

/**
 * Produce a market teardown for a business idea: intake, research and the
 * Existing Alternatives, Demand Evidence and Economics sections (fact-checked)
 * are live; every other section still comes from SAMPLE_REPORT. Billable: callers must gate this behind payment (see CLAUDE.md).
 */
export async function runTeardown(input: IntakeInput, options: StageOptions = {}): Promise<TeardownReport> {
  const r = await runPipeline(input, options);
  return buildReport(r.alternatives.section, r.sources, { demand: r.demand_evidence.section, economics: r.economics.section });
}
