import type { IntakeInput } from "./input";
import { runPipeline, type StageOptions } from "./pipeline";
import type { TeardownReport } from "./types";

export type * from "./types";
export { LIMITS, ReportError, parseReport } from "./validate";

/**
 * Produce a market teardown for a business idea: intake, research, every
 * section of the readout (each fact-checked) and the verdict, written last.
 * Billable: callers must gate this behind payment (see CLAUDE.md).
 */
export async function runTeardown(input: IntakeInput, options: StageOptions = {}): Promise<TeardownReport> {
  return (await runPipeline(input, options)).report;
}
