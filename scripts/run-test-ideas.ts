// Runs the pipeline (intake, research, the Existing Alternatives section,
// fact-check) on the three test ideas, builds the partial report (live
// alternatives, the rest from the sample), and writes everything to
// tests/runs/<timestamp>/. Billable: each idea costs real API money.
//
// Test-only extras, costed separately from the pipeline: a second fact-check
// pass on the checked section (the "after" support rate; --no-verify skips it),
// and a max_tokens: 0 request that reuses the writers' cached context with a
// different section prompt, to measure what each further writer pays for it.
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
import { checkClaims, supportRate } from "../lib/engine/factcheck";
import type { IntakeInput } from "../lib/engine/input";
import { STAGE_MODELS, ZERO_USAGE, addUsage, anthropic, costUsd, type StageRun, type TokenUsage } from "../lib/engine/llm";
import { runPipeline, type StageOptions, type StagesResult } from "../lib/engine/pipeline";
import { buildReport } from "../lib/engine/report";
import { SECTIONS, SECTION_NAMES } from "../lib/engine/sections/config";
import { WRITE_INSTRUCTION, writerContext, writerParams } from "../lib/engine/sections/common";
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
  factcheck: { model: flag("--factcheck-model") },
};
const verify = !process.argv.includes("--no-verify");
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
    write("alternatives-draft.json", r.alternatives.draft);
    write("alternatives.json", r.alternatives.section);
    write("alternatives-notes.md", `${r.alternatives.notes}\n`);
    write("alternatives-raw.json", `${JSON.stringify(r.alternatives.responses, stripEncrypted, 2)}\n`);
    write("factcheck.json", r.factcheck.log);
    write("writer-context.md", r.writerContext);
    // Live alternatives, scorecard.alternatives and market_gap; every other section from the sample.
    write("report.json", buildReport(r.alternatives.section, r.sources));

    const probe = await probeSharedContext(r);
    const after = verify ? await checkClaims(r.alternatives.section, r.sources, options.factcheck) : null;
    if (after) write("factcheck-verify.json", after.results);
    console.log(`✓ ${idea.slug}: ${r.sources.length} sources, $${r.runs.reduce((n, x) => n + x.cost_usd, 0).toFixed(4)}`);
    return { ...r, probe, after };
  }));

  const summary = ideas.map((idea, i) => {
    const res = results[i];
    if (res.status === "rejected") return { slug: idea.slug, error: String(res.reason) };
    const r = res.value;
    const find = (stage: string, step?: string) => r.runs.find((x) => x.stage === stage && x.step === step);
    const usd = (run: StageRun | undefined | null) => run?.cost_usd ?? 0;
    const altResearch = find("alternatives", "research");
    const altWrite = find("alternatives", "write")!;
    const factcheck = find("factcheck");
    const before = supportRate(r.factcheck.results);
    const afterRate = r.after ? supportRate(r.after.results) : null;
    const actions = (a: string) => r.factcheck.log.filter((l) => l.action === a).length;
    const key = keyCompetitors(idea, r);
    const projection = projectReport(r, { altResearch, altWrite, factcheck, probe: r.probe });
    return {
      slug: idea.slug,
      teardown_id: r.id,
      research_searches: find("research")?.usage.web_search_requests ?? 0,
      alt_searches: altResearch?.usage.web_search_requests ?? 0,
      sources: r.sources.length,
      alt_research_cache_write: altResearch?.usage.cache_creation_input_tokens ?? 0,
      alt_research_cache_read: altResearch?.usage.cache_read_input_tokens ?? 0,
      alt_search_rounds: searchRounds(r.alternatives.responses),
      writer_context_tokens: altWrite.usage.cache_creation_input_tokens + altWrite.usage.cache_read_input_tokens,
      probe_cache_read: r.probe.cache_read_input_tokens,
      probe_cache_write: r.probe.cache_creation_input_tokens,
      intake_usd: usd(find("intake")),
      research_usd: usd(find("research")),
      alt_research_usd: usd(altResearch),
      alt_write_usd: usd(altWrite),
      factcheck_usd: usd(factcheck),
      total_usd: round(r.runs.reduce((n, x) => n + x.cost_usd, 0)),
      projected_9_sections_usd: projection.total,
      claims_checked: before.checked,
      support_before: `${before.supported}/${before.checked} (${pct(before.rate)})`,
      partial_before: before.partial,
      unsupported_before: before.unsupported,
      fixes: `rewritten ${actions("rewritten")}, estimated ${actions("estimated")}, dropped ${actions("dropped")}, unresolved ${actions("unresolved")}`,
      support_after: afterRate ? `${afterRate.supported}/${afterRate.checked} (${pct(afterRate.rate)})` : "–",
      verify_usd: usd(r.after?.run),
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

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * How many rounds of searches the model ran: searches issued together before
 * any result came back count as one round. Each round after the first re-reads
 * the whole context so far from cache, which is what drives cache reads up.
 */
function searchRounds(responses: StagesResult["responses"]): number {
  const types = responses.flatMap((x) => x.message.content.map((b) => b.type));
  return types.filter((t, i) => t === "server_tool_use" && types[i - 1] !== "server_tool_use").length;
}

/**
 * A writer request with a different section prompt and max_tokens: 0. It bills
 * only input, so its cache read is what each further section writer pays for
 * the shared context.
 */
async function probeSharedContext(r: StagesResult): Promise<TokenUsage> {
  const msg = await anthropic().messages.create(writerParams(
    { model: options.alternatives?.model ?? STAGE_MODELS.alternatives, context: r.writerContext, sectionPrompt: "# Section: probe\n\nThis request only measures the cached context." },
    [{ role: "user", content: WRITE_INSTRUCTION }],
    0,
  ));
  return addUsage(ZERO_USAGE, msg.usage);
}

/**
 * Projected cost of a full 9-section report from this run's measurements.
 * - Intake and shared research: as measured.
 * - Each section with searches > 0 (sections/config.ts): the alternatives
 *   research cost, scaled by its configured searches.
 * - Writers: the shared context grows by what each searching section adds
 *   (alternatives' addition, scaled by searches). The first writer writes it to
 *   cache and the other 8 read it. Each writer's own input and output match the
 *   alternatives writer's, retries included. Verdict and page summaries also
 *   read the other sections' JSON, about 3k tokens each, uncached.
 * - Fact-check: the alternatives fact-check × 9.
 */
function projectReport(r: StagesResult, m: { altResearch?: StageRun; altWrite: StageRun; factcheck?: StageRun; probe: TokenUsage }) {
  const writeModel = m.altWrite.model;
  const sharedOnly = new Set(r.alternatives.added.map((s) => s.id));
  const ctx0 = writerContext(r.spec, r.sources.filter((s) => !sharedOnly.has(s.id)), [{ label: "Shared research", text: r.notes }]);
  const p1 = m.probe.cache_read_input_tokens || m.altWrite.usage.cache_creation_input_tokens;
  const p0 = p1 * (ctx0.length / r.writerContext.length);
  const altSearches = options.alternatives?.maxSearches ?? SECTIONS.alternatives.searches;
  const searching = SECTION_NAMES.filter((n) => SECTIONS[n].searches > 0);
  const p3 = p1 + searching.filter((n) => n !== "alternatives").reduce((t, n) => t + ((p1 - p0) * SECTIONS[n].searches) / altSearches, 0);

  const price = (u: Partial<TokenUsage>) => costUsd(writeModel, { ...ZERO_USAGE, ...u });
  const ownPart = price({ input_tokens: m.altWrite.usage.input_tokens, output_tokens: m.altWrite.usage.output_tokens });
  const writers = price({ cache_creation_input_tokens: Math.round(p3) }) + 8 * price({ cache_read_input_tokens: Math.round(p3) })
    + SECTION_NAMES.length * ownPart + price({ input_tokens: 2 * 3000 });
  const research = searching.reduce((t, n) => t + ((m.altResearch?.cost_usd ?? 0) * SECTIONS[n].searches) / altSearches, 0);
  const fixed = r.runs.filter((x) => x.stage === "intake" || x.stage === "research").reduce((t, x) => t + x.cost_usd, 0);
  return { total: round(fixed + research + writers + (m.factcheck?.cost_usd ?? 0) * SECTION_NAMES.length), context_tokens_9: Math.round(p3) };
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
