// Prints where the wall-clock time went for recent teardown runs, from the
// stage runs stored on each row. Read-only: one SELECT, no API calls.
//
//   npx tsx --env-file=.env.local scripts/stage-timings.ts [id ...]   (default: the 5 latest runs)

import { sql } from "../lib/db";
import type { StageRun } from "../lib/engine/llm";

async function main() {
  const ids = process.argv.slice(2);
  const rows = ids.length
    ? await sql()`SELECT id, status, error, cost_usd, created_at, updated_at, stage_runs FROM teardowns WHERE id = ANY(${ids})`
    : await sql()`SELECT id, status, error, cost_usd, created_at, updated_at, stage_runs FROM teardowns
        WHERE jsonb_array_length(stage_runs) > 0 ORDER BY created_at DESC LIMIT 5`;

  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  for (const row of rows) {
    const runs = (row.stage_runs as StageRun[]).toSorted((a, b) => a.started_at.localeCompare(b.started_at));
    if (!runs.length) continue;
    const t0 = Date.parse(runs[0].started_at);
    const end = Math.max(...runs.map((r) => Date.parse(r.started_at) + r.duration_ms));
    console.log(`\n${row.id}  ${row.status}${row.error ? ` (${row.error})` : ""}  $${row.cost_usd}  wall ${s(end - t0)}`);
    console.table(runs.map((r) => ({
      stage: r.stage, step: r.step ?? (r.section ? `check ${r.section}` : ""),
      start: s(Date.parse(r.started_at) - t0), took: s(r.duration_ms),
      retries: r.retries?.length ?? 0, pages: r.pages?.length ?? 0, usd: r.cost_usd,
    })));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
