import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export const POLICY_VERSION = "2026-10-15";

let client: NeonQueryFunction<false, false> | undefined;
let ready: Promise<unknown> | undefined;

// Created lazily so importing this module (e.g. during `next build`) doesn't
// require DATABASE_URL.
export function sql() {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    client = neon(url);
  }
  return client;
}

// Idempotent, non-destructive schema setup. Runs once per server instance.
export function init() {
  ready ??= (async () => {
    const q = sql();
    await q`CREATE TABLE IF NOT EXISTS signups (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      consent BOOLEAN NOT NULL,
      policy_version TEXT NOT NULL,
      ref TEXT)`;
    // Existing tables predate the ref column.
    await q`ALTER TABLE signups ADD COLUMN IF NOT EXISTS ref TEXT`;
    await q`CREATE TABLE IF NOT EXISTS teardowns (
      id TEXT PRIMARY KEY,
      idea TEXT NOT NULL,
      report JSONB NOT NULL,
      prompt_version TEXT NOT NULL,
      cost_usd NUMERIC(10, 4),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    // Engine run tracking. A queued teardown has no report yet, so report
    // becomes nullable (no data is touched). Existing rows all have reports,
    // so they default to "done".
    await q`ALTER TABLE teardowns ALTER COLUMN report DROP NOT NULL`;
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'done'`;
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS input JSONB`;
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS idea_spec JSONB`;
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS research_notes TEXT`;
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS stage_runs JSONB NOT NULL DEFAULT '[]'`;
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS error TEXT`;
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
    // Written report sections keyed by name, e.g. {"alternatives": {...}}, citing source ids.
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS sections JSONB NOT NULL DEFAULT '{}'`;
    // Payments: the Stripe payment intent that paid for the run, when it was
    // refunded (set once, so a failed run is never refunded twice), and the
    // sha256 of the owner cookie's token. All null on rows from before payments.
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS payment_intent TEXT`;
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`;
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS owner_token_hash TEXT`;
    // Dashboard: when the webhook marked the row paid, and the amount Stripe
    // already sent (cents). Null on rows paid before this existed.
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`;
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS amount_cents INTEGER`;
    await q`ALTER TABLE teardowns ADD COLUMN IF NOT EXISTS currency TEXT`;
    // First-party page views and checkout starts. Path, optional campaign
    // codes, referring hostname, time. No IP, no cookie, no user id.
    await q`CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      ref TEXT,
      referrer TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    await q`CREATE INDEX IF NOT EXISTS events_kind_created_idx ON events (kind, created_at)`;
    await q`CREATE INDEX IF NOT EXISTS events_path_idx ON events (path)`;
    await q`CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at)`;
    await q`CREATE TABLE IF NOT EXISTS sources (
      teardown_id TEXT NOT NULL REFERENCES teardowns(id),
      source_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      retrieved_at TIMESTAMPTZ NOT NULL,
      excerpt TEXT NOT NULL,
      PRIMARY KEY (teardown_id, source_id))`;
    // Fact-check's page cache: the cited page's text (or why it couldn't be
    // fetched), so each URL is fetched once (lib/engine/fetch.ts).
    await q`ALTER TABLE sources ADD COLUMN IF NOT EXISTS page_text TEXT`;
    await q`ALTER TABLE sources ADD COLUMN IF NOT EXISTS page_error TEXT`;
    await q`ALTER TABLE sources ADD COLUMN IF NOT EXISTS page_fetched_at TIMESTAMPTZ`;
    await q`CREATE INDEX IF NOT EXISTS sources_url_idx ON sources (url)`;
  })().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}
