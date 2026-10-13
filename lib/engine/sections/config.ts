// One entry per report section the engine writes. `searches` is how many web
// searches the section runs on top of the shared research: only sections that
// need fresh data search (more than 0); the rest write from the shared
// SourceStore and notes plus the finished sections, with no research calls.
//
// Order matters: every section's research runs before any writer, so all
// writers see the same sources and share one cached prefix. The sections with
// 0 searches are written after the three that search have been fact-checked,
// in this order: Idea, Distribution and Blockers together, then Riskiest
// Assumptions, then Next Tests, then Verdict (with the page summaries) last.

export const SECTIONS = {
  alternatives: { searches: 6 },
  demand_evidence: { searches: 4 },
  economics: { searches: 4 },
  idea: { searches: 0 },
  distribution: { searches: 0 },
  blockers: { searches: 0 },
  riskiest_assumptions: { searches: 0 },
  next_tests: { searches: 0 },
  verdict: { searches: 0 },
} as const satisfies Record<string, { searches: number }>;

export type SectionName = keyof typeof SECTIONS;

export const SECTION_NAMES = Object.keys(SECTIONS) as SectionName[];
