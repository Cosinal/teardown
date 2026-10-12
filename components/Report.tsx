import { Fragment, type ReactNode } from "react";
import type { Cite, Claim, Figure, Level, Rating, Rich, ScoreEntry, TeardownReport, VerdictCall } from "@/lib/engine/types";

// Renders a TeardownReport as the 5-page design. Styles live in styles/report.css.

const PAGES = 5;

const CALLS: [VerdictCall, string][] = [["pursue", "Pursue"], ["test_first", "Test first"], ["drop", "Drop"]];
const LEVELS: [Level, string][] = [["low", "Low"], ["medium", "Medium"], ["high", "High"]];
const SCORE_ROWS: [keyof TeardownReport["scorecard"], string][] = [
  ["alternatives", "Existing alternatives"],
  ["demand_evidence", "Demand evidence"],
  ["economics", "Economics"],
  ["distribution", "Distribution"],
  ["blockers", "Blockers"],
];

function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** [1,2,3,5,7,8] -> "1 to 3, 5 and 7 to 8" */
function ranges(nums: number[]) {
  const runs: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    runs.push(j > i ? `${nums[i]} to ${nums[j]}` : `${nums[i]}`);
    i = j + 1;
  }
  return runs.length > 1 ? `${runs.slice(0, -1).join(", ")} and ${runs[runs.length - 1]}` : runs[0];
}

function CiteTag({ basis, source }: Cite) {
  return basis === "found" ? (
    <span className="td-cite"><span className="td-found">FOUND</span><sup className="td-found-n">{source}</sup></span>
  ) : (
    <span className="td-cite is-est"><span className="td-est">est.</span><sup className="td-est-n">{source}</sup></span>
  );
}

// Text runs are built as single strings: split text nodes shift glyphs by a subpixel.
function Cited({ claim, lead = "" }: { claim: Claim; lead?: string }) {
  return <>{`${lead}${claim.text} `}<CiteTag basis={claim.basis} source={claim.source} /></>;
}

function Text({ value }: { value: Rich }) {
  const parts = Array.isArray(value) ? value : [value];
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {typeof p === "string" ? `${i > 0 ? " " : ""}${p}` : <Cited claim={p} lead={i > 0 ? " " : ""} />}
        </Fragment>
      ))}
    </>
  );
}

function RatingBlocks({ rating }: { rating: Rating }) {
  const on = rating === "strong" ? 3 : rating === "mixed" ? 2 : 1;
  return (
    <span className={`td-rating is-${rating}`}>
      <span aria-hidden="true" className="td-blocks">
        {[0, 1, 2].map((i) => <span key={i} className={i < on ? "td-block is-on" : "td-block"} />)}
      </span>
      <span className="td-rating-label">{rating}</span>
    </span>
  );
}

function Sheet({ n, report, cover, footnote, children }: { n: number; report: TeardownReport; cover?: boolean; footnote?: string; children: ReactNode }) {
  return (
    <div className="td-sheet">
      <header className="td-head">
        <div className="td-brand">teardown</div>
        <div className="td-subject">{report.idea.name}</div>
        <div className="td-date">{formatDate(report.date)}</div>
      </header>
      <main className={cover ? "td-main is-cover" : "td-main"}>{children}</main>
      <footer className="td-foot">
        <div className="td-foot-key">
          <span className="td-found">FOUND</span>
          <span className="td-foot-gap">taken from a cited source</span>
          <span className="td-b">est.</span>
          <span>{`our calculation or inference. ${footnote ?? `Numbers refer to sources on page ${PAGES}.`}`}</span>
        </div>
        <div className="td-foot-page">{`${n} / ${PAGES}`}</div>
      </footer>
    </div>
  );
}

function TitleBlock({ n, title, dek }: { n: number; title: string; dek: string }) {
  return (
    <div className="td-titleblock">
      <div>
        <div className="td-pagenum">{String(n).padStart(2, "0")}</div>
        <h1 className="td-h1">{title}</h1>
      </div>
      <p className="td-dek">{dek}</p>
    </div>
  );
}

function SectionHead({ title, score }: { title: string; score: ScoreEntry }) {
  return (
    <div className="td-sechead">
      <h2 className="td-h2">{title}</h2>
      <RatingBlocks rating={score.rating} />
      <div className="td-aside">{score.finding}</div>
    </div>
  );
}

function VerdictPage({ r, label }: { r: TeardownReport; label?: string }) {
  const risk = r.riskiest_assumptions[0];
  const test = r.next_tests[0];
  return (
    <Sheet n={1} report={r} cover>
      <div>
        <div className="td-eyebrow">Idea teardown{label && ` · ${label}`}</div>
        <h1 className="td-title">{r.idea.headline}</h1>
      </div>

      <section className="td-verdict">
        <div className="td-verdict-top">
          <div>
            <h2 className="td-h2 is-muted">Verdict</h2>
            <div className="td-verdict-call">{CALLS.find(([c]) => c === r.verdict.call)?.[1]}</div>
          </div>
          <p className="td-verdict-summary">{r.verdict.summary}</p>
        </div>
        <div className="td-verdict-scales">
          <ul aria-label="Possible verdicts" className="td-scale">
            {CALLS.map(([c, name]) => <li key={c} aria-current={c === r.verdict.call || undefined}>{name}</li>)}
          </ul>
          <div className="td-confidence">
            <h2 className="td-h2 is-muted">Confidence</h2>
            <ul aria-label="Confidence levels" className="td-scale is-narrow">
              {LEVELS.map(([l, name]) => <li key={l} aria-current={l === r.verdict.confidence || undefined}>{name}</li>)}
            </ul>
          </div>
        </div>
      </section>

      <section className="td-rule">
        <h2 className="td-h2">The idea as understood</h2>
        <dl className="td-idea">
          <div><dt>Customer</dt><dd>{r.idea.customer}</dd></div>
          <div><dt>Problem</dt><dd>{r.idea.problem}</dd></div>
          <div><dt>Revenue</dt><dd>{r.idea.revenue}</dd></div>
        </dl>
      </section>

      <section className="td-rule">
        <h2 className="td-h2">Scorecard</h2>
        <table className="td-table td-score">
          <thead>
            <tr><th scope="col">Dimension</th><th scope="col">Rating</th><th scope="col">Key figure</th><th scope="col">Finding</th><th scope="col">Basis</th></tr>
          </thead>
          <tbody>
            {SCORE_ROWS.map(([key, label]) => {
              const s = r.scorecard[key];
              return (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  <td><RatingBlocks rating={s.rating} /></td>
                  <td className="td-score-fig"><span className="td-b">{s.key_figure.value}</span> <span className="td-score-unit">{s.key_figure.unit}</span></td>
                  <td className="td-score-finding">{s.finding}</td>
                  <td className="td-score-basis"><CiteTag basis={s.basis} source={s.source} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="td-risk">
        <h2 className="td-h2 is-accent">Riskiest assumption</h2>
        <p>{risk.short ?? risk.statement}</p>
      </section>

      <section className="td-rule">
        <h2 className="td-h2">Next test</h2>
        <div className="td-nexttest">
          <p>{test.summary ?? test.description}</p>
          <dl className="td-facts">
            <div><dt>Cost</dt><dd>{test.cost}</dd></div>
            <div><dt>Time</dt><dd>{test.time}</dd></div>
            <div><dt>Kill threshold</dt><dd>{test.kill_threshold_short ?? test.kill_threshold}</dd></div>
          </dl>
        </div>
      </section>
    </Sheet>
  );
}

function MarketPage({ r }: { r: TeardownReport }) {
  return (
    <Sheet n={2} report={r}>
      <TitleBlock n={2} title="Market" dek={r.page_summaries.market} />

      <section>
        <SectionHead title="Existing alternatives" score={r.scorecard.alternatives} />
        <table className="td-table td-alt">
          <thead>
            <tr><th scope="col">Alternative</th><th scope="col">What it does</th><th scope="col">Price</th><th scope="col">Weakness</th></tr>
          </thead>
          <tbody>
            {r.alternatives.map((a, i) => (
              <tr key={i}>
                <th scope="row">
                  <div className="td-cell-name">{a.name}</div>
                  {a.workaround ? <div className="td-cell-kind">Manual workaround</div> : <div className="td-cell-sub">{a.examples}</div>}
                </th>
                <td>{a.what_it_does}</td>
                <td><Text value={a.price} /></td>
                <td><Text value={a.weakness} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="td-gap">
        <h2 className="td-h2">Where the gap is</h2>
        <p><Text value={r.market_gap} /></p>
      </section>

      <section>
        <SectionHead title="Demand evidence" score={r.scorecard.demand_evidence} />
        <div className="td-demand">
          {r.demand_evidence.map((d, i) => (
            <article key={i}>
              <div className="td-demand-top">
                <h3>{d.signal}</h3>
                <RatingBlocks rating={d.rating} />
              </div>
              <div className="td-demand-fig">
                <div className="td-demand-value">{d.value}</div>
                <div className="td-demand-detail"><Cited claim={d.detail} /></div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </Sheet>
  );
}

function SizingFigure({ f, result }: { f: Figure; result?: boolean }) {
  return (
    <div>
      <div className={result ? "td-sizing-value is-result" : "td-sizing-value"}>{f.value}</div>
      <div className="td-sizing-label">{f.label}</div>
      <div className="td-sizing-note"><Text value={f.note} /></div>
    </div>
  );
}

function BusinessPage({ r }: { r: TeardownReport }) {
  const { inputs, result } = r.economics.market_size;
  // The design's column weights for three inputs; equal weights otherwise.
  const weights = inputs.length === 3 ? [1.3, 0.8, 1] : inputs.map(() => 1);
  const columns = [...weights.map((w) => `minmax(min-content, ${w}fr) 16px`), "minmax(min-content, 1.15fr)"].join(" ");
  const u = r.economics.unit;
  return (
    <Sheet n={3} report={r}>
      <TitleBlock n={3} title="Business" dek={r.page_summaries.business} />

      <section>
        <SectionHead title="Economics" score={r.scorecard.economics} />

        <h3 className="td-h3 td-sizing-h">Bottom-up market size</h3>
        <div className="td-sizing" style={{ gridTemplateColumns: columns }}>
          {inputs.map((f, i) => (
            <Fragment key={i}>
              <SizingFigure f={f} />
              {i < inputs.length - 1
                ? <div aria-label="times" className="td-op">×</div>
                : <div aria-label="equals" className="td-op">=</div>}
            </Fragment>
          ))}
          <SizingFigure f={result} result />
        </div>

        <h3 className="td-h3 td-unit-h">Unit economics, per report</h3>
        <div className="td-unit">
          {[u.price, u.cost_to_serve, u.max_cac, u.margin].map((f, i) => (
            <div key={i}>
              <div className="td-unit-label">{f.label}</div>
              <div className="td-unit-value">{f.value}</div>
              <div className="td-unit-note"><Text value={f.note} /></div>
            </div>
          ))}
        </div>
      </section>

      <section className="td-dist-section">
        <SectionHead title="Distribution" score={r.scorecard.distribution} />
        <table className="td-table td-dist">
          <thead>
            <tr><th scope="col">Channel for the first 100</th><th scope="col">Rating</th><th scope="col">Reason</th></tr>
          </thead>
          <tbody>
            {r.distribution.map((c, i) => (
              <tr key={i}>
                <th scope="row">
                  <div className="td-cell-name">{c.name}</div>
                  <div className="td-cell-sub">{c.examples}</div>
                </th>
                <td><RatingBlocks rating={c.rating} /></td>
                <td><Cited claim={c.reason} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Sheet>
  );
}

function NextStepsPage({ r }: { r: TeardownReport }) {
  return (
    <Sheet n={4} report={r}>
      <TitleBlock n={4} title="Next steps" dek={r.page_summaries.next_steps} />

      <section>
        <SectionHead title="Blockers" score={r.scorecard.blockers} />
        <table className="td-table td-block-t">
          <thead>
            <tr><th scope="col">Type</th><th scope="col">Risk and severity</th><th scope="col">Detail</th></tr>
          </thead>
          <tbody>
            {r.blockers.length === 0 && (
              <tr><td colSpan={3} className="td-empty">No legal, technical or platform blockers found.</td></tr>
            )}
            {r.blockers.map((b, i) => (
              <tr key={i}>
                <th scope="row">{b.type}</th>
                <td>
                  <div className={`td-sev is-${b.severity}`}>
                    <span aria-hidden="true" className="td-sev-dot" />
                    <div>
                      <div className="td-sev-risk">{b.risk}</div>
                      <div className="td-sev-label">{b.severity} severity</div>
                    </div>
                  </div>
                </td>
                <td><Cited claim={b.detail} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="td-rule">
        <h2 className="td-h2">Assumptions that must be true</h2>
        <ol className="td-assume">
          {r.riskiest_assumptions.map((a, i) => (
            <li key={i}>
              <div aria-hidden="true" className="td-badge">{i + 1}</div>
              <div>
                <div className="td-assume-text">{a.statement}</div>
                <div className="td-assume-if">{a.if_false}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="td-rule">
        <div className="td-sechead is-plain">
          <h2 className="td-h2">Test plan</h2>
          <div className="td-aside">Run in this order. Stop at the first test that hits its kill threshold.</div>
        </div>
        <table className="td-table td-tests">
          <thead>
            <tr><th scope="col">Test</th><th scope="col">What it proves</th><th scope="col">Cost</th><th scope="col">Time</th><th scope="col">Kill threshold</th></tr>
          </thead>
          <tbody>
            {r.next_tests.map((t, i) => (
              <tr key={i}>
                <th scope="row"><strong>{t.name}</strong>{` ${t.description}`}</th>
                <td>
                  <div className="td-proves">
                    <span aria-label={`Assumption ${t.assumption}`} className="td-badge-sm">{t.assumption}</span>
                    <span>{t.proves}</span>
                  </div>
                </td>
                <td>{t.cost}</td>
                <td>{t.time}</td>
                <td>{t.kill_threshold}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="td-disclaimer">This report is desk research. It is not a substitute for talking to customers.</p>
    </Sheet>
  );
}

function SourcesPage({ r }: { r: TeardownReport }) {
  const numbered = r.sources.map((s, i) => ({ ...s, n: i + 1 }));
  const found = numbered.filter((s) => s.basis === "found");
  const estimated = numbered.filter((s) => s.basis === "estimated");
  const entries = (list: typeof numbered) => (list.length === 1 ? `Entry ${list[0].n}` : `Entries ${ranges(list.map((s) => s.n))}`);
  const dek = [
    "Every tagged figure in this report points to an entry here.",
    found.length > 0 && `${entries(found)} ${found.length === 1 ? "was" : "were"} found.`,
    estimated.length > 0 && `${entries(estimated)} ${estimated.length === 1 ? "is our own estimate" : "are our own estimates"}, with the method stated.`,
  ].filter(Boolean).join(" ");

  const item = (s: (typeof numbered)[number]) => (
    <li key={s.n}>
      <span className={s.basis === "found" ? "td-src-n" : "td-src-n is-est"}>{s.n}</span>
      <span>{s.url ? <a href={s.url} rel="noreferrer">{s.text}</a> : s.text}</span>
    </li>
  );

  return (
    <Sheet n={5} report={r} footnote="Numbers refer to the sources above.">
      <TitleBlock n={5} title="Sources" dek={dek} />

      {found.length > 0 && (
        <section className="td-rule">
          <div className="td-src-head">
            <h2 className="td-h2">Sourced</h2>
            <span className="td-found">FOUND</span>
            <div className="td-aside">Web sources retrieved {formatDate(r.sources_retrieved)}.</div>
          </div>
          <ol className="td-src">{found.map(item)}</ol>
        </section>
      )}

      {estimated.length > 0 && (
        <section className="td-rule">
          <div className="td-src-head">
            <h2 className="td-h2">Estimated</h2>
            <span className="td-est-key">est.</span>
            <div className="td-aside">Our own calculation or inference.</div>
          </div>
          <ol className="td-src">{estimated.map(item)}</ol>
        </section>
      )}
    </Sheet>
  );
}

export default function Report({ report, label }: { report: TeardownReport; label?: string }) {
  return (
    <div className="td-doc">
      <VerdictPage r={report} label={label} />
      <MarketPage r={report} />
      <BusinessPage r={report} />
      <NextStepsPage r={report} />
      <SourcesPage r={report} />
    </div>
  );
}
