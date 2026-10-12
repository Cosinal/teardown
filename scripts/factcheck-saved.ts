// Re-runs fact-check over sections saved by test:ideas, without searching or
// writing again. Prints each claim's verdict; nothing is changed on disk.
// With --apply it also applies the fixes (as the pipeline does), checks the
// fixed section again, and prints the rows and the before/after support rate.
// Billable, but small (a few fact-check calls per idea).
//
//   npx tsx scripts/factcheck-saved.ts tests/runs/<timestamp> [--only c-nav-reconciliation] [--model claude-sonnet-5-5] [--apply]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkClaims, runFactcheck, supportRate } from "../lib/engine/factcheck";
import type { SourceStore } from "../lib/engine/research";
import type { AlternativesSection } from "../lib/engine/sections/alternatives";

try {
  process.loadEnvFile(".env.local");
} catch {}

const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const dir = process.argv[2];
const only = flag("--only");
const model = flag("--model");
const apply = process.argv.includes("--apply");

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
    if (apply) {
      const fixed = await runFactcheck(section, store, { model });
      const after = await checkClaims(fixed.section, store, { model });
      const pct = (r: ReturnType<typeof supportRate>) => `${r.supported}/${r.checked} (${Math.round(r.rate * 100)}%)`;
      const count = (a: string) => fixed.log.filter((l) => l.action === a).length;
      console.log(`\n## ${slug}: before ${pct(supportRate(fixed.results))}, after ${pct(supportRate(after.results))}; `
        + `rewritten ${count("rewritten")}, estimated ${count("estimated")}, dropped ${count("dropped")}, unresolved ${count("unresolved")}; `
        + `$${fixed.run?.cost_usd ?? 0} + verify $${after.run?.cost_usd ?? 0}`);
      for (const l of fixed.log) if (l.action !== "kept") console.log(`- ${l.id} ${l.verdict} → ${l.action}: "${l.text}"${l.result ? ` ⇒ "${l.result}"` : ""}`);
      for (const a of fixed.section.alternatives) console.log(`  row: ${a.name}${a.examples ? ` (${a.examples})` : ""}: ${a.price.text}`);
      console.log(`  gap: ${fixed.section.market_gap.map((p) => p.text).join(" ")}`);
      console.log(`  scorecard: ${fixed.section.scorecard.key_figure.value} ${fixed.section.scorecard.key_figure.unit}, "${fixed.section.scorecard.finding}"`);
      for (const r of after.results) if (r.verdict !== "supported") console.log(`  after: ${r.id} ${r.verdict}: ${r.reason}`);
      continue;
    }
    const { results, run } = await checkClaims(section, store, { model });
    console.log(`\n## ${slug}: ${JSON.stringify(supportRate(results))} $${run?.cost_usd ?? 0} (${run?.model})`);
    for (const r of results) console.log(`- ${r.id} ${r.verdict.toUpperCase()} → ${r.action}: ${r.reason}${r.text ? ` | text: ${r.text}` : ""}${r.method ? ` | method: ${r.method}` : ""}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
