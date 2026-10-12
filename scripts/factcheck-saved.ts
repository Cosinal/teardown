// Re-runs fact-check over sections saved by test:ideas, without searching or
// writing again. Prints each claim's verdict; nothing is changed on disk.
// With --apply it also applies the fixes (as the pipeline does), checks the
// fixed section again, and prints the rows and the before/after support rate.
// Claims the excerpt doesn't fully support are re-checked against the fetched
// page (--no-fetch skips that); pages are cached for the whole script run.
// --repeat N checks each draft N times and reports how many claims changed
// verdict between runs. Billable, but small (Haiku calls, a cent or two per idea).
//
//   npx tsx scripts/factcheck-saved.ts tests/runs/<timestamp> [--only c-nav-reconciliation] [--model claude-sonnet-5-5] [--apply] [--repeat 3] [--no-fetch]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { checkClaims, runFactcheck, supportRate, type CheckOptions } from "../lib/engine/factcheck";
import { memoryPageCache } from "../lib/engine/fetch";
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
const repeat = Number(flag("--repeat") ?? 1);
const opts: CheckOptions = { model, pages: memoryPageCache(), fetch: !process.argv.includes("--no-fetch") };
const pct = (r: ReturnType<typeof supportRate>) => `${r.supported}/${r.checked} (${Math.round(r.rate * 100)}%)`;

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
      const fixed = await runFactcheck(section, store, opts);
      const after = await checkClaims(fixed.section, fixed.sources, opts);
      const count = (a: string) => fixed.log.filter((l) => l.action === a).length;
      const pages = fixed.run?.pages ?? [];
      console.log(`\n## ${slug}: excerpt ${pct(supportRate(fixed.excerptResults))}, with pages ${pct(supportRate(fixed.results))}, after ${pct(supportRate(after.results))}; `
        + `rewritten ${count("rewritten")}, estimated ${count("estimated")}, dropped ${count("dropped")}, unresolved ${count("unresolved")}; `
        + `pages ${pages.filter((p) => p.ok).length} ok / ${pages.filter((p) => !p.ok).length} failed; `
        + `$${fixed.run?.cost_usd ?? 0} (re-checks $${fixed.run?.recheck_cost_usd ?? 0}) + verify $${after.run?.cost_usd ?? 0}`);
      for (const p of pages) if (!p.ok) console.log(`  fetch failed: ${p.source} ${p.error} ${p.url}`);
      for (const l of fixed.log) {
        const shift = l.excerpt_verdict ? `${l.excerpt_verdict} → ` : "";
        console.log(`- ${l.id} ${shift}${l.verdict} [${l.basis ?? "excerpt"}] → ${l.action}: "${l.text}"${l.result ? ` ⇒ "${l.result}"` : ""}${l.quote ? `\n    quote: "${l.quote}"` : ""}`);
      }
      for (const a of fixed.section.alternatives) console.log(`  row: ${a.name}${a.examples ? ` (${a.examples})` : ""}: ${a.price.text}`);
      console.log(`  gap: ${fixed.section.market_gap.map((p) => p.text).join(" ")}`);
      console.log(`  scorecard: ${fixed.section.scorecard.key_figure.value} ${fixed.section.scorecard.key_figure.unit}, "${fixed.section.scorecard.finding}"`);
      for (const r of after.results) if (r.verdict !== "supported") console.log(`  after: ${r.id} ${r.verdict}: ${r.reason}`);
      continue;
    }
    const runs: Awaited<ReturnType<typeof checkClaims>>[] = [];
    for (let n = 0; n < repeat; n++) runs.push(await checkClaims(section, store, opts));
    for (const [n, { results, excerptResults, run }] of runs.entries()) {
      console.log(`\n## ${slug} run ${n + 1}: excerpt ${pct(supportRate(excerptResults))}, with pages ${pct(supportRate(results))}; $${run?.cost_usd ?? 0} (re-checks $${run?.recheck_cost_usd ?? 0}, ${run?.model})`);
      if (repeat === 1) for (const r of results) console.log(`- ${r.id} ${r.excerpt_verdict ?? ""} → ${r.verdict.toUpperCase()} [${r.basis}] → ${r.action}: ${r.reason}${r.text ? ` | text: ${r.text}` : ""}${r.quote ? ` | quote: ${r.quote}` : ""}`);
    }
    if (repeat > 1) {
      const flips = (key: "results" | "excerptResults") => runs[0].claims.filter((_, i) => new Set(runs.map((r) => r[key][i].verdict)).size > 1).map((c) => c.id);
      console.log(`  verdict changed across ${repeat} runs: excerpt ${flips("excerptResults").length}/${runs[0].claims.length}, final ${flips("results").length}/${runs[0].claims.length} ${flips("results").join(", ")}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
