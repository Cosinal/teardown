import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Cooking, Private } from "@/components/Waiting";
import Report from "@/components/Report";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import { init, sql } from "@/lib/db";
import { parseReport, type TeardownReport } from "@/lib/engine";
import { SAMPLE_REPORT } from "@/lib/engine/fixtures/sample";
import { STALE_RUN_ERROR, failStaleRun, isInProgress, type TeardownStatus } from "@/lib/engine/store";
import { DESIGN_ERROR, DESIGN_WAITING, isDesignId } from "@/lib/waiting";
import { isOwnerToken, ownerCookie, refundIfPaid } from "@/lib/payments";
import "@/styles/report.css";

type Props = { params: Promise<{ id: string }> };

// The admin re-run action runs the engine after its response, within this page's limit.
export const maxDuration = 300;

type Loaded =
  | { report: TeardownReport; ownerHash: string | null }
  | { report: null; ownerHash: string | null; status: TeardownStatus; idea: string; error: string | null; paid: boolean; refunded: boolean };

// Design fixtures never touch the database. cache() shares one lookup between
// generateMetadata and the page.
const load = cache(async (id: string): Promise<Loaded | null> => {
  if (id === "sample") return { report: SAMPLE_REPORT, ownerHash: null };
  if (id === "sample-waiting") return { report: null, ownerHash: null, ...DESIGN_WAITING };
  if (id === "sample-error") return { report: null, ownerHash: null, ...DESIGN_ERROR };
  if (!process.env.DATABASE_URL || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  await init();
  const rows = await sql()`SELECT status, idea, report, error, payment_intent, refunded_at, owner_token_hash FROM teardowns WHERE id = ${id}`;
  if (!rows.length) return null;
  const row = rows[0];
  const ownerHash: string | null = row.owner_token_hash ?? null;
  // A queued or running teardown has no report yet.
  if (row.report) return { report: parseReport(row.report), ownerHash };
  let { status, error } = row as { status: TeardownStatus; error: string | null };
  // A run that stopped updating its row is marked failed, so the admin re-run button appears.
  if (isInProgress(status) && (await failStaleRun(id))) {
    status = "failed";
    error = STALE_RUN_ERROR;
  }
  const paid = !!row.payment_intent;
  let refunded = !!row.refunded_at;
  // A paid run that failed is refunded here if startRun couldn't (swept stale, or Stripe errored then).
  if (status === "failed" && paid && !refunded) {
    refunded = await refundIfPaid(id).catch((e) => {
      console.error(`Teardown ${id}: refund failed`, e);
      return false;
    });
  }
  return { report: null, ownerHash, status, idea: row.idea, error, paid, refunded };
});

/** Design fixtures are public. Every other teardown is shown only to its owner cookie or the admin cookie. */
async function canView(id: string, t: Loaded): Promise<boolean> {
  if (isDesignId(id)) return true;
  const jar = await cookies();
  return isAdminCookie(jar.get(ADMIN_COOKIE)?.value) || isOwnerToken(jar.get(ownerCookie(id))?.value, t.ownerHash);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = await load(id);
  const visible = !!t?.report && (await canView(id, t));
  return {
    title: visible ? `${t.report!.idea.name} — Tearitdown` : "Tearitdown",
    robots: id === "sample" ? undefined : { index: false },
  };
}

export default async function TeardownPage({ params }: Props) {
  const { id } = await params;
  const t = await load(id);
  if (!t) notFound();
  if (!(await canView(id, t))) return <Private />;
  if (!t.report) {
    // sample-error is the design's error layout, including the admin re-run chrome.
    const admin = t.status === "failed" && (id === "sample-error" || isAdminCookie((await cookies()).get(ADMIN_COOKIE)?.value));
    return <Cooking id={id} t={t} admin={admin ? { error: t.error } : undefined} />;
  }
  return <Report report={t.report} label={id === "sample" ? "Sample report" : undefined} />;
}
