import { cookies } from "next/headers";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import { init, sql } from "@/lib/db";
import { parseReport, type TeardownReport } from "@/lib/engine";
import { SAMPLE_REPORT } from "@/lib/engine/fixtures/sample";
import type { TeardownStatus } from "@/lib/engine/store";
import { isOwnerToken, ownerCookie } from "@/lib/payments";
import { DESIGN_ERROR, DESIGN_WAITING, isDesignId } from "@/lib/waiting";

export type LoadedTeardown =
  | { report: TeardownReport; ownerHash: string | null }
  | { report: null; ownerHash: string | null; status: TeardownStatus; idea: string; error: string | null; paid: boolean; refunded: boolean };

/**
 * Read a teardown for the page or the PDF route. Design fixtures never touch
 * the database. No writes: stale-run and refund side effects stay on the page.
 */
export async function readTeardown(id: string): Promise<LoadedTeardown | null> {
  if (id === "sample") return { report: SAMPLE_REPORT, ownerHash: null };
  if (id === "sample-waiting") return { report: null, ownerHash: null, ...DESIGN_WAITING };
  if (id === "sample-error") return { report: null, ownerHash: null, ...DESIGN_ERROR };
  if (!process.env.DATABASE_URL || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  await init();
  const rows = await sql()`SELECT status, idea, report, error, payment_intent, refunded_at, owner_token_hash FROM teardowns WHERE id = ${id}`;
  if (!rows.length) return null;
  const row = rows[0];
  const ownerHash: string | null = row.owner_token_hash ?? null;
  if (row.report) return { report: parseReport(row.report), ownerHash };
  return {
    report: null,
    ownerHash,
    status: row.status as TeardownStatus,
    idea: row.idea,
    error: row.error,
    paid: !!row.payment_intent,
    refunded: !!row.refunded_at,
  };
}

/** Design fixtures are public. Every other teardown is owner cookie or admin cookie. */
export async function canViewTeardown(id: string, ownerHash: string | null): Promise<boolean> {
  if (isDesignId(id)) return true;
  const jar = await cookies();
  return isAdminCookie(jar.get(ADMIN_COOKIE)?.value) || isOwnerToken(jar.get(ownerCookie(id))?.value, ownerHash);
}
