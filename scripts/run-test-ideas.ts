// Runs the pipeline (intake, research, the Existing Alternatives, Demand
// Evidence and Economics sections, fact-check of each) on the three test ideas,
// builds the partial report (live sections, the rest from the sample), and
// writes everything to tests/runs/<timestamp>/. Billable: each idea costs real
// API money.
//
// Test-only extra, costed separately from the pipeline: a second fact-check
// pass on each checked section, with the same page cache (the "after" support
// rate; --no-verify skips it).
//
//   npm run test:ideas            # also stores teardowns + sources in Neon when DATABASE_URL is set
//   npm run test:ideas -- --no-db # API only
//   npm run test:ideas -- --only b-dog-grooming
//   npm run test:ideas -- --max-searches 10 --research-model claude-opus-5-5 --intake-model claude-opus-5-5
//   npm run test:ideas -- --alternatives-searches 4 --demand-searches 3 --economics-searches 3
//
// Needs ANTHROPIC_API_KEY (and optionally DATABASE_URL) in .env.local or the environment.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkClaimList, collectClaims, supportRate, type CheckResult } from "../lib/engine/factcheck";
import { memoryPageCache, type PageCache } from "../lib/engine/fetch";
import type { IntakeInput } from "../lib/engine/input";
import { ZERO_USAGE, costUsd, type StageRun, type TokenUsage } from "../lib/engine/llm";
import { runPipeline, type StageOptions, type StagesResult } from "../lib/engine/pipeline";
import { buildReport } from "../lib/engine/report";
import { SECTION_NAMES } from "../lib/engine/sections/config";
import { demandCheck, demandScore } from "../lib/engine/sections/demand";
import { computeEconomics, economicsCheck, money } from "../lib/engine/sections/economics";
import { createTeardown, dbPageCache, runStages } from "../lib/engine/store";

try {
  process.loadEnvFile(".env.local");
} catch {}

// Each test idea as given, split into the intake form's fields.
// `key` lists competitors the alternatives section should surface, checked in the summary.
const IDEAS: { slug: string; brief: string; input: IntakeInput; key?: string[] }[] = [
  {
    slug: "a-teardown",
    brief: "One-page business idea teardowns for first-time founders, $5–10 per report, online",
    input: {
      idea: "One-page business idea teardowns: a market readout of competitors, pricing, customers and gaps, built for a go/no-go decision.",
      target_customer: "First-time founders",
      price: "$5–10 per report",
      billing: "one_time",
      geography: "online",
    },
  },
  {
    slug: "b-dog-grooming",
    brief: "Mobile dog grooming van in Halifax, NS, $80 per groom",
    input: {
      idea: "A mobile dog grooming van that grooms dogs at the owner's home.",
      target_customer: "Dog owners in Halifax",
      price: "$80 per groom",
      billing: "one_time",
      geography: "Halifax, NS, Canada",
    },
  },
  {
    slug: "c-nav-reconciliation",
    brief: "AI tool that reconciles private-markets NAV statements for pension fund operations teams, $2,000/month, Canada and US",
    input: {
      idea: "An AI tool that reconciles private-markets NAV statements.",
      target_customer: "Pension fund operations teams",
      price: "$2,000/month",
      billing: "subscription",
      geography: "Canada and US",
    },
    // LP-document tools (Canoe, FundRecs) and reconciliation / fund-ops platforms (Limina, Arcesium, FundGuard).
    key: ["Canoe", "FundRecs", "Limina", "Arcesium", "FundGuard"],
  },
];

const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const only = flag("--only");
const options: StageOptions = {
  intake: { model: flag("--intake-model") },
  research: { model: flag("--research-model"), maxSearches: flag("--max-searches") ? Number(flag("--max-searches")) : undefined },
  alternatives: {
    model: flag("--alternatives-model"),
    maxSearches: flag("--alternatives-searches") ? Number(flag("--alternatives-searches")) : undefined,
  },
  demand_evidence: { maxSearches: flag("--demand-searches") ? Number(flag("--demand-searches")) : undefined },
  economics: { maxSearches: flag("--economics-searches") ? Number(flag("--economics-searches")) : undefined },
  factcheck: { model: flag("--factcheck-model") },
};
const verify = !process.argv.includes("--no-verify");
const ideas = only ? IDEAS.filter((i) => i.slug === only) : IDEAS;
const useDb = !process.argv.includes("--no-db") && !!process.env.DATABASE_URL;

/** Runs one idea. Its page cache is returned so the verify pass reuses the fetched pages. */
async function run(input: IntakeInput): Promise<StagesResult & { id: string | null; pages: PageCache }> {
  if (useDb) {
    const id = await createTeardown(input);
    return { id, pages: dbPageCache(id), ...(await runStages(id, options)) };
  }
  const pages = memoryPageCache();
  return { id: null, pages, ...(await runPipeline(input, { ...options, factcheck: { ...options.factcheck, pages } })) };
}

/** Which of the idea's key competitors appear in the section's text, and in any source or note. */
function keyCompetitors(idea: (typeof IDEAS)[number], r: StagesResult) {
  if (!idea.key) return { in_section: "–", in_sources: "–" };
  const has = (text: string) => idea.key!.filter((k) => text.toLowerCase().includes(k.toLowerCase()));
  const section = has(JSON.stringify(r.alternatives.section));
  const sources = has([...r.sources.map((s) => `${s.url} ${s.title} ${s.excerpt}`), r.notes, r.alternatives.notes].join(" "));
  const show = (found: string[]) => `${found.length}/${idea.key!.length}${found.length ? `: ${found.join(", ")}` : ""}`;
  return { in_section: show(section), in_sources: show(sources) };
}

// Search results carry large opaque encrypted_content; drop it from the saved raw responses.
function stripEncrypted(_key: string, value: unknown) {
  return _key === "encrypted_content" || _key === "encrypted_index" ? undefined : value;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set (add it to .env.local).");
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join("tests/runs", stamp);
  console.log(`Writing to ${dir} (database: ${useDb ? "on" : "off"})`);

  if (!ideas.length) {
    console.error(`No idea with slug ${only}. Slugs: ${IDEAS.map((i) => i.slug).join(", ")}`);
    process.exit(1);
  }
  const results = await Promise.allSettled(ideas.map(async (idea) => {
    const r = await run(idea.input);
    const out = join(dir, idea.slug);
    mkdirSync(out, { recursive: true });
    const write = (name: string, data: unknown) =>
      writeFileSync(join(out, name), typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
    write("input.json", { brief: idea.brief, teardown_id: r.id, ...idea.input });
    write("idea-spec.json", r.spec);
    write("sources.json", r.sources);
    write("notes.md", `${r.notes}\n`);
    write("runs.json", r.runs);
    write("research-raw.json", `${JSON.stringify(r.responses, stripEncrypted, 2)}\n`);
    for (const [name, file] of [["alternatives", "alternatives"], ["demand_evidence", "demand"], ["economics", "economics"]] as const) {
      const sec = r[name];
      write(`${file}-draft.json`, sec.draft);
      write(`${file}.json`, sec.section);
      write(`${file}-notes.md`, `${sec.notes}\n`);
      write(`${file}-raw.json`, `${JSON.stringify(sec.responses, stripEncrypted, 2)}\n`);
      write(`factcheck-${file}.json`, sec.factcheck.log);
    }
    write("writer-context.md", r.writerContext);
    // Live sections; every other section from the sample.
    write("report.json", buildReport(r.alternatives.section, r.sources, { demand: r.demand_evidence.section, economics: r.economics.section }));

    const after = verify ? await verifyAll(r) : null;
    if (after) write("factcheck-verify.json", after.results);
    console.log(`✓ ${idea.slug}: ${r.sources.length} sources, $${r.runs.reduce((n, x) => n + x.cost_usd, 0).toFixed(4)}`);
    return { ...r, after };
  }));

  const summary = ideas.map((idea, i) => {
    const res = results[i];
    if (res.status === "rejected") return { slug: idea.slug, error: String(res.reason) };
    const r = res.value;
    const find = (stage: string, step?: string) => r.runs.find((x) => x.stage === stage && x.step === step);
    const check = (section: string) => r.runs.find((x) => x.stage === "factcheck" && x.section === section);
    const usd = (run: StageRun | undefined | null) => round(run?.cost_usd ?? 0);
    const rates = (name: "alternatives" | "demand_evidence" | "economics") => {
      const f = r[name].factcheck;
      const after = r.after?.results[name];
      const show = (x: ReturnType<typeof supportRate>) => (x.checked ? `${x.supported}/${x.checked}` : "0/0");
      return `${show(supportRate(f.excerptResults))} → ${show(supportRate(f.results))} → ${after ? show(supportRate(after)) : "–"}`;
    };
    const all = (key: "excerptResults" | "results") => supportRate((["alternatives", "demand_evidence", "economics"] as const).flatMap((n) => r[n].factcheck[key]));
    const afterAll = r.after ? supportRate(Object.values(r.after.results).flat()) : null;
    const actions = (a: string) => (["alternatives", "demand_evidence", "economics"] as const).flatMap((n) => r[n].factcheck.log).filter((l) => l.action === a).length;
    const key = keyCompetitors(idea, r);
    const d = r.demand_evidence.section;
    const ds = demandScore(d);
    const e = r.economics.section;
    const ec = computeEconomics(e);
    return {
      slug: idea.slug,
      teardown_id: r.id,
      searches: `${find("research")?.usage.web_search_requests ?? 0} + alt ${find("alternatives", "research")?.usage.web_search_requests ?? 0}`
        + ` + demand ${find("demand_evidence", "research")?.usage.web_search_requests ?? 0} + econ ${find("economics", "research")?.usage.web_search_requests ?? 0}`,
      sources: r.sources.length,
      intake_usd: usd(find("intake")),
      research_usd: usd(find("research")),
      section_research_usd: `alt ${usd(find("alternatives", "research"))}, demand ${usd(find("demand_evidence", "research"))}, econ ${usd(find("economics", "research"))}`,
      writers_usd: `alt ${usd(find("alternatives", "write"))}, demand ${usd(find("demand_evidence", "write"))}, econ ${usd(find("economics", "write"))}`,
      writer_cache: (["alternatives", "demand_evidence", "economics"] as const)
        .map((n) => { const u = find(n, "write")?.usage; return `${n.split("_")[0]} w${u?.cache_creation_input_tokens ?? 0}/r${u?.cache_read_input_tokens ?? 0}`; }).join(", "),
      writer_retries: (["alternatives", "demand_evidence", "economics"] as const).map((n) => find(n, "write")?.retries?.length ?? 0).join("/"),
      factcheck_usd: `alt ${usd(check("alternatives"))}, demand ${usd(check("demand_evidence"))}, econ ${usd(check("economics"))}`,
      total_usd: round(r.runs.reduce((n, x) => n + x.cost_usd, 0)),
      projected_9_sections_usd: projectReport(r),
      support_alt: rates("alternatives"),
      support_demand: rates("demand_evidence"),
      support_econ: rates("economics"),
      support_all: `${pct(all("excerptResults").rate)} → ${pct(all("results").rate)} → ${afterAll ? `${pct(afterAll.rate)} (${afterAll.supported}/${afterAll.checked})` : "–"}`,
      fixes: `rewritten ${actions("rewritten")}, estimated ${actions("estimated")}, dropped ${actions("dropped")}, unresolved ${actions("unresolved")}`,
      verify_usd: round(r.after?.cost_usd ?? 0),
      rows: `${r.alternatives.section.alternatives.length} of ${r.alternatives.draft.alternatives.length}`,
      key_in_section: key.in_section,
      demand: `${d.evidence}, ${ds.rating}, ${ds.key_figure.value} ${ds.key_figure.unit}: ${ds.finding}`
        + ` [${d.signals.map((s) => `${s.kind} ${s.value}`).join("; ") || "no signals"}; ${r.demand_evidence.draft.signals.length} drafted]`,
      economics: `${e.scorecard.rating}, ${money(e.price.amount)} − ${money(e.unit_cost.amount)} = ${Math.round(ec.margin * 100)}% margin,`
        + ` ${money(e.fixed_costs.amount)}/mo fixed, break-even ${ec.breakEven ?? "none"} ${e.break_even_unit} (${e.currency}): ${e.scorecard.finding}`,
    };
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(dir, "summary.md"), summaryMarkdown(stamp, summary));
  console.table(summary);
  if (results.some((r) => r.status === "rejected")) process.exit(1);
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** A fresh check of each fixed section, with the same pages. Test-only: graded by the same checker, so not independent. */
async function verifyAll(r: StagesResult & { pages: PageCache }) {
  const opts = { ...options.factcheck, pages: r.pages };
  const runs = await Promise.all([
    checkClaimList(collectClaims(r.alternatives.section), r.sources, opts),
    checkClaimList(demandCheck(r.sources).claims(r.demand_evidence.section), r.sources, opts),
    checkClaimList(economicsCheck(r.sources).claims(r.economics.section), r.sources, opts),
  ]);
  const results: Record<"alternatives" | "demand_evidence" | "economics", CheckResult[]> = {
    alternatives: runs[0].results, demand_evidence: runs[1].results, economics: runs[2].results,
  };
  return { results, cost_usd: runs.reduce((n, x) => n + (x.run?.cost_usd ?? 0), 0) };
}

/**
 * Projected cost of a full 9-section report from this run's measurements.
 * - Intake, shared research, the three searching sections' research, their
 *   writers and their fact-checks: as measured. No other section searches
 *   (sections/config.ts), so the shared writer context is complete.
 * - Each of the 6 remaining writers reads the context from cache (the demand
 *   and economics writers' measured cache read, which started after the
 *   alternatives writer wrote it) and pays the measured writers' average own
 *   input and output, retries included. Verdict and page summaries also read
 *   the other sections' JSON, about 3k tokens each, uncached.
 * - Fact-check: the 3 measured fact-checks' average, for each remaining section.
 */
function projectReport(r: StagesResult): number {
  const writes = (["alternatives", "demand_evidence", "economics"] as const).map((n) => r.runs.find((x) => x.stage === n && x.step === "write")!);
  const model = writes[0].model;
  const price = (u: Partial<TokenUsage>) => costUsd(model, { ...ZERO_USAGE, ...u });
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  // One writer request's context: what the first writer wrote to cache (later reads include retries).
  const read = writes[0].usage.cache_creation_input_tokens;
  const own = avg(writes.map((w) => price({ input_tokens: w.usage.input_tokens, output_tokens: w.usage.output_tokens })));
  const remaining = SECTION_NAMES.length - 3;
  const writers = remaining * (price({ cache_read_input_tokens: read }) + own) + price({ input_tokens: 2 * 3000 });
  const checks = r.runs.filter((x) => x.stage === "factcheck");
  const factcheck = remaining * avg(checks.map((x) => x.cost_usd));
  const measured = r.runs.reduce((t, x) => t + x.cost_usd, 0);
  return round(measured + writers + factcheck);
}

// A table to paste into tests/runs-summary.md, which is committed (tests/runs/ is not).
function summaryMarkdown(stamp: string, rows: Record<string, unknown>[]) {
  const cols = Object.keys(rows.find((r) => !("error" in r)) ?? rows[0]).filter((k) => k !== "slug");
  const lines = [
    `### ${stamp}`,
    "",
    `| slug | ${cols.join(" | ")} |`,
    `|---|${cols.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.slug} | ${cols.map((c) => String(r[c] ?? (r.error ? "" : "–"))).join(" | ")} |`),
    ...rows.filter((r) => r.error).map((r) => `\n${r.slug} failed: ${r.error}`),
  ];
  return `${lines.join("\n")}\n`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
