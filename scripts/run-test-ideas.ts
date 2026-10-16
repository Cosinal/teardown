// Runs the full pipeline (intake, research, all nine sections, each
// fact-checked, the verdict last) on the three test ideas and writes
// everything to tests/runs/<timestamp>/. Billable: each idea costs real API
// money.
//
// Test-only extras, costed separately from the report:
// - a second fact-check pass on each web-cited section, with the same page
//   cache (the "after" support rate; --no-verify skips it);
// - a contradiction audit: a stronger model than the checker reads the whole
//   report and lists statements in one section that contradict another
//   (--no-audit skips it).
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
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { checkClaimList, collectClaims, supportRate, type CheckResult } from "../lib/engine/factcheck";
import { memoryPageCache, type PageCache } from "../lib/engine/fetch";
import type { IntakeInput } from "../lib/engine/input";
import { MODELS, addUsage, anthropic, assertFinished, cacheReport, costUsd, ZERO_USAGE, type StageRun } from "../lib/engine/llm";
import { runPipeline, type StageOptions, type StagesResult } from "../lib/engine/pipeline";
import { blockersCheck } from "../lib/engine/sections/blockers";
import { reportBrief } from "../lib/engine/sections/brief";
import { demandCheck } from "../lib/engine/sections/demand";
import { distributionCheck } from "../lib/engine/sections/distribution";
import { economicsCheck } from "../lib/engine/sections/economics";
import { laterContext } from "../lib/engine/sections/later";
import { createTeardown, dbPageCache, runStages, skipPayment } from "../lib/engine/store";

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
const audit = !process.argv.includes("--no-audit");
const ideas = only ? IDEAS.filter((i) => i.slug === only) : IDEAS;
const useDb = !process.argv.includes("--no-db") && !!process.env.DATABASE_URL;

/** Runs one idea. Its page cache is returned so the verify pass reuses the fetched pages. */
async function run(input: IntakeInput): Promise<StagesResult & { id: string | null; pages: PageCache }> {
  if (useDb) {
    // A dev run is unpaid and has no owner: only the admin cookie can view it.
    const id = await createTeardown(input, null);
    await skipPayment(id);
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
    for (const name of ALL) {
      const sec = r[name];
      write(`${name}-draft.json`, sec.draft);
      write(`${name}.json`, sec.section);
      if (sec.notes) write(`${name}-notes.md`, `${sec.notes}\n`);
      if (sec.responses.length) write(`${name}-raw.json`, `${JSON.stringify(sec.responses, stripEncrypted, 2)}\n`);
      write(`factcheck-${name}.json`, sec.factcheck.log);
    }
    write("writer-context.md", r.writerContext);
    write("report.json", r.report);
    write("report.md", `${reportBrief(r.report)}\n`);

    const after = verify ? await verifyAll(r) : null;
    if (after) write("factcheck-verify.json", after.results);
    const contradictions = audit ? await auditReport(r) : null;
    if (contradictions) write("contradictions.json", contradictions);
    console.log(`✓ ${idea.slug}: ${r.sources.length} sources, $${r.runs.reduce((n, x) => n + x.cost_usd, 0).toFixed(4)}`);
    return { ...r, after, contradictions };
  }));

  const summary = ideas.map((idea, i) => {
    const res = results[i];
    if (res.status === "rejected") return { slug: idea.slug, error: String(res.reason) };
    const r = res.value;
    const find = (stage: string, step?: string) => r.runs.find((x) => x.stage === stage && x.step === step);
    const check = (section: string) => r.runs.find((x) => x.stage === "factcheck" && x.section === section);
    const usd = (run: StageRun | undefined | null) => round(run?.cost_usd ?? 0);
    const sum = (runs: (StageRun | undefined | null)[]) => round(runs.reduce((n, x) => n + (x?.cost_usd ?? 0), 0));
    const show = (x: ReturnType<typeof supportRate>) => (x.checked ? `${x.supported}/${x.checked}` : "0/0");
    const rates = (name: Web) => {
      const f = r[name].factcheck;
      const after = r.after?.results[name];
      return `${show(supportRate(f.excerptResults))} → ${show(supportRate(f.results))} → ${after ? show(supportRate(after)) : "–"}`;
    };
    const all = (key: "excerptResults" | "results") => supportRate(WEB.flatMap((n) => r[n].factcheck[key]));
    const afterAll = r.after ? supportRate(Object.values(r.after.results).flat()) : null;
    const internal = supportRate(INTERNAL.flatMap((n) => r[n].factcheck.results));
    const actions = (a: string) => ALL.flatMap((n) => r[n].factcheck.log).filter((l) => l.action === a).length;
    const key = keyCompetitors(idea, r);
    const rep = r.report;
    const sc = rep.scorecard;
    return {
      slug: idea.slug,
      teardown_id: r.id,
      searches: `${find("research")?.usage.web_search_requests ?? 0} + alt ${find("alternatives", "research")?.usage.web_search_requests ?? 0}`
        + ` + demand ${find("demand_evidence", "research")?.usage.web_search_requests ?? 0} + econ ${find("economics", "research")?.usage.web_search_requests ?? 0}`,
      sources: `${r.sources.length} in store, ${rep.sources.length} in report`,
      total_usd: round(r.runs.reduce((n, x) => n + x.cost_usd, 0)),
      cache_hit: pct(cacheReport(r.runs).find((x) => x.stage === "total")?.hit_rate ?? 0),
      intake_research_usd: sum([find("intake"), find("research")]),
      section_research_usd: sum(SEARCHING.map((n) => find(n, "research"))),
      writers_usd: `searching ${sum(SEARCHING.map((n) => find(n, "write")))}, later ${sum(LATER.flatMap((n) => [find(n, "write"), find(n, "revise")]))}`
        + ` (${LATER.map((n) => `${n.split("_")[0]} ${round(usd(find(n, "write")) + usd(find(n, "revise")))}`).join(", ")})`,
      revisions: LATER.filter((n) => find(n, "revise")).join(", ") || "none",
      factcheck_usd: sum(ALL.map((n) => check(n))),
      writer_retries: ALL.map((n) => find(n, "write")?.retries?.length ?? 0).join("/"),
      writer_repair_usd: round(r.runs.reduce((n, x) => n + (x.repair_cost_usd ?? 0), 0)),
      writer_cache: ALL.map((n) => { const u = find(n, "write")?.usage; return `${n.split("_")[0]} w${u?.cache_creation_input_tokens ?? 0}/r${u?.cache_read_input_tokens ?? 0}`; }).join(", "),
      support_web: `${pct(all("excerptResults").rate)} → ${pct(all("results").rate)} (${show(all("results"))}) → ${afterAll ? `${pct(afterAll.rate)} (${show(afterAll)})` : "–"}`,
      ...Object.fromEntries(WEB.map((n) => [`support_${n.split("_")[0]}`, rates(n)])),
      internal_checks: `${show(internal)} supported (${INTERNAL.map((n) => `${n.split("_")[0]} ${show(supportRate(r[n].factcheck.results))}`).join(", ")})`,
      fixes: `rewritten ${actions("rewritten")}, estimated ${actions("estimated")}, dropped ${actions("dropped")}, unresolved ${actions("unresolved")}`,
      verify_usd: round(r.after?.cost_usd ?? 0),
      rows: `${r.alternatives.section.alternatives.length} of ${r.alternatives.draft.alternatives.length}`,
      key_in_section: key.in_section,
      verdict: `${rep.verdict.call.replace("_", " ")}, ${rep.verdict.confidence} confidence: ${rep.verdict.summary}`,
      scorecard: (["alternatives", "demand_evidence", "economics", "distribution", "blockers"] as const)
        .map((k) => `${k.split("_")[0]} ${sc[k].rating} ${sc[k].key_figure.value} ${sc[k].key_figure.unit}`).join("; "),
      riskiest: `${r.riskiest_assumptions.section.assumptions[0].rests_on}: ${rep.riskiest_assumptions[0].statement}`,
      first_test: `${rep.next_tests[0].name} ${rep.next_tests[0].cost}, ${rep.next_tests[0].time}; kill: ${rep.next_tests[0].kill_threshold}`,
      contradictions: r.contradictions ? contradictionSummary(r.contradictions.contradictions) : "–",
      audit_usd: round(r.contradictions?.cost_usd ?? 0),
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

const SEARCHING = ["alternatives", "demand_evidence", "economics"] as const;
const LATER = ["idea", "distribution", "blockers", "riskiest_assumptions", "next_tests", "verdict"] as const;
const ALL = [...SEARCHING, ...LATER];
/** Sections whose claims cite web sources. */
const WEB = ["alternatives", "demand_evidence", "economics", "distribution", "blockers"] as const;
type Web = (typeof WEB)[number];
/** Sections checked against the report itself or the founder's idea. */
const INTERNAL = ["idea", "riskiest_assumptions", "verdict"] as const;

/** A fresh check of each fixed web-cited section, with the same pages. Test-only: graded by the same checker, so not independent. */
async function verifyAll(r: StagesResult & { pages: PageCache }) {
  const opts = { ...options.factcheck, pages: r.pages };
  const ctx = laterContext(r.spec, r.sources, {
    alternatives: r.alternatives.section, demand_evidence: r.demand_evidence.section, economics: r.economics.section,
  }, r.writerContext);
  const runs = await Promise.all([
    checkClaimList(collectClaims(r.alternatives.section), r.sources, opts),
    checkClaimList(demandCheck(r.sources).claims(r.demand_evidence.section), r.sources, opts),
    checkClaimList(economicsCheck(r.sources).claims(r.economics.section), r.sources, opts),
    checkClaimList(distributionCheck(ctx)(r.sources).claims(r.distribution.section), r.sources, opts),
    checkClaimList(blockersCheck(ctx)(r.sources).claims(r.blockers.section), r.sources, opts),
  ]);
  const results = Object.fromEntries(WEB.map((n, i) => [n, runs[i].results])) as Record<Web, CheckResult[]>;
  return { results, cost_usd: runs.reduce((n, x) => n + (x.run?.cost_usd ?? 0), 0) };
}

const AuditSchema = z.object({
  contradictions: z.array(z.object({
    sections: z.array(z.string()),
    quotes: z.array(z.string()),
    issue: z.string(),
  })),
});

const AUDIT_PROMPT = `You audit a one-page market readout for internal consistency. You get every section of the report as text.

List every contradiction between sections: two statements that cannot both be true, a figure stated differently in two places (a margin, a price, a cost ceiling, a count), a rating or verdict that the section's own content or another section's content contradicts, or a summary that says something the section it summarizes does not. Quote both statements word for word.

Do not list: differences in emphasis, things one section mentions and another doesn't, judgements you would have made differently, or doubts about whether a figure is true in the world. Only conflicts inside the report. An empty list is a good answer when the report is consistent.`;

/** "between 0, within 1 [Blockers: …]": a contradiction is between sections when it names two or more. */
function contradictionSummary(list: z.infer<typeof AuditSchema>["contradictions"]) {
  const between = list.filter((c) => new Set(c.sections).size > 1).length;
  return `between ${between}, within ${list.length - between}${list.map((c) => ` [${[...new Set(c.sections)].join(" vs ")}: ${c.issue}]`).join("")}`;
}

/** Test-only: a stronger model than the checker lists contradictions between sections. */
async function auditReport(r: StagesResult) {
  const model = MODELS.opus;
  const msg = await anthropic().messages.parse({
    model,
    max_tokens: 16000,
    output_config: { effort: "high", format: zodOutputFormat(AuditSchema) },
    system: AUDIT_PROMPT,
    messages: [{ role: "user", content: reportBrief(r.report) }],
  });
  assertFinished(msg, "audit");
  return { contradictions: msg.parsed_output?.contradictions ?? [], cost_usd: costUsd(model, addUsage(ZERO_USAGE, msg.usage)) };
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
