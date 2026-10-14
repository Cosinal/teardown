import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import Report from "@/components/Report";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import { init, sql } from "@/lib/db";
import { parseReport, type TeardownReport } from "@/lib/engine";
import { SAMPLE_REPORT } from "@/lib/engine/fixtures/sample";
import { STALE_RUN_ERROR, failStaleRun, isInProgress, type TeardownStatus } from "@/lib/engine/store";
import { isOwnerToken, ownerCookie, refundIfPaid } from "@/lib/payments";
import "@/styles/report.css";
import { rerunTeardown, resumeCheckout } from "./actions";

type Props = { params: Promise<{ id: string }> };

// The admin re-run action runs the engine after its response, within this page's limit.
export const maxDuration = 300;

type Loaded =
  | { report: TeardownReport; ownerHash: string | null }
  | { report: null; ownerHash: string | null; status: TeardownStatus; idea: string; error: string | null; paid: boolean; refunded: boolean };

// "sample" is the design's fixture and never touches the database.
// cache() shares one lookup between generateMetadata and the page.
const load = cache(async (id: string): Promise<Loaded | null> => {
  if (id === "sample") return { report: SAMPLE_REPORT, ownerHash: null };
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

/** The sample is public. Every other teardown is shown only to its owner cookie or the admin cookie. */
async function canView(id: string, t: Loaded): Promise<boolean> {
  if (id === "sample") return true;
  const jar = await cookies();
  return isAdminCookie(jar.get(ADMIN_COOKIE)?.value) || isOwnerToken(jar.get(ownerCookie(id))?.value, t.ownerHash);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = await load(id);
  const visible = !!t?.report && (await canView(id, t));
  return {
    title: visible ? `${t.report!.idea.name} — Teardown` : "Teardown",
    robots: id === "sample" ? undefined : { index: false },
  };
}

const STEPS: [string, TeardownStatus[]][] = [
  ["Reading your idea", ["queued", "intake"]],
  ["Searching the market", ["research", "section_research"]],
  ["Writing the readout", ["writing", "factcheck", "drafted"]],
];

/** Shown instead of a teardown to anyone without its owner cookie or the admin cookie. Renders no row data. */
function Private() {
  return (
    <div className="td-doc">
      <div className="td-sheet is-cooking">
        <header className="td-head">
          <div className="td-brand">teardown</div>
        </header>
        <main className="td-cooking">
          <div className="td-pagenum">Private</div>
          <h1 className="td-h1">This teardown is private.</h1>
          <p className="td-dek">Only the person who paid for it can see it, in the browser they paid from.</p>
        </main>
      </div>
    </div>
  );
}

type Waiting = Extract<Loaded, { report: null }>;

/** `admin` is set only for the admin cookie: the saved error and a re-run button. Never shown to anyone else. */
function Cooking({ id, t, admin }: { id: string; t: Waiting; admin?: { error: string | null } }) {
  const { status, idea, paid, refunded } = t;
  const failed = status === "failed";
  const unpaid = status === "awaiting_payment";
  const now = STEPS.findIndex(([, s]) => s.includes(status));
  const [pagenum, h1, dek] = unpaid
    ? ["Checkout", "Waiting for payment.", "Your answers are saved. Once your payment goes through, the teardown starts and this page updates on its own."]
    : failed && refunded
      ? ["Stopped", "Something went wrong, you’ve been refunded.", "Your payment has been refunded in full. It can take 5–10 business days to reach your account."]
      : failed && paid
        ? ["Stopped", "Something went wrong with this teardown.", "Your payment will be refunded in full."]
        : failed
          ? ["Stopped", "Something went wrong with this teardown.", "Your answers are saved, so the teardown can be rerun without asking you again."]
          : ["In the kitchen", "Your teardown is cooking.", "We’re researching the market for your idea. This page refreshes on its own; you can also come back to this link later."];
  return (
    <div className="td-doc">
      {/* Unpaid too: the webhook usually lands a moment after Stripe sends the founder back here. */}
      {!failed && <meta httpEquiv="refresh" content="15" />}
      <div className="td-sheet is-cooking">
        <header className="td-head">
          <div className="td-brand">teardown</div>
          <div className="td-subject">{idea}</div>
        </header>
        <main className="td-cooking" aria-live="polite">
          <div className="td-pagenum">{pagenum}</div>
          <h1 className="td-h1">{h1}</h1>
          <p className="td-dek">{dek}</p>
          {unpaid && (
            <form action={resumeCheckout.bind(null, id)} className="td-pay">
              <button type="submit">Not paid yet? Go to checkout</button>
            </form>
          )}
          {failed && admin && (
            <form action={rerunTeardown.bind(null, id)} className="td-admin">
              <pre className="td-mono">{admin.error ?? "No error saved."}</pre>
              <button type="submit">Re-run from saved answers</button>
            </form>
          )}
          {!failed && !unpaid && (
            <ol className="td-steps">
              {STEPS.map(([label], i) => (
                <li key={label} className={i < now ? "is-done" : i === now ? "is-now" : undefined}>{label}</li>
              ))}
            </ol>
          )}
        </main>
      </div>
    </div>
  );
}

export default async function TeardownPage({ params }: Props) {
  const { id } = await params;
  const t = await load(id);
  if (!t) notFound();
  if (!(await canView(id, t))) return <Private />;
  if (!t.report) {
    const admin = t.status === "failed" && isAdminCookie((await cookies()).get(ADMIN_COOKIE)?.value);
    return <Cooking id={id} t={t} admin={admin ? { error: t.error } : undefined} />;
  }
  return <Report report={t.report} label={id === "sample" ? "Sample report" : undefined} />;
}
