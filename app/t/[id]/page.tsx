import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import Report from "@/components/Report";
import { init, sql } from "@/lib/db";
import { SAMPLE_REPORT, parseReport, type TeardownReport } from "@/lib/engine";
import type { TeardownStatus } from "@/lib/engine/store";
import "@/styles/report.css";

type Props = { params: Promise<{ id: string }> };

type Loaded =
  | { report: TeardownReport }
  | { report: null; status: TeardownStatus; idea: string };

// "sample" is the design's fixture and never touches the database.
// cache() shares one lookup between generateMetadata and the page.
const load = cache(async (id: string): Promise<Loaded | null> => {
  if (id === "sample") return { report: SAMPLE_REPORT };
  if (!process.env.DATABASE_URL || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  await init();
  const rows = await sql()`SELECT status, idea, report FROM teardowns WHERE id = ${id}`;
  if (!rows.length) return null;
  const row = rows[0];
  // A queued or running teardown has no report yet.
  return row.report ? { report: parseReport(row.report) } : { report: null, status: row.status, idea: row.idea };
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
  ["Searching the market", ["research"]],
  ["Writing the readout", ["researched"]],
];

function Cooking({ status, idea }: { status: TeardownStatus; idea: string }) {
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
  if (!t.report) return <Cooking status={t.status} idea={t.idea} />;
  return <Report report={t.report} label={id === "sample" ? "Sample report" : undefined} />;
}
