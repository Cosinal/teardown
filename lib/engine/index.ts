import type { TeardownReport } from "./types";

export type { Competitor, Source, TeardownReport } from "./types";

/**
 * Produce a market teardown for a business idea.
 *
 * STUB: returns a fixed, clearly-labelled placeholder report. Not implemented yet.
 */
export async function runTeardown(idea: string): Promise<TeardownReport> {
  return {
    competitors: [
      {
        name: "Example Competitor (stub)",
        url: "https://example.com",
        pricing: "Not implemented",
        target_customer: "Not implemented",
      },
    ],
    pricing_summary: `Stub report for: ${idea}`,
    customer_segments: [],
    market_gaps: [],
    sources: [],
  };
}
