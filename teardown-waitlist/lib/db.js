const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
let ready;
function init() {
  ready ??= sql`CREATE TABLE IF NOT EXISTS signups (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    consent BOOLEAN NOT NULL,
    policy_version TEXT NOT NULL)`;
  return ready;
}
module.exports = { sql, init, POLICY_VERSION: '2026-10-10' };
