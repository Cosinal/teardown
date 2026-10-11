import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import Report from "@/components/Report";
import { init, sql } from "@/lib/db";
import { SAMPLE_REPORT, parseReport, type TeardownReport } from "@/lib/engine";
import "@/styles/report.css";

type Props = { params: Promise<{ id: string }> };

// "sample" is the design's fixture and never touches the database.
// cache() shares one lookup between generateMetadata and the page.
const load = cache(async (id: string): Promise<TeardownReport | null> => {
  if (id === "sample") return SAMPLE_REPORT;
  if (!process.env.DATABASE_URL || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  await init();
  const rows = await sql()`SELECT report FROM teardowns WHERE id = ${id}`;
  return rows.length ? parseReport(rows[0].report) : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const report = await load(id);
  return {
    title: report ? `${report.idea.name} — Teardown` : "Teardown",
    robots: id === "sample" ? undefined : { index: false },
  };
}

export default async function TeardownPage({ params }: Props) {
  const { id } = await params;
  const report = await load(id);
  if (!report) notFound();
  return <Report report={report} label={id === "sample" ? "Sample report" : undefined} />;
}
