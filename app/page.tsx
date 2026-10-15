import type { Metadata } from "next";
import Join from "@/components/Join";
import Track from "@/components/Track";
import "@/styles/home.css";

const title = "Tearitdown — Market readouts for new business ideas";
const description =
  "Submit a startup idea. Receive a nine-section report, with sourced, fact-checked claims, so you can decide whether to build.";

export const metadata: Metadata = {
  title,
  description,
  openGraph: { title, description },
};

export default function Home() {
  return (
    <>
      <Track path="/" />
      <header><div className="wrap"><span>Tearitdown</span><span>Market Readouts</span></div></header>
      <main><div className="wrap">
        <p className="eyebrow">Opening soon</p>
        <h1>Know the market before you enter it.</h1>
        <p className="pitch">Submit a startup idea. Receive a nine-section report, with sourced claims that are fact-checked.</p>
        <div className="grid">
          <div><b>Verdict</b><p>Whether to pursue, test first, or drop.</p></div>
          <div><b>Alternatives</b><p>Who already serves this need, and how they fall short.</p></div>
          <div><b>Demand</b><p>Whether people are looking for this, and the evidence.</p></div>
          <div><b>Economics</b><p>What it costs to deliver, and whether the numbers work.</p></div>
        </div>
        <p className="desc">Each report also names the riskiest assumption and the next tests to run, so you can decide whether to build.</p>
        <Join />
      </div></main>
      <footer><div className="wrap"><span>© 2026 Tearitdown</span><a href="/privacy">Privacy Policy</a><a href="/data">Data Policy</a></div></footer>
    </>
  );
}
