import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export const POLICY_VERSION = "2026-10-10";

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
  })().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}
