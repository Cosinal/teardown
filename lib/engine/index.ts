import sample from "./fixtures/sample.json";
import type { TeardownReport } from "./types";
import { parseReport } from "./validate";

export type * from "./types";
export { LIMITS, ReportError, parseReport } from "./validate";

/** The design's sample report (Teardown's own idea), validated once at load. */
export const SAMPLE_REPORT: TeardownReport = parseReport(sample);

/**
 * Produce a market teardown for a business idea.
 *
 * STUB: returns the sample report regardless of the idea. Not implemented yet.
 */
export async function runTeardown(idea: string): Promise<TeardownReport> {
  void idea;
  return SAMPLE_REPORT;
}
