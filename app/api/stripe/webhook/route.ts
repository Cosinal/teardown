import { after } from "next/server";
import { init } from "@/lib/db";
import { startRun } from "@/lib/engine/run";
import { markPaid } from "@/lib/payments";
import { verifyEvent } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The engine runs after the response (startRun via after()), within this limit. 300 s is the Vercel Hobby cap.
export const maxDuration = 300;

// POST /api/stripe/webhook  Stripe's signed events. On checkout.session.completed
// the paid teardown is queued and its run started. Idempotent: Stripe retries
// and replays, and only the event that moves the row out of awaiting_payment starts a run.
export async function POST(req: Request) {
  let event;
  try {
    event = verifyEvent(await req.text(), req.headers.get("stripe-signature"));
  } catch (err) {
    console.error("Stripe webhook rejected", err instanceof Error ? err.message : err);
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }
  if (event.type !== "checkout.session.completed") return Response.json({ received: true });

  const session = event.data.object;
  const id = session.metadata?.teardown_id;
  const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (!id || id !== session.client_reference_id || !paymentIntent || session.payment_status !== "paid") {
    console.error(`Stripe webhook: ignoring session ${session.id} (teardown ${id ?? "none"}, ${session.payment_status})`);
    return Response.json({ received: true });
  }

  await init();
  // Throws (500, so Stripe retries) if the database or a stray-payment refund fails.
  if (await markPaid(id, paymentIntent)) after(() => startRun(id));
  return Response.json({ received: true });
}
