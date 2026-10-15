import { rerunTeardown, resumeCheckout } from "@/app/t/[id]/actions";
import {
  PIPELINE_STAGES,
  PRIVATE_COPY,
  autoRefresh,
  isDesignId,
  showsProgress,
  stageIndex,
  stageStates,
  waitingCopy,
  waitingKind,
  type WaitingView,
} from "@/lib/waiting";

/** Shown instead of a teardown to anyone without its owner cookie or the admin cookie. Renders no row data. */
export function Private() {
  const { eyebrow, title, dek, note, cta, href } = PRIVATE_COPY;
  return (
    <div className="td-doc">
      <div className="td-sheet is-cooking">
        <header className="td-head">
          <div className="td-brand">Tearitdown</div>
        </header>
        <main className="td-cooking">
          <div className="td-pagenum">{eyebrow}</div>
          <h1 className="td-h1">{title}</h1>
          <p className="td-dek">{dek}</p>
          <div className="td-actions">
            <a className="td-btn" href={href}>{cta}</a>
            <p className="td-note">{note}</p>
          </div>
        </main>
      </div>
    </div>
  );
}

/** `admin` is set only for the admin cookie: the saved error and a re-run button. Never shown to anyone else. */
export function Cooking({ id, t, admin }: { id: string; t: WaitingView; admin?: { error: string | null } }) {
  const { status, idea, paid, refunded } = t;
  const kind = waitingKind(status, paid, refunded);
  const { eyebrow, title, dek } = waitingCopy(kind);
  const failed = kind.startsWith("failed");
  const unpaid = kind === "unpaid";
  const running = kind === "running";
  const now = stageIndex(status);
  const states = stageStates(status);
  const done = Math.max(now, 0);
  return (
    <div className="td-doc">
      {/* Unpaid too: the webhook usually lands a moment after Stripe sends the founder back here. */}
      {autoRefresh(status) && <meta httpEquiv="refresh" content="15" />}
      <div className="td-sheet is-cooking">
        <header className="td-head">
          <div className="td-brand">Tearitdown</div>
          <div className="td-subject">{idea}</div>
        </header>
        <main className="td-cooking" aria-live="polite" aria-busy={running}>
          <div className="td-pagenum">{eyebrow}</div>
          <h1 className="td-h1">{title}</h1>
          <p className="td-dek">{dek}</p>
          {running && <div className="td-eta">About 2–5 minutes</div>}
          {unpaid && (
            <form action={isDesignId(id) ? undefined : resumeCheckout.bind(null, id)} className="td-actions">
              <button type="submit" className="td-btn">Not paid yet? Go to checkout</button>
            </form>
          )}
          {failed && admin && (
            <form action={isDesignId(id) ? undefined : rerunTeardown.bind(null, id)} className="td-admin">
              <pre className="td-mono">{admin.error ?? "No error saved."}</pre>
              <button type="submit" className="td-btn">Re-run from saved answers</button>
            </form>
          )}
          {failed && !admin && kind === "failed" && (
            <div className="td-actions">
              <a className="td-btn" href={PRIVATE_COPY.href}>{PRIVATE_COPY.cta}</a>
            </div>
          )}
          {showsProgress(status) && (
            <div className="td-progress">
              <div className="td-progress-meta">
                <span>Stage {now + 1} of {PIPELINE_STAGES.length}</span>
                <span>{PIPELINE_STAGES[now].label}</span>
              </div>
              <div
                className="td-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={PIPELINE_STAGES.length}
                aria-valuenow={done}
                aria-label="Build progress"
              >
                <div className="td-track-fill" style={{ width: `${(done / PIPELINE_STAGES.length) * 100}%` }} />
              </div>
              <ol className="td-steps">
                {PIPELINE_STAGES.map((stage, i) => {
                  const state = states[i];
                  return (
                    <li key={stage.id} className={state === "todo" ? undefined : `is-${state}`} aria-current={state === "now" ? "step" : undefined}>
                      <span className="td-step-mark" aria-hidden>{state === "done" ? "✓" : i + 1}</span>
                      <div>
                        <div className="td-step-label">{stage.label}</div>
                        <div className="td-step-detail">{stage.detail}</div>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <p className="td-refresh">This page refreshes every 15 seconds.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
