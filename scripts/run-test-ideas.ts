// Runs intake + research on the three test ideas and writes everything to
// tests/runs/<timestamp>/. Billable: each idea costs real API money.
//
//   npm run test:ideas            # also stores teardowns + sources in Neon when DATABASE_URL is set
//   npm run test:ideas -- --no-db # API only
//   npm run test:ideas -- --only b-dog-grooming
//
// Needs ANTHROPIC_API_KEY (and optionally DATABASE_URL) in .env.local or the environment.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntakeInput } from "../lib/engine/input";
import { runIntake } from "../lib/engine/intake";
import { runResearch } from "../lib/engine/research";
import { createTeardown, runStages, type StagesResult } from "../lib/engine/store";

try {
  process.loadEnvFile(".env.local");
} catch {}

// Each test idea as given, split into the intake form's fields.
const IDEAS: { slug: string; brief: string; input: IntakeInput }[] = [
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
  },
];

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
const ideas = only ? IDEAS.filter((i) => i.slug === only) : IDEAS;
const useDb = !process.argv.includes("--no-db") && !!process.env.DATABASE_URL;

async function run(input: IntakeInput): Promise<StagesResult & { id: string | null }> {
  if (useDb) {
    const id = await createTeardown(input);
    return { id, ...(await runStages(id)) };
  }
  const intake = await runIntake(input);
  const research = await runResearch(intake.spec);
  return { id: null, spec: intake.spec, sources: research.sources, notes: research.notes, runs: [intake.run, research.run], responses: research.responses };
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
    console.log(`✓ ${idea.slug}: ${r.sources.length} sources, $${r.runs.reduce((n, x) => n + x.cost_usd, 0).toFixed(4)}`);
    return r;
  }));

  const summary = ideas.map((idea, i) => {
    const res = results[i];
    if (res.status === "rejected") return { slug: idea.slug, error: String(res.reason) };
    const r = res.value;
    const cost = (stage: string) => r.runs.find((x) => x.stage === stage)?.cost_usd ?? 0;
    return {
      slug: idea.slug,
      teardown_id: r.id,
      queries: r.spec.search_queries.length,
      ambiguities: r.spec.ambiguities.length,
      web_searches: r.runs.reduce((n, x) => n + x.usage.web_search_requests, 0),
      sources: r.sources.length,
      search_results: new Set(r.responses.flatMap(({ message }) => message.content.flatMap((b) =>
        b.type === "web_search_tool_result" && Array.isArray(b.content) ? b.content.map((x) => x.url) : []))).size,
      intake_usd: cost("intake"),
      research_usd: cost("research"),
      total_usd: Math.round((cost("intake") + cost("research")) * 1e4) / 1e4,
      research_seconds: Math.round((r.runs.find((x) => x.stage === "research")?.duration_ms ?? 0) / 1000),
    };
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.table(summary);
  if (results.some((r) => r.status === "rejected")) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
