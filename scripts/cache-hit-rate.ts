// Prints the prompt cache hit rate per stage for runs saved by test:ideas:
// cache reads over all input tokens (uncached + cache writes + reads), from
// each idea's runs.json. Costs are recomputed from usage at today's prices, so
// older runs compare fairly. Reads files only; no API calls.
//
//   npx tsx scripts/cache-hit-rate.ts [tests/runs/<timestamp>]   (default: the latest)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cacheReport, costUsd, type StageRun } from "../lib/engine/llm";

const root = "tests/runs";
const dir = process.argv[2] ?? join(root, readdirSync(root).filter((d) => !d.startsWith(".")).sort().at(-1) ?? "");
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

for (const idea of readdirSync(dir).sort()) {
  const file = join(dir, idea, "runs.json");
  if (!existsSync(file)) continue;
  const runs = (JSON.parse(readFileSync(file, "utf8")) as StageRun[]).map((r) => {
    try {
      return { ...r, cost_usd: costUsd(r.model, r.usage) };
    } catch {
      return r; // A model with no price keeps its stored cost.
    }
  });
  console.log(`\n${idea}`);
  console.table(cacheReport(runs).map(({ stage, runs: n, usage: u, hit_rate, cost_usd }) => ({
    stage, runs: n, uncached: u.input_tokens, written: u.cache_creation_input_tokens, read: u.cache_read_input_tokens, hit: pct(hit_rate), usd: cost_usd,
  })));
}
