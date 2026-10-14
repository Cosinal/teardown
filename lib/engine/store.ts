import { randomBytes } from "node:crypto";
import { init, sql } from "@/lib/db";
import { FACTCHECK_GAP_PROMPT, FACTCHECK_PROMPT } from "./factcheck";
import type { PageCache } from "./fetch";
import type { IntakeInput } from "./input";
import { INTAKE_PROMPT } from "./intake";
import { Budget, DeadlineError, withBudget, type StageRun } from "./llm";
import { runPipeline, type StageOptions, type StagesResult, type TeardownStatus } from "./pipeline";
import { RESEARCH_PROMPT, type SourceStore } from "./research";
import { ALTERNATIVES_RESEARCH_PROMPT, ALTERNATIVES_WRITE_PROMPT } from "./sections/alternatives";
import { ASSUMPTIONS_WRITE_PROMPT } from "./sections/assumptions";
import { BLOCKERS_WRITE_PROMPT } from "./sections/blockers";
import { WRITER_SHARED_PROMPT, WriterError } from "./sections/common";
import { DEMAND_RESEARCH_PROMPT, DEMAND_WRITE_PROMPT } from "./sections/demand";
import { DISTRIBUTION_WRITE_PROMPT } from "./sections/distribution";
import { ECONOMICS_RESEARCH_PROMPT, ECONOMICS_WRITE_PROMPT } from "./sections/economics";
import { IDEA_WRITE_PROMPT } from "./sections/idea";
import { TESTS_WRITE_PROMPT } from "./sections/tests";
import { VERDICT_WRITE_PROMPT } from "./sections/verdict";

export type { StageOptions, StagesResult, TeardownStatus } from "./pipeline";

// Teardown rows and their sources in Neon. The engine's stages are pure; this
// module records what they produce.

/** Stored in teardowns.prompt_version: every stage's prompt version in this pipeline. */
export const PIPELINE_VERSION = [
  INTAKE_PROMPT, RESEARCH_PROMPT, ALTERNATIVES_RESEARCH_PROMPT, DEMAND_RESEARCH_PROMPT, ECONOMICS_RESEARCH_PROMPT, WRITER_SHARED_PROMPT,
  ALTERNATIVES_WRITE_PROMPT, DEMAND_WRITE_PROMPT, ECONOMICS_WRITE_PROMPT, IDEA_WRITE_PROMPT, DISTRIBUTION_WRITE_PROMPT, BLOCKERS_WRITE_PROMPT,
  ASSUMPTIONS_WRITE_PROMPT, TESTS_WRITE_PROMPT, VERDICT_WRITE_PROMPT, FACTCHECK_PROMPT, FACTCHECK_GAP_PROMPT,
].join("+");

export function newTeardownId() {
  return randomBytes(9).toString("base64url");
}

/**
 * Saves a new teardown as awaiting_payment, owned by whoever holds the token
 * that hashes to `ownerTokenHash` (null: admin only). The Stripe webhook (or an admin skipping
 * payment) moves it to queued.
 */
export async function createTeardown(input: IntakeInput, ownerTokenHash: string | null): Promise<string> {
  await init();
  const id = newTeardownId();
  await sql()`INSERT INTO teardowns (id, idea, report, prompt_version, status, input, owner_token_hash)
    VALUES (${id}, ${input.idea}, NULL, ${PIPELINE_VERSION}, 'awaiting_payment', ${JSON.stringify(input)}::jsonb, ${ownerTokenHash})`;
  return id;
}

/** Replaces the answers on a teardown that hasn't been paid for yet. Returns false if it's no longer awaiting payment. */
export async function updateDraft(id: string, input: IntakeInput): Promise<boolean> {
  await init();
  const rows = await sql()`UPDATE teardowns SET idea = ${input.idea}, input = ${JSON.stringify(input)}::jsonb, updated_at = now()
    WHERE id = ${id} AND status = 'awaiting_payment' RETURNING id`;
  return rows.length > 0;
}

/** Admin only: queues an unpaid teardown without payment. Returns false if it's no longer awaiting payment. */
export async function skipPayment(id: string): Promise<boolean> {
  const rows = await sql()`UPDATE teardowns SET status = 'queued', updated_at = now()
    WHERE id = ${id} AND status = 'awaiting_payment' RETURNING id`;
  return rows.length > 0;
}

async function setStatus(id: string, status: TeardownStatus, error: string | null = null) {
  await sql()`UPDATE teardowns SET status = ${status}, error = ${error}, updated_at = now() WHERE id = ${id}`;
}

/** Saved on a run that stopped updating its row, e.g. killed at maxDuration or cut off from the database. */
export const STALE_RUN_ERROR = "Run timed out or lost connection";
const SETTLED: TeardownStatus[] = ["awaiting_payment", "queued", "done", "failed"];

/** True for a status a live run passes through: not waiting (for payment or to start), finished or failed. */
export function isInProgress(status: TeardownStatus) {
  return !SETTLED.includes(status);
}

/**
 * Marks an in-progress run failed if its row hasn't been updated for 6
 * minutes, longer than maxDuration (300 s) plus any single stage. The age is
 * checked by the database in the same statement, so a run that just recorded
 * a step is never swept. Returns whether it marked the row.
 */
export async function failStaleRun(id: string): Promise<boolean> {
  const rows = await sql()`UPDATE teardowns SET status = 'failed', error = ${STALE_RUN_ERROR}, updated_at = now()
    WHERE id = ${id} AND status NOT IN ('awaiting_payment', 'queued', 'done', 'failed') AND updated_at < now() - interval '6 minutes'
    RETURNING id`;
  return rows.length > 0;
}

async function recordRun(id: string, run: StageRun) {
  await sql()`UPDATE teardowns SET
    stage_runs = stage_runs || ${JSON.stringify([run])}::jsonb,
    cost_usd = COALESCE(cost_usd, 0) + ${run.cost_usd},
    updated_at = now()
    WHERE id = ${id}`;
}

// Upserts: a section may add quotes to a source the shared research saved. Ids never change.
async function saveSources(id: string, sources: SourceStore) {
  if (!sources.length) return;
  const q = sql();
  await q.transaction(sources.map((s) => q`INSERT INTO sources (teardown_id, source_id, url, title, retrieved_at, excerpt)
    VALUES (${id}, ${s.id}, ${s.url}, ${s.title}, ${s.retrieved_at}, ${s.excerpt})
    ON CONFLICT (teardown_id, source_id) DO UPDATE SET excerpt = EXCLUDED.excerpt`));
}

export async function getSources(id: string): Promise<SourceStore> {
  await init();
  const rows = await sql()`SELECT source_id, url, title, retrieved_at, excerpt FROM sources WHERE teardown_id = ${id}
    ORDER BY length(source_id), source_id`;
  return rows.map((r) => ({
    id: r.source_id, url: r.url, title: r.title, retrieved_at: new Date(r.retrieved_at).toISOString(), excerpt: r.excerpt,
  }));
}

/**
 * Fact-check's page cache in the sources table. A page fetched for any
 * teardown in the last 30 days is reused, since prices change. A failed fetch
 * is reused only within the same teardown: a bot wall may not be there later.
 */
export function dbPageCache(teardownId: string): PageCache {
  return {
    async get(url) {
      const rows = await sql()`SELECT page_text, page_error FROM sources
        WHERE url = ${url} AND page_fetched_at IS NOT NULL
          AND ((page_text IS NOT NULL AND page_fetched_at > now() - interval '30 days') OR teardown_id = ${teardownId})
        ORDER BY (page_text IS NOT NULL) DESC, page_fetched_at DESC LIMIT 1`;
      if (!rows.length) return undefined;
      return rows[0].page_text !== null ? { ok: true, text: rows[0].page_text } : { ok: false, error: rows[0].page_error ?? "fetch failed" };
    },
    async set(url, page) {
      await sql()`UPDATE sources SET page_text = ${page.ok ? page.text : null}, page_error = ${page.ok ? null : page.error}, page_fetched_at = now()
        WHERE teardown_id = ${teardownId} AND url = ${url}`;
    },
  };
}

/** Thrown by runStages when another caller already claimed the teardown. */
export class AlreadyClaimedError extends Error {}

/**
 * Moves a queued teardown to intake and returns its input, in one statement,
 * so two callers can't both run it. Throws if the id doesn't exist or isn't queued.
 */
async function claim(id: string): Promise<IntakeInput> {
  const rows = await sql()`UPDATE teardowns SET status = 'intake', updated_at = now()
    WHERE id = ${id} AND status = 'queued' RETURNING id, input`;
  if (rows.length) return rows[0].input as IntakeInput;
  const found = await sql()`SELECT status FROM teardowns WHERE id = ${id}`;
  if (!found.length) throw new Error(`Teardown ${id} not found`);
  throw new AlreadyClaimedError(`Teardown ${id} is ${found[0].status}, not queued`);
}

/**
 * Runs the pipeline for a queued teardown and records each step: statuses,
 * stage runs (fact-check's include the per-claim log), sources, sections and the report.
 * The run gets a time budget from its start (llm.ts Budget): past it, it fails
 * here, before Vercel's 300 s limit would kill it. Billable: callers must gate this behind payment (see CLAUDE.md).
 */
export async function runStages(id: string, options: StageOptions = {}, makeBudget: () => Budget = () => new Budget()): Promise<StagesResult> {
  const budget = makeBudget();
  try {
    return await withBudget(budget, () => claimAndRun(id, options, budget));
  } finally {
    budget.done();
  }
}

async function claimAndRun(id: string, options: StageOptions, budget: Budget): Promise<StagesResult> {
  await init();
  // Outside the try: a caller that loses the claim must not mark the winner's run failed.
  const input = await claim(id);

  try {
    const opts = { ...options, factcheck: { ...options.factcheck, pages: options.factcheck?.pages ?? dbPageCache(id) } };
    return await runPipeline(input, opts, {
      status: (status) => setStatus(id, status),
      run: (run) => recordRun(id, run),
      intake: async (spec) => {
        await sql()`UPDATE teardowns SET idea_spec = ${JSON.stringify(spec)}::jsonb WHERE id = ${id}`;
      },
      research: async (sources, notes) => {
        await saveSources(id, sources);
        await sql()`UPDATE teardowns SET research_notes = ${notes} WHERE id = ${id}`;
      },
      sources: (changed) => saveSources(id, changed),
      section: async (name, data) => {
        await sql()`UPDATE teardowns SET sections = sections || ${JSON.stringify({ [name]: data })}::jsonb WHERE id = ${id}`;
      },
      report: async (report) => {
        await sql()`UPDATE teardowns SET report = ${JSON.stringify(report)}::jsonb, updated_at = now() WHERE id = ${id}`;
      },
    });
  } catch (err) {
    // A writer that ran out of attempts still spent money: record it before marking the row failed.
    if (err instanceof WriterError) {
      await recordRun(id, err.run).catch((e) => console.error(`Teardown ${id}: could not record failed writer run`, e));
    }
    // Calls aborted at the deadline throw the SDK's abort error; the row says why.
    const message = budget.expired ? budget.message() : err instanceof Error ? err.message : String(err);
    await setStatus(id, "failed", message);
    throw budget.expired && !(err instanceof DeadlineError) ? new DeadlineError(message, { cause: err }) : err;
  }
}
