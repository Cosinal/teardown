import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { sql } from "@/lib/db";
import { refundPayment } from "@/lib/stripe";

// Payment state on teardown rows: who owns a teardown, marking it paid, and refunds.

/** The owner cookie for one teardown. Its value is a random token; the row stores only its hash. */
export const ownerCookie = (id: string) => `td_own_${id}`;

export const OWNER_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  // "/" so both /t/<id> and /new?draft=<id> (the checkout cancel page) see it.
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
} as const;

/** The site's origin for Stripe's return URLs, from a server action's request. Browsers send Origin with every server action. */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  return h.get("origin") ?? `https://${h.get("host")}`;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function newOwnerToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}

/** True if the cookie's token hashes to the row's owner_token_hash. A row without one has no owner. */
export function isOwnerToken(token: string | null | undefined, hash: string | null | undefined): boolean {
  if (typeof token !== "string" || !token || typeof hash !== "string" || hash.length !== 64) return false;
  return timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(hash));
}

/**
 * Records a completed checkout. Saves the payment intent and moves the row
 * from awaiting_payment to queued in one statement, so a replayed or
 * duplicate event can't queue it twice. Returns true only for the call that
 * moved it; that caller starts the run.
 *
 * A payment that doesn't match the row's saved one (the founder paid twice
 * from two checkout tabs, or paid for a row that isn't waiting) is refunded.
 * A replay of the event that queued the row matches and does nothing.
 */
export async function markPaid(id: string, paymentIntent: string, amountCents: number | null = null): Promise<boolean> {
  const amount = Number.isInteger(amountCents) && (amountCents as number) >= 0 ? amountCents : null;
  const rows = await sql()`UPDATE teardowns SET status = 'queued', payment_intent = ${paymentIntent}, paid_at = now(), amount_cents = ${amount}, updated_at = now()
    WHERE id = ${id} AND status = 'awaiting_payment' RETURNING id`;
  if (rows.length) return true;
  const found = await sql()`SELECT payment_intent FROM teardowns WHERE id = ${id}`;
  if (found[0]?.payment_intent !== paymentIntent) {
    console.error(`Teardown ${id}: refunding payment ${paymentIntent}, the row is not awaiting payment`);
    await refundPayment(paymentIntent);
  }
  return false;
}

/**
 * Refunds a failed, paid teardown once. refunded_at is claimed in the same
 * statement that checks it, so concurrent callers can't both refund. If Stripe
 * errors, the claim is released so a later call (the next /t/<id> load) retries.
 * Returns whether this call refunded.
 */
export async function refundIfPaid(id: string): Promise<boolean> {
  const rows = await sql()`UPDATE teardowns SET refunded_at = now()
    WHERE id = ${id} AND status = 'failed' AND payment_intent IS NOT NULL AND refunded_at IS NULL
    RETURNING payment_intent`;
  if (!rows.length) return false;
  try {
    await refundPayment(rows[0].payment_intent);
    return true;
  } catch (err) {
    await sql()`UPDATE teardowns SET refunded_at = NULL WHERE id = ${id}`;
    throw err;
  }
}
