import { AlreadyClaimedError, runStages } from "./store";

// Server-only: it runs the billable engine. (No `server-only` import: it isn't installed, and tests and scripts load this.)

/**
 * The one app entry point that runs the engine for a queued teardown. Admin
 * submit and admin re-run call it today; the Stripe webhook will call it once
 * payment exists. Never throws: a failed run is marked failed on its row and logged here.
 */
export async function startRun(id: string): Promise<void> {
  try {
    await runStages(id);
  } catch (err) {
    // Another caller is already running it: nothing to do.
    if (err instanceof AlreadyClaimedError) return;
    console.error(`Teardown ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
