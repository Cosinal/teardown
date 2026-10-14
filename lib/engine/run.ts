import { refundIfPaid } from "@/lib/payments";
import { AlreadyClaimedError, runStages } from "./store";

// Server-only: it runs the billable engine. (No `server-only` import: it isn't installed, and tests and scripts load this.)

/**
 * The one app entry point that runs the engine for a queued teardown, called
 * by the Stripe webhook, admin submit (skipping payment) and admin re-run.
 * Never throws: a failed run is marked failed on its row, refunded if it was
 * paid for, and logged here.
 */
export async function startRun(id: string): Promise<void> {
  try {
    await runStages(id);
  } catch (err) {
    // Another caller is already running it: nothing to do.
    if (err instanceof AlreadyClaimedError) return;
    console.error(`Teardown ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    // If this fails, the next /t/<id> load retries it.
    await refundIfPaid(id).catch((e) => console.error(`Teardown ${id}: refund failed`, e));
  }
}
