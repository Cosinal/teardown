// Re-runs fact-check over sections saved by test:ideas, without searching or
// writing again. Prints each claim's verdict; nothing is changed on disk.
// Billable, but small (one fact-check call per idea).
//
//   npx tsx scripts/factcheck-saved.ts tests/runs/<timestamp> [--only c-nav-reconciliation] [--model claude-sonnet-5-5]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkClaims, supportRate } from "../lib/engine/factcheck";
import type { SourceStore } from "../lib/engine/research";
import type { AlternativesSection } from "../lib/engine/sections/alternatives";

try {
  process.loadEnvFile(".env.local");
} catch {}

const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const dir = process.argv[2];
const only = flag("--only");
const model = flag("--model");

async function main() {
  if (!dir || !existsSync(dir)) {
    console.error("Usage: npx tsx scripts/factcheck-saved.ts tests/runs/<timestamp> [--only slug] [--model id]");
    process.exit(1);
  }
  const slugs = readdirSync(dir).filter((s) => existsSync(join(dir, s, "alternatives.json")) && (!only || s === only));
  for (const slug of slugs) {
    const read = (f: string) => JSON.parse(readFileSync(join(dir, slug, f), "utf8"));
    // Runs from before fact-check saved the written section as alternatives.json; later runs save the draft separately.
    const section: AlternativesSection = existsSync(join(dir, slug, "alternatives-draft.json")) ? read("alternatives-draft.json") : read("alternatives.json");
    const store: SourceStore = read("sources.json");
    const { results, run } = await checkClaims(section, store, { model });
    console.log(`\n## ${slug}: ${JSON.stringify(supportRate(results))} $${run?.cost_usd ?? 0} (${run?.model})`);
    for (const r of results) console.log(`- ${r.id} ${r.verdict.toUpperCase()} → ${r.action}: ${r.reason}${r.text ? ` | text: ${r.text}` : ""}${r.method ? ` | method: ${r.method}` : ""}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
