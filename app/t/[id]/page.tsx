import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Cooking, Private } from "@/components/Waiting";
import Report from "@/components/Report";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import { STALE_RUN_ERROR, failStaleRun, isInProgress } from "@/lib/engine/store";
import { refundIfPaid } from "@/lib/payments";
import { canViewTeardown, readTeardown, type LoadedTeardown } from "@/lib/teardown";
import { isDesignId } from "@/lib/waiting";
import "@/styles/report.css";

type Props = { params: Promise<{ id: string }> };

// The admin re-run action runs the engine after its response, within this page's limit.
export const maxDuration = 300;

// Design fixtures never touch the database. cache() shares one lookup between
// generateMetadata and the page.
const load = cache(async (id: string): Promise<LoadedTeardown | null> => {
  const t = await readTeardown(id);
  if (!t || t.report || isDesignId(id)) return t;
  let { status, error } = t;
  // A run that stopped updating its row is marked failed, so the admin re-run button appears.
  if (isInProgress(status) && (await failStaleRun(id))) {
    status = "failed";
    error = STALE_RUN_ERROR;
  }
  let { refunded } = t;
  // A paid run that failed is refunded here if startRun couldn't (swept stale, or Stripe errored then).
  if (status === "failed" && t.paid && !refunded) {
    refunded = await refundIfPaid(id).catch((e) => {
      console.error(`Teardown ${id}: refund failed`, e);
      return false;
    });
  }
  return { ...t, status, error, refunded };
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = await load(id);
  const visible = !!t?.report && (await canViewTeardown(id, t.ownerHash));
  return {
    title: visible ? `${t.report!.idea.name} — Tearitdown` : "Tearitdown",
    robots: id === "sample" ? undefined : { index: false },
  };
}

export default async function TeardownPage({ params }: Props) {
  const { id } = await params;
  const t = await load(id);
  if (!t) notFound();
  if (!(await canViewTeardown(id, t.ownerHash))) return <Private />;
  if (!t.report) {
    // sample-error is the design's error layout, including the admin re-run chrome.
    const admin = t.status === "failed" && (id === "sample-error" || isAdminCookie((await cookies()).get(ADMIN_COOKIE)?.value));
    return <Cooking id={id} t={t} admin={admin ? { error: t.error } : undefined} />;
  }
  return <Report report={t.report} label={id === "sample" ? "Sample report" : undefined} pdfHref={`/t/${id}/pdf`} />;
}
