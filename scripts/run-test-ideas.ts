// Runs intake, research and the Existing Alternatives section on the three test
// ideas, builds the partial report (live alternatives, the rest from the
// sample), and writes everything to tests/runs/<timestamp>/. Billable: each
// idea costs real API money.
//
//   npm run test:ideas            # also stores teardowns + sources in Neon when DATABASE_URL is set
//   npm run test:ideas -- --no-db # API only
//   npm run test:ideas -- --only b-dog-grooming
//   npm run test:ideas -- --max-searches 10 --research-model claude-opus-5-5 --intake-model claude-opus-5-5
//   npm run test:ideas -- --alternatives-searches 4 --alternatives-model claude-opus-5-5
//
// Needs ANTHROPIC_API_KEY (and optionally DATABASE_URL) in .env.local or the environment.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntakeInput } from "../lib/engine/input";
import { runPipeline, type StageOptions, type StagesResult } from "../lib/engine/pipeline";
import { buildReport } from "../lib/engine/report";
import { createTeardown, runStages } from "../lib/engine/store";

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
};
const ideas = only ? IDEAS.filter((i) => i.slug === only) : IDEAS;
const useDb = !process.argv.includes("--no-db") && !!process.env.DATABASE_URL;

async function run(input: IntakeInput): Promise<StagesResult & { id: string | null }> {
  if (useDb) {
    const id = await createTeardown(input);
    return { id, ...(await runStages(id, options)) };
  }
  return { id: null, ...(await runPipeline(input, options)) };
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
    write("alternatives.json", r.alternatives.section);
    write("alternatives-notes.md", `${r.alternatives.notes}\n`);
    write("alternatives-raw.json", `${JSON.stringify(r.alternatives.responses, stripEncrypted, 2)}\n`);
    // Live alternatives, scorecard.alternatives and market_gap; every other section from the sample.
    write("report.json", buildReport(r.alternatives.section, r.sources));
    console.log(`✓ ${idea.slug}: ${r.sources.length} sources, $${r.runs.reduce((n, x) => n + x.cost_usd, 0).toFixed(4)}`);
    return r;
  }));

  const summary = ideas.map((idea, i) => {
    const res = results[i];
    if (res.status === "rejected") return { slug: idea.slug, error: String(res.reason) };
    const r = res.value;
    const cost = (stage: string) => r.runs.find((x) => x.stage === stage)?.cost_usd ?? 0;
    const run = (stage: string) => r.runs.find((x) => x.stage === stage);
    const research = run("research");
    const searches = (stage: string) => run(stage)?.usage.web_search_requests ?? 0;
    const key = keyCompetitors(idea, r);
    return {
      slug: idea.slug,
      teardown_id: r.id,
      models: r.runs.map((x) => `${x.stage}=${x.model}`).join(" "),
      queries: r.spec.search_queries.length,
      ambiguities: r.spec.ambiguities.length,
      web_searches: searches("research"),
      alt_searches: searches("alternatives"),
      sources: r.sources.length,
      search_results: new Set(r.responses.flatMap(({ message }) => message.content.flatMap((b) =>
        b.type === "web_search_tool_result" && Array.isArray(b.content) ? b.content.map((x) => x.url) : []))).size,
      research_input_tokens: research?.usage.input_tokens ?? 0,
      research_cache_write_tokens: research?.usage.cache_creation_input_tokens ?? 0,
      research_cache_read_tokens: research?.usage.cache_read_input_tokens ?? 0,
      research_output_tokens: research?.usage.output_tokens ?? 0,
      intake_usd: cost("intake"),
      research_usd: cost("research"),
      alternatives_usd: cost("alternatives"),
      total_usd: Math.round(r.runs.reduce((n, x) => n + x.cost_usd, 0) * 1e4) / 1e4,
      research_seconds: Math.round((research?.duration_ms ?? 0) / 1000),
      alternatives_seconds: Math.round((run("alternatives")?.duration_ms ?? 0) / 1000),
      alternatives: r.alternatives.section.alternatives.map((a) => (a.examples ? `${a.name} (${a.examples})` : a.name)).join("; "),
      key_in_section: key.in_section,
      key_in_sources: key.in_sources,
    };
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(dir, "summary.md"), summaryMarkdown(stamp, summary));
  console.table(summary);
  if (results.some((r) => r.status === "rejected")) process.exit(1);
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
