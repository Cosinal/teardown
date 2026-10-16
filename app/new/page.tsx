import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import IntakeForm from "@/components/IntakeForm";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import { init, sql } from "@/lib/db";
import { isOwnerToken, ownerCookie } from "@/lib/payments";
import "@/styles/new.css";

export const metadata: Metadata = {
  title: "New readout — Tearitdown",
  robots: { index: false },
};

// An admin who skips payment runs the engine after the submit action's
// response (app/new/actions.ts), and a server action takes its time limit from the page. 300 s is the Vercel
// Hobby cap; a report takes a few minutes.
export const maxDuration = 300;

// Gated behind ADMIN_KEY until /privacy and /data cover intake data (see CLAUDE.md).
// Unlock once with /new?key=ADMIN_KEY (proxy.ts sets the cookie).
/** The answers of an unpaid teardown this browser owns, for /new?draft=<id> (Stripe's cancel URL). */
async function draftValues(id: string | undefined, admin: boolean): Promise<Record<string, string> | undefined> {
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !process.env.DATABASE_URL) return undefined;
  await init();
  const rows = await sql()`SELECT input, owner_token_hash FROM teardowns WHERE id = ${id} AND status = 'awaiting_payment'`;
  if (!rows.length) return undefined;
  if (!admin && !isOwnerToken((await cookies()).get(ownerCookie(id))?.value, rows[0].owner_token_hash)) return undefined;
  const values: Record<string, string> = { draft: id };
  for (const [k, v] of Object.entries(rows[0].input as Record<string, unknown>)) if (typeof v === "string") values[k] = v;
  return values;
}

function one(v: string | string[] | undefined) {
  return typeof v === "string" ? v : undefined;
}

export default async function NewTeardown({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = isAdminCookie((await cookies()).get(ADMIN_COOKIE)?.value);
  if (!admin) notFound();
  const params = await searchParams;
  const values: Record<string, string> = { ...(await draftValues(one(params.draft), admin)) };
  const attr = {
    ref: one(params.ref),
    utm_source: one(params.utm_source),
    utm_medium: one(params.utm_medium),
    utm_campaign: one(params.utm_campaign),
    referrer: (await headers()).get("referer") ?? undefined,
  };
  for (const [k, v] of Object.entries(attr)) if (v) values[k] = v;
  return (
    <>
      <header><div className="wrap"><a href="/">Tearitdown</a><span>New readout</span></div></header>
      <main><div className="wrap">
        <p className="eyebrow">New readout</p>
        <h1>Describe your idea.</h1>
        <p className="pitch">Four questions, a minute to answer. The more specific you are, the sharper the readout.</p>
        <IntakeForm values={values} admin={admin} />
      </div></main>
      <footer><div className="wrap"><span>© 2026 Tearitdown</span><a href="/privacy">Privacy Policy</a><a href="/data">Data Policy</a></div></footer>
    </>
  );
}
