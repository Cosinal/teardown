import { randomBytes } from "node:crypto";
import { init, sql } from "@/lib/db";
import type { IntakeInput } from "./input";
import { INTAKE_PROMPT, runIntake, type IdeaSpec } from "./intake";
import type { StageRun } from "./llm";
import { RESEARCH_PROMPT, runResearch, type SourceStore } from "./research";

export interface StagesResult {
  spec: IdeaSpec;
  sources: SourceStore;
  notes: string;
  runs: StageRun[];
  /** Raw research responses, for debugging. */
  responses: Awaited<ReturnType<typeof runResearch>>["responses"];
}

// Teardown rows and their sources in Neon. The engine's stages are pure; this
// module records what they produce.

/** queued -> intake -> research -> researched, or failed at any step. "done" means a report exists. */
export type TeardownStatus = "queued" | "intake" | "research" | "researched" | "failed" | "done";

/** Stored in teardowns.prompt_version: every stage's prompt version in this pipeline. */
export const PIPELINE_VERSION = `${INTAKE_PROMPT}+${RESEARCH_PROMPT}`;

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

async function saveSources(id: string, sources: SourceStore) {
  const q = sql();
  await q.transaction(sources.map((s) => q`INSERT INTO sources (teardown_id, source_id, url, title, retrieved_at, excerpt)
    VALUES (${id}, ${s.id}, ${s.url}, ${s.title}, ${s.retrieved_at}, ${s.excerpt})`));
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
 * Runs intake and research for a queued teardown and records each stage.
 * Billable: callers must gate this behind payment (see CLAUDE.md).
 */
export async function runStages(id: string): Promise<StagesResult> {
  await init();
  const rows = await sql()`SELECT status, input FROM teardowns WHERE id = ${id}`;
  if (!rows.length) throw new Error(`Teardown ${id} not found`);
  if (rows[0].status !== "queued") throw new Error(`Teardown ${id} is ${rows[0].status}, not queued`);
  const input = rows[0].input as IntakeInput;

  try {
    await setStatus(id, "intake");
    const intake = await runIntake(input);
    await sql()`UPDATE teardowns SET idea_spec = ${JSON.stringify(intake.spec)}::jsonb WHERE id = ${id}`;
    await recordRun(id, intake.run);

    await setStatus(id, "research");
    const research = await runResearch(intake.spec);
    await saveSources(id, research.sources);
    await sql()`UPDATE teardowns SET research_notes = ${research.notes} WHERE id = ${id}`;
    await recordRun(id, research.run);

    await setStatus(id, "researched");
    return { spec: intake.spec, sources: research.sources, notes: research.notes, runs: [intake.run, research.run], responses: research.responses };
  } catch (err) {
    await setStatus(id, "failed", err instanceof Error ? err.message : String(err));
    throw err;
  }
}
