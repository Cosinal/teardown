import Stripe from "stripe";

let client: Stripe | undefined;

// Created lazily so importing this module (e.g. during `next build`) doesn't
// require STRIPE_SECRET_KEY. Use test-mode keys (sk_test_...) outside production.
export function stripe() {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    client = new Stripe(key);
  }
  return client;
}

/** Parses a webhook body, throwing unless it carries a valid signature for STRIPE_WEBHOOK_SECRET. */
export function verifyEvent(body: string, signature: string | null): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  if (!signature) throw new Error("Missing Stripe-Signature header");
  return stripe().webhooks.constructEvent(body, signature, secret);
}

/** Opens a Checkout Session for one teardown at STRIPE_PRICE_ID. Returns its URL. */
export async function createCheckout(id: string, origin: string): Promise<string> {
  const price = process.env.STRIPE_PRICE_ID;
  if (!price) throw new Error("STRIPE_PRICE_ID is not set");
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: id,
    metadata: { teardown_id: id },
    payment_intent_data: { metadata: { teardown_id: id } },
    success_url: `${origin}/t/${id}`,
    cancel_url: `${origin}/new?draft=${id}`,
  });
  if (!session.url) throw new Error(`Checkout session ${session.id} has no URL`);
  return session.url;
}

/**
 * Refunds a payment in full. A payment that is already fully refunded counts
 * as done, so a retry after a lost response is safe.
 */
export async function refundPayment(paymentIntent: string): Promise<void> {
  try {
    await stripe().refunds.create({ payment_intent: paymentIntent });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError && err.code === "charge_already_refunded") return;
    throw err;
  }
}
