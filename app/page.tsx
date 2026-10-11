import type { Metadata } from "next";
import Join from "@/components/Join";
import "@/styles/home.css";

export const metadata: Metadata = {
  title: "Teardown — Market readouts for new business ideas",
  description: "A one-page verdict on any business idea, with the full teardown behind it: competitors, pricing, customers, and open ground.",
};

export default function Home() {
  return (
    <>
      <header><div className="wrap"><span>Teardown</span><span>Market Readouts</span></div></header>
      <main><div className="wrap">
        <p className="eyebrow">Opening soon</p>
        <h1>Know the market before you enter it.</h1>
        <p className="pitch">Submit a business idea. Receive a one-page verdict, with the full teardown behind it.</p>
        <div className="grid">
          <div><b>Competitors</b><p>Who already serves this need, direct and adjacent.</p></div>
          <div><b>Pricing</b><p>What they charge and how the offer is structured.</p></div>
          <div><b>Customers</b><p>Who buys from them, and why.</p></div>
          <div><b>Openings</b><p>Where demand is underserved and a new entrant can win.</p></div>
        </div>
        <p className="desc">Each teardown is structured for a decision, so you can tell in minutes whether an idea deserves further work. Pricing will be a single payment of $5–10 per teardown. No subscription.</p>
        <Join />
      </div></main>
      <footer><div className="wrap"><span>© 2026 Teardown</span><a href="/privacy">Privacy Policy</a><a href="/data">Data Policy</a></div></footer>
    </>
  );
}
