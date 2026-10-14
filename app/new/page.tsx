import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import IntakeForm from "@/components/IntakeForm";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import "@/styles/new.css";

export const metadata: Metadata = {
  title: "New teardown — Teardown",
  robots: { index: false },
};

// The submit action runs the engine after its response (app/new/actions.ts),
// and a server action takes its time limit from the page. 300 s is the Vercel
// Hobby cap; a report takes a few minutes.
export const maxDuration = 300;

// Gated behind ADMIN_KEY until /privacy and /data cover intake data (see CLAUDE.md).
// Unlock once with /new?key=ADMIN_KEY (proxy.ts sets the cookie).
export default async function NewTeardown() {
  if (!isAdminCookie((await cookies()).get(ADMIN_COOKIE)?.value)) notFound();
  return (
    <>
      <header><div className="wrap"><a href="/">Teardown</a><span>New teardown</span></div></header>
      <main><div className="wrap">
        <p className="eyebrow">New teardown</p>
        <h1>Describe your idea.</h1>
        <p className="pitch">Four questions, a minute to answer. The more specific you are, the sharper the readout.</p>
        <IntakeForm />
      </div></main>
      <footer><div className="wrap"><span>© 2026 Teardown</span><a href="/privacy">Privacy Policy</a><a href="/data">Data Policy</a></div></footer>
    </>
  );
}
