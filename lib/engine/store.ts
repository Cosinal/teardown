import { randomBytes } from "node:crypto";
import { init, sql } from "@/lib/db";
import { FACTCHECK_GAP_PROMPT, FACTCHECK_PROMPT } from "./factcheck";
import type { IntakeInput } from "./input";
import { INTAKE_PROMPT } from "./intake";
import type { StageRun } from "./llm";
import { runPipeline, type StageOptions, type StagesResult, type TeardownStatus } from "./pipeline";
import { RESEARCH_PROMPT, type SourceStore } from "./research";
import { ALTERNATIVES_RESEARCH_PROMPT, ALTERNATIVES_WRITE_PROMPT } from "./sections/alternatives";
import { WRITER_SHARED_PROMPT } from "./sections/common";

export type { StageOptions, StagesResult, TeardownStatus } from "./pipeline";

// Teardown rows and their sources in Neon. The engine's stages are pure; this
// module records what they produce.

/** Stored in teardowns.prompt_version: every stage's prompt version in this pipeline. */
export const PIPELINE_VERSION = [
  INTAKE_PROMPT, RESEARCH_PROMPT, ALTERNATIVES_RESEARCH_PROMPT, WRITER_SHARED_PROMPT, ALTERNATIVES_WRITE_PROMPT, FACTCHECK_PROMPT, FACTCHECK_GAP_PROMPT,
].join("+");

export function newTeardownId() {
  return randomBytes(9).toString("base64url");
}

export async function createTeardown(input: IntakeInput): Promise<string> {
  await init();
  const id = newTeardownId();
  await sql()`INSERT INTO teardowns (id, idea, report, prompt_version, status, input)
    VALUES (${id}, ${input.idea}, NULL, ${PIPELINE_VERSION}, 'queued', ${JSON.stringify(input)}::jsonb)`;
  return id;
}

async function setStatus(id: string, status: TeardownStatus, error: string | null = null) {
  await sql()`UPDATE teardowns SET status = ${status}, error = ${error}, updated_at = now() WHERE id = ${id}`;
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
 * Runs the pipeline for a queued teardown and records each step: statuses,
 * stage runs (fact-check's include the per-claim log), sources and sections. Billable: callers must gate this behind payment (see CLAUDE.md).
 */
export async function runStages(id: string, options: StageOptions = {}): Promise<StagesResult> {
  await init();
  const rows = await sql()`SELECT status, input FROM teardowns WHERE id = ${id}`;
  if (!rows.length) throw new Error(`Teardown ${id} not found`);
  if (rows[0].status !== "queued") throw new Error(`Teardown ${id} is ${rows[0].status}, not queued`);
  const input = rows[0].input as IntakeInput;

  try {
    return await runPipeline(input, options, {
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
    });
  } catch (err) {
    await setStatus(id, "failed", err instanceof Error ? err.message : String(err));
    throw err;
  }
}
