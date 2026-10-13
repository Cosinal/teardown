// One entry per report section the engine writes. `searches` is how many web
// searches the section runs on top of the shared research: only sections that
// need fresh data search (more than 0); the rest write from the shared
// SourceStore and notes. `live` marks sections the engine produces today; the
// others still come from SAMPLE_REPORT.
//
// Order matters: every section's research runs before any writer, so all
// writers see the same sources and share one cached prefix. Verdict and
// summaries read the other sections, so they are written last.

export const SECTIONS = {
  alternatives: { searches: 6, live: true },
  demand_evidence: { searches: 4, live: true },
  economics: { searches: 4, live: true },
  distribution: { searches: 0, live: false },
  blockers: { searches: 0, live: false },
  riskiest_assumptions: { searches: 0, live: false },
  next_tests: { searches: 0, live: false },
  verdict: { searches: 0, live: false },
  page_summaries: { searches: 0, live: false },
} as const satisfies Record<string, { searches: number; live: boolean }>;

export type SectionName = keyof typeof SECTIONS;

export const SECTION_NAMES = Object.keys(SECTIONS) as SectionName[];
