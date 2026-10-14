import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import Report from "@/components/Report";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import { init, sql } from "@/lib/db";
import { parseReport, type TeardownReport } from "@/lib/engine";
import { SAMPLE_REPORT } from "@/lib/engine/fixtures/sample";
import type { TeardownStatus } from "@/lib/engine/store";
import "@/styles/report.css";
import { rerunTeardown } from "./actions";

type Props = { params: Promise<{ id: string }> };

// The admin re-run action runs the engine after its response, within this page's limit.
export const maxDuration = 800;

type Loaded =
  | { report: TeardownReport }
  | { report: null; status: TeardownStatus; idea: string; error: string | null };

// "sample" is the design's fixture and never touches the database.
// cache() shares one lookup between generateMetadata and the page.
const load = cache(async (id: string): Promise<Loaded | null> => {
  if (id === "sample") return { report: SAMPLE_REPORT };
  if (!process.env.DATABASE_URL || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  await init();
  const rows = await sql()`SELECT status, idea, report, error FROM teardowns WHERE id = ${id}`;
  if (!rows.length) return null;
  const row = rows[0];
  // A queued or running teardown has no report yet.
  return row.report ? { report: parseReport(row.report) } : { report: null, status: row.status, idea: row.idea, error: row.error };
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const t = await load(id);
  return {
    title: t?.report ? `${t.report.idea.name} — Teardown` : "Teardown",
    robots: id === "sample" ? undefined : { index: false },
  };
}

const STEPS: [string, TeardownStatus[]][] = [
  ["Reading your idea", ["queued", "intake"]],
  ["Searching the market", ["research", "section_research"]],
  ["Writing the readout", ["writing", "factcheck", "drafted"]],
];

/** `admin` is set only for the admin cookie: the saved error and a re-run button. Never shown to anyone else. */
function Cooking({ status, idea, admin }: { status: TeardownStatus; idea: string; admin?: { id: string; error: string | null } }) {
  const failed = status === "failed";
  const now = STEPS.findIndex(([, s]) => s.includes(status));
  return (
    <div className="td-doc">
      {!failed && <meta httpEquiv="refresh" content="15" />}
      <div className="td-sheet is-cooking">
        <header className="td-head">
          <div className="td-brand">teardown</div>
          <div className="td-subject">{idea}</div>
        </header>
        <main className="td-cooking" aria-live="polite">
          <div className="td-pagenum">{failed ? "Stopped" : "In the kitchen"}</div>
          <h1 className="td-h1">{failed ? "Something went wrong with this teardown." : "Your teardown is cooking."}</h1>
          <p className="td-dek">
            {failed
              ? "Your answers are saved, so the teardown can be rerun without asking you again."
              : "We’re researching the market for your idea. This page refreshes on its own; you can also come back to this link later."}
          </p>
          {failed && admin && (
            <form action={rerunTeardown.bind(null, admin.id)} className="td-admin">
              <pre className="td-mono">{admin.error ?? "No error saved."}</pre>
              <button type="submit">Re-run from saved answers</button>
            </form>
          )}
          {!failed && (
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
  if (!t.report) {
    const admin = t.status === "failed" && isAdminCookie((await cookies()).get(ADMIN_COOKIE)?.value);
    return <Cooking status={t.status} idea={t.idea} admin={admin ? { id, error: t.error } : undefined} />;
  }
  return <Report report={t.report} label={id === "sample" ? "Sample report" : undefined} />;
}
