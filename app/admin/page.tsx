import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { ADMIN_COOKIE, isAdminCookie } from "@/lib/admin";
import { NEAR_LIMIT_MS, loadDashboard, type CountPoint, type DashboardData, type PeriodSales, type SalesPoint } from "@/lib/admin-metrics";
import "@/styles/admin.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Admin — Teardown",
  robots: { index: false },
};

function usd(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function pct(n: number | null) {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function secs(ms: number | null) {
  return ms == null ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

function money(n: number | null) {
  return n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
}

function Bars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const w = 560;
  const h = 72;
  const gap = 3;
  const bw = (w - gap * Math.max(0, values.length - 1)) / Math.max(1, values.length);
  return (
    <svg className="bars" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {values.map((v, i) => {
        const bh = Math.max(v > 0 ? 2 : 0, (v / max) * (h - 2));
        return <rect key={i} x={i * (bw + gap)} y={h - bh} width={bw} height={bh} />;
      })}
    </svg>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="stat"><b>{label}</b><strong>{value}</strong>{hint ? <span>{hint}</span> : null}</div>;
}

function Period({ label, p }: { label: string; p: PeriodSales }) {
  return <Stat label={label} value={`${p.paid} · ${usd(p.revenueCents)}`} hint={`${p.refunds} refunded · ${p.failed} failed`} />;
}

function Counts({ rows, empty, label = "Name" }: { rows: CountPoint[]; empty: string; label?: string }) {
  if (!rows.length || rows.every((r) => r.count === 0)) return <p className="empty">{empty}</p>;
  return (
    <table>
      <thead><tr><th>{label}</th><th className="num">Count</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.key}><td>{r.key}</td><td className="num">{r.count}</td></tr>)}</tbody>
    </table>
  );
}

function SalesTable({ rows, empty }: { rows: SalesPoint[]; empty: string }) {
  if (rows.every((r) => r.paid === 0)) return <p className="empty">{empty}</p>;
  return (
    <table>
      <thead><tr><th>When</th><th className="num">Paid</th><th className="num">Revenue</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.key}><td>{r.key}</td><td className="num">{r.paid}</td><td className="num">{usd(r.revenueCents)}</td></tr>)}</tbody>
    </table>
  );
}

function Dashboard({ data }: { data: DashboardData }) {
  const { sales, waitlist, runs, traffic } = data;
  return (
    <>
      <header><div className="wrap"><a href="/">Teardown</a><span>Admin</span></div></header>
      <main><div className="wrap">
        <p className="eyebrow">Admin</p>
        <h1>How the business is doing.</h1>
        <p className="lede">
          Numbers come from our database. Sales use paid teardowns (a Stripe payment ID on the row);
          revenue is the amount Stripe already sent on the webhook, in USD. Page views start after this ships.
          Search Console and Vercel Analytics totals are not wired — see the last section.
        </p>

        <section>
          <h2>Sales</h2>
          <p className="note">
            Paid = row has a payment intent. Checkout started = awaiting payment or already paid (admin skip-payment is excluded).
            Sale date is <code>paid_at</code>, or <code>created_at</code> on older rows. Today and the week are UTC.
            {sales.paidWithoutAmount ? ` ${sales.paidWithoutAmount} paid row${sales.paidWithoutAmount === 1 ? "" : "s"} have no stored amount, so revenue undercounts them.` : ""}
          </p>
          <div className="stats">
            <Period label="Today" p={sales.today} />
            <Period label="Last 7 days" p={sales.week} />
            <Period label="All time" p={sales.all} />
            <Stat label="Checkout → paid" value={pct(sales.conversion)} hint={`${sales.paid} paid / ${sales.checkoutStarted} started`} />
          </div>
          <div className="stats more">
            <Stat label="Refunds" value={String(sales.refunds)} hint={usd(sales.refundCents)} />
            <Stat label="Failed after pay" value={String(sales.failedPaid)} />
          </div>
          <div className="pair">
            <div>
              <p className="note">Paid by day (14 days)</p>
              <Bars values={sales.byDay.map((d) => d.paid)} />
              <SalesTable rows={sales.byDay} empty="No paid teardowns in the last 14 days." />
            </div>
            <div>
              <p className="note">Paid by ISO week</p>
              <Bars values={sales.byWeek.map((d) => d.paid)} />
              <SalesTable rows={sales.byWeek} empty="No paid teardowns in these weeks." />
            </div>
          </div>
        </section>

        <section>
          <h2>Waitlist</h2>
          <p className="note">From <code>signups</code>. Source is the <code>?ref=</code> captured on join.</p>
          <div className="stats">
            <Stat label="Total signups" value={String(waitlist.total)} />
          </div>
          <div className="pair">
            <div>
              <p className="note">Signups by day (14 days)</p>
              <Bars values={waitlist.byDay.map((d) => d.count)} />
              <Counts rows={waitlist.byDay} label="Day" empty="No signups in the last 14 days." />
            </div>
            <div>
              <p className="note">Signups by source</p>
              <Counts rows={waitlist.bySource} label="Source" empty="No signups yet." />
            </div>
          </div>
        </section>

        <section>
          <h2>Ideas and reports</h2>
          <p className="note">
            Runtime is the wall-clock span of stored <code>stage_runs</code> (same as <code>scripts/stage-timings.ts</code>).
            Close to the limit means ≥ {NEAR_LIMIT_MS / 1000}s of the 300s Vercel cap. Failure rate is failed / (done + failed).
            Refund rate is refunded / paid.
          </p>
          <div className="stats">
            <Stat label="Ideas submitted" value={String(runs.ideas)} />
            <Stat label="Avg Anthropic cost" value={money(runs.avgCostUsd)} />
            <Stat label="Avg runtime" value={secs(runs.avgRuntimeMs)} hint={`p50 ${secs(runs.p50Ms)} · p90 ${secs(runs.p90Ms)}`} />
            <Stat label="Near 300s cap" value={`${runs.nearLimit} / ${runs.timed}`} hint={`≥ ${NEAR_LIMIT_MS / 1000}s wall time`} />
          </div>
          <div className="stats more">
            <Stat label="Failure rate" value={pct(runs.failureRate)} hint={`${runs.failed} failed / ${runs.settled} settled`} />
            <Stat label="Refund rate" value={pct(runs.refundRate)} hint={`${sales.refunds} refunded / ${sales.paid} paid`} />
          </div>
          {runs.byStatus.length ? (
            <table className="block-gap">
              <thead><tr><th>Status</th><th className="num">Runs</th></tr></thead>
              <tbody>{runs.byStatus.map((r) => <tr key={r.status}><td>{r.status}</td><td className="num">{r.count}</td></tr>)}</tbody>
            </table>
          ) : <p className="empty">No teardowns yet.</p>}
        </section>

        <section>
          <h2>Where visitors come from</h2>
          <p className="note">
            First-party events only: public page views and checkout starts. We store path, referring hostname, optional <code>ref</code> / UTM, and time — no IP, no extra cookie.
            Checkout starts are also written when Stripe Checkout is opened. Signups-by-ref above is the waitlist table; this section is events plus that mix.
          </p>
          <div className="stats">
            <Stat label="Page views" value={String(traffic.pageViews)} />
            <Stat label="Checkout starts" value={String(traffic.checkoutStarts)} hint="from events" />
          </div>
          {traffic.pageViews === 0 && traffic.checkoutStarts === 0 ? (
            <p className="empty">No first-party events yet. They begin recording after this deploy.</p>
          ) : (
            <div className="pair">
              <div>
                <p className="note">Top paths</p>
                <Counts rows={traffic.byPath} label="Path" empty="No page views yet." />
                <p className="note block-gap">Top referrers</p>
                <Counts rows={traffic.byReferrer} label="Referrer" empty="No referrers yet." />
              </div>
              <div>
                <p className="note">By ?ref= (signups, checkouts, views)</p>
                {traffic.byRef.length ? (
                  <table>
                    <thead><tr><th>Ref</th><th className="num">Signups</th><th className="num">Checkouts</th><th className="num">Views</th></tr></thead>
                    <tbody>{traffic.byRef.map((r) => (
                      <tr key={r.key}><td>{r.key}</td><td className="num">{r.signups}</td><td className="num">{r.checkouts}</td><td className="num">{r.views}</td></tr>
                    ))}</tbody>
                  </table>
                ) : <p className="empty">No ref data yet.</p>}
                <p className="note block-gap">UTM</p>
                {traffic.byUtm.length ? (
                  <table>
                    <thead><tr><th>Source</th><th>Medium</th><th>Campaign</th><th className="num">Views</th><th className="num">Checkouts</th></tr></thead>
                    <tbody>{traffic.byUtm.map((r) => (
                      <tr key={`${r.source}-${r.medium}-${r.campaign}`}><td>{r.source}</td><td>{r.medium}</td><td>{r.campaign}</td><td className="num">{r.views}</td><td className="num">{r.checkouts}</td></tr>
                    ))}</tbody>
                  </table>
                ) : <p className="empty">No UTM on recorded events yet.</p>}
              </div>
            </div>
          )}
        </section>

        <section>
          <h2>Search and hosting analytics</h2>
          <div className="placeholder">
            <span className="tag">Not wired</span>
            <p>
              Google Search Console and Vercel Analytics are not connected here. No extra credentials were added.
              The site already loads Vercel Web Analytics in the layout; those totals live in the Vercel dashboard, not in our database.
            </p>
            <ul>
              <li>
                <a href="https://search.google.com/search-console">Google Search Console</a>
                {" "}— verify the domain, then a later change can pull queries and coverage with a Search Console API client (OAuth or a service account). Nothing is configured.
              </li>
              <li>
                <a href="https://vercel.com/docs/analytics">Vercel Analytics</a>
                {" "}— open the project’s Analytics tab for page views and referrers. Showing them on this page would need a Vercel API token. Not configured.
              </li>
            </ul>
          </div>
        </section>
      </div></main>
      <footer><div className="wrap"><span>© 2026 Teardown</span><a href="/">Home</a><a href="/new">New</a></div></footer>
    </>
  );
}

export default async function AdminPage() {
  if (!isAdminCookie((await cookies()).get(ADMIN_COOKIE)?.value)) notFound();
  return <Dashboard data={await loadDashboard()} />;
}
