import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_REPORT } from "../lib/engine/fixtures/sample";

// Payments: checkout on submit, the Stripe webhook, refunds and who can see a
// teardown. No database, no Stripe and no model calls: `sql`, runPipeline,
// Next's request APIs and the Stripe client's network methods are mocked.
// Webhook signatures are real: signed and checked with the SDK's own helpers.

/** Every statement sent to the mocked database, whitespace collapsed, with its values. */
const queries: { text: string; values: unknown[] }[] = [];
/** What the mocked database returns for a statement, by its text and values. */
let respond: (text: string, values: unknown[]) => unknown[] = () => [];

vi.mock("@/lib/db", () => ({
  init: async () => {},
  sql: () => {
    const q = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("$").replace(/\s+/g, " ").trim();
      queries.push({ text, values });
      // Async like the real driver, so concurrent callers interleave.
      return Promise.resolve().then(() => respond(text, values));
    };
    q.transaction = async (list: Promise<unknown>[]) => Promise.all(list);
    return q;
  },
}));

const runPipeline = vi.fn();
vi.mock("../lib/engine/pipeline", () => ({ runPipeline: (...args: unknown[]) => runPipeline(...args) }));

const after = vi.fn();
vi.mock("next/server", () => ({ after: (fn: () => unknown) => after(fn) }));
/** The browser's cookies, by name. */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
  headers: async () => new Headers({ origin: "https://teardown.test" }),
}));
class Redirect extends Error {}
class NotFound extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Redirect(url); },
  notFound: () => { throw new NotFound(); },
}));

vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_mock");
const { stripe } = await import("../lib/stripe");
const { default: Stripe } = await import("stripe");
const { POST: webhook, maxDuration } = await import("../app/api/stripe/webhook/route");
const { refundIfPaid, newOwnerToken, ownerCookie } = await import("../lib/payments");
const { startRun } = await import("../lib/engine/run");
const { submitIdea } = await import("../app/new/actions");
const { rerunTeardown } = await import("../app/t/[id]/actions");
const { adminCookieValue } = await import("../lib/admin");
const { default: TeardownPage } = await import("../app/t/[id]/page");

const refunds = vi.spyOn(stripe().refunds, "create");
const sessions = vi.spyOn(stripe().checkout.sessions, "create");

const SECRET = "whsec_test_secret";
const INPUT = { idea: "A mobile dog grooming van.", target_customer: "Dog owners", price: "$80", billing: "one_time", geography: "Halifax" };

const paidSql = (t: string) => t.startsWith("UPDATE teardowns SET status = 'queued', payment_intent = $");
const refundClaimSql = (t: string) => t.startsWith("UPDATE teardowns SET refunded_at = now()");
const claimSql = (t: string) => t.startsWith("UPDATE teardowns SET status = 'intake'");

function completed(id: string, pi = "pi_1", extra: Record<string, unknown> = {}) {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type: "checkout.session.completed",
    data: { object: { id: "cs_test_1", object: "checkout.session", client_reference_id: id, metadata: { teardown_id: id },
      payment_intent: pi, payment_status: "paid", ...extra } },
  };
}

function deliver(event: object, { secret = SECRET, signature }: { secret?: string; signature?: string | null } = {}) {
  const payload = JSON.stringify(event);
  const header = signature === undefined ? stripe().webhooks.generateTestHeaderString({ payload, secret }) : signature;
  const headers = new Headers(header === null ? {} : { "stripe-signature": header });
  return webhook(new Request("https://teardown.test/api/stripe/webhook", { method: "POST", body: payload, headers }));
}

/** A tiny in-memory teardown row behind the mocked database, for the stateful tests. */
function rowDb(row: { status: string; payment_intent?: string | null; refunded_at?: string | null }) {
  const r = { payment_intent: null, refunded_at: null, ...row } as { status: string; payment_intent: string | null; refunded_at: string | null };
  respond = (t, v) => {
    if (paidSql(t)) {
      if (r.status !== "awaiting_payment") return [];
      r.status = "queued";
      r.payment_intent = v[0] as string;
      return [{ id: v[1] }];
    }
    if (t.startsWith("SELECT payment_intent")) return [{ payment_intent: r.payment_intent }];
    if (claimSql(t)) {
      if (r.status !== "queued") return [];
      r.status = "intake";
      return [{ id: v[0], input: INPUT }];
    }
    if (t.startsWith("SELECT status FROM")) return [{ status: r.status }];
    if (t.startsWith("UPDATE teardowns SET status = $, error = $")) r.status = v[0] as string;
    if (refundClaimSql(t)) {
      if (r.status !== "failed" || !r.payment_intent || r.refunded_at) return [];
      r.refunded_at = "now";
      return [{ payment_intent: r.payment_intent }];
    }
    if (t.startsWith("UPDATE teardowns SET refunded_at = NULL")) r.refunded_at = null;
    if (t.startsWith("UPDATE teardowns SET status = 'queued', error = NULL")) {
      if (r.status !== "failed") return [];
      r.status = "queued";
      return [{ id: v[0] }];
    }
    return [];
  };
  return r;
}

beforeEach(() => {
  queries.length = 0;
  respond = () => [];
  runPipeline.mockReset();
  after.mockReset();
  refunds.mockReset().mockResolvedValue({ id: "re_1" } as never);
  sessions.mockReset().mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" } as never);
  jar.clear();
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_mock");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("STRIPE_PRICE_ID", "price_test_1");
  vi.stubEnv("ADMIN_KEY", "s3cret");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("webhook", () => {
  it("allows the engine its full run after the response", () => {
    expect(maxDuration).toBe(300);
  });

  it.each([
    ["a wrong secret", { secret: "whsec_other" }],
    ["no signature", { signature: null }],
    ["a forged signature", { signature: "t=1,v1=deadbeef" }],
  ])("rejects an event with %s and touches nothing", async (_, opts) => {
    const res = await deliver(completed("abc"), opts);
    expect(res.status).toBe(400);
    expect(queries).toEqual([]);
    expect(after).not.toHaveBeenCalled();
  });

  it("rejects a signed body that was tampered with", async () => {
    const payload = JSON.stringify(completed("abc"));
    const header = stripe().webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const res = await webhook(new Request("https://x/", { method: "POST", body: payload.replace("abc", "xyz"), headers: { "stripe-signature": header } }));
    expect(res.status).toBe(400);
    expect(queries).toEqual([]);
  });

  it("saves the payment intent and queues the row in one atomic statement, then starts the run after the response", async () => {
    respond = (t) => (paidSql(t) ? [{ id: "abc" }] : []);
    const res = await deliver(completed("abc", "pi_1"));
    expect(res.status).toBe(200);
    expect(queries[0].text).toBe(
      "UPDATE teardowns SET status = 'queued', payment_intent = $, updated_at = now() WHERE id = $ AND status = 'awaiting_payment' RETURNING id",
    );
    expect(queries[0].values).toEqual(["pi_1", "abc"]);
    expect(after).toHaveBeenCalledOnce();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("a duplicate or replayed event does nothing", async () => {
    const row = rowDb({ status: "awaiting_payment" });
    const event = completed("abc", "pi_1");
    await deliver(event);
    const res = await deliver(event);
    // Stripe sends a retry as a new delivery of the same event; a replay can also be a new event id.
    await deliver({ ...event, id: "evt_other" });
    expect(res.status).toBe(200);
    expect(after).toHaveBeenCalledOnce();
    expect(refunds).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: "queued", payment_intent: "pi_1" });
  });

  it("concurrent deliveries race for the claim: exactly one run starts", async () => {
    rowDb({ status: "awaiting_payment" });
    const event = completed("abc", "pi_1");
    const res = await Promise.all([deliver(event), deliver(event), deliver(event)]);
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(after).toHaveBeenCalledOnce();

    // And the started run claims the row once, even if startRun is called again.
    runPipeline.mockResolvedValue({ ok: true });
    await Promise.all([after.mock.calls[0][0](), startRun("abc")]);
    expect(runPipeline).toHaveBeenCalledOnce();
  });

  it("refunds a second payment for a row that's already paid (two checkout tabs)", async () => {
    rowDb({ status: "awaiting_payment" });
    await deliver(completed("abc", "pi_1"));
    await deliver(completed("abc", "pi_2"));
    expect(after).toHaveBeenCalledOnce();
    expect(refunds).toHaveBeenCalledOnce();
    expect(refunds).toHaveBeenCalledWith({ payment_intent: "pi_2" });
  });

  it("returns 500 if refunding a stray payment fails, so Stripe retries", async () => {
    rowDb({ status: "queued", payment_intent: "pi_1" });
    refunds.mockRejectedValue(new Error("stripe down"));
    await expect(deliver(completed("abc", "pi_2"))).rejects.toThrow("stripe down");
  });

  it.each([
    ["unpaid", { payment_status: "unpaid" }],
    ["mismatched ids", { client_reference_id: "other" }],
  ])("ignores a session that's %s", async (_, extra) => {
    const res = await deliver(completed("abc", "pi_1", extra));
    expect(res.status).toBe(200);
    expect(queries).toEqual([]);
    expect(after).not.toHaveBeenCalled();
  });

  it("acknowledges other event types without acting", async () => {
    const res = await deliver({ ...completed("abc"), type: "payment_intent.created" });
    expect(res.status).toBe(200);
    expect(queries).toEqual([]);
  });
});

describe("refunds", () => {
  it("a paid run that fails is refunded in full, exactly once", async () => {
    const row = rowDb({ status: "queued", payment_intent: "pi_1" });
    runPipeline.mockRejectedValue(new Error("search timed out"));
    await startRun("abc");
    expect(row).toMatchObject({ status: "failed", refunded_at: "now" });
    expect(refunds).toHaveBeenCalledOnce();
    expect(refunds).toHaveBeenCalledWith({ payment_intent: "pi_1" });

    // Later calls (page loads, a racing caller) find refunded_at set.
    expect(await Promise.all([refundIfPaid("abc"), refundIfPaid("abc")])).toEqual([false, false]);
    expect(refunds).toHaveBeenCalledOnce();
  });

  it("concurrent callers refund once", async () => {
    rowDb({ status: "failed", payment_intent: "pi_1" });
    expect((await Promise.all([refundIfPaid("abc"), refundIfPaid("abc"), refundIfPaid("abc")])).filter(Boolean)).toHaveLength(1);
    expect(refunds).toHaveBeenCalledOnce();
  });

  it("the claim only matches a failed, paid, unrefunded row", async () => {
    await refundIfPaid("abc");
    expect(queries[0].text).toBe(
      "UPDATE teardowns SET refunded_at = now() WHERE id = $ AND status = 'failed' AND payment_intent IS NOT NULL AND refunded_at IS NULL RETURNING payment_intent",
    );
    expect(refunds).not.toHaveBeenCalled();
  });

  it("an unpaid (admin) run that fails is not refunded", async () => {
    rowDb({ status: "queued" });
    runPipeline.mockRejectedValue(new Error("boom"));
    await startRun("abc");
    expect(refunds).not.toHaveBeenCalled();
  });

  it("a Stripe error releases the claim so a later call retries; startRun still doesn't throw", async () => {
    const row = rowDb({ status: "queued", payment_intent: "pi_1" });
    runPipeline.mockRejectedValue(new Error("boom"));
    refunds.mockRejectedValueOnce(new Error("stripe down"));
    await expect(startRun("abc")).resolves.toBeUndefined();
    expect(row.refunded_at).toBeNull();
    expect(await refundIfPaid("abc")).toBe(true);
    expect(refunds).toHaveBeenCalledTimes(2);
    expect(row.refunded_at).toBe("now");
  });

  it("a payment Stripe already refunded counts as refunded", async () => {
    const row = rowDb({ status: "failed", payment_intent: "pi_1" });
    refunds.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", code: "charge_already_refunded" }));
    expect(await refundIfPaid("abc")).toBe(true);
    expect(row.refunded_at).toBe("now");
  });

  it("the stale sweep's failure is refunded on the page load", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://mock");
    let status = "factcheck";
    let refunded: string | null = null;
    respond = (t) => {
      if (t.startsWith("SELECT status, idea, report")) return [{ status, idea: "Van", report: null, error: null, payment_intent: "pi_1", refunded_at: refunded, owner_token_hash: null }];
      if (t.startsWith("UPDATE teardowns SET status = 'failed'")) { status = "failed"; return [{ id: "abc" }]; }
      if (refundClaimSql(t) && status === "failed" && !refunded) { refunded = "now"; return [{ payment_intent: "pi_1" }]; }
      return [];
    };
    jar.set("td_admin", adminCookieValue());
    const el = (await TeardownPage({ params: Promise.resolve({ id: "abc" }) })) as { props: { t: { status: string; refunded: boolean } } };
    expect(el.props.t).toMatchObject({ status: "failed", refunded: true });
    expect(refunds).toHaveBeenCalledOnce();
  });

  it("admin re-run of a paid row doesn't charge again, and a second failure doesn't refund twice", async () => {
    const row = rowDb({ status: "failed", payment_intent: "pi_1", refunded_at: "now" });
    jar.set("td_admin", adminCookieValue());
    await expect(rerunTeardown("abc")).rejects.toBeInstanceOf(Redirect);
    expect(row.status).toBe("queued");
    runPipeline.mockRejectedValue(new Error("boom again"));
    await after.mock.calls[0][0]();
    expect(row.status).toBe("failed");
    expect(sessions).not.toHaveBeenCalled();
    expect(refunds).not.toHaveBeenCalled();
  });
});

describe("who can see a teardown", () => {
  beforeEach(() => vi.stubEnv("DATABASE_URL", "postgres://mock"));
  const owner = newOwnerToken();
  const withRow = (row: Record<string, unknown>) => {
    respond = (t) => (t.startsWith("SELECT status, idea, report") ? [{ status: "done", idea: "Van", error: null, payment_intent: "pi_1", refunded_at: null, owner_token_hash: owner.hash, ...row }] : []);
  };
  const render = async (id = "abc") => {
    const el = (await TeardownPage({ params: Promise.resolve({ id }) })) as { type: { name: string }; props: Record<string, unknown> };
    return { name: el.type.name, props: el.props };
  };

  it("the owner cookie sees the report", async () => {
    withRow({ report: SAMPLE_REPORT });
    jar.set(ownerCookie("abc"), owner.token);
    const el = await render();
    expect(el.name).toBe("Report");
    expect(el.props.report).toEqual(SAMPLE_REPORT);
  });

  it("the admin cookie sees the report", async () => {
    withRow({ report: SAMPLE_REPORT });
    jar.set("td_admin", adminCookieValue());
    expect((await render()).name).toBe("Report");
  });

  it.each([
    ["no cookie", () => {}],
    ["another teardown's owner cookie", () => jar.set(ownerCookie("other"), owner.token)],
    ["a wrong token", () => jar.set(ownerCookie("abc"), newOwnerToken().token)],
    ["the hash itself as the token", () => jar.set(ownerCookie("abc"), owner.hash)],
  ])("a stranger with %s gets the private page, with no row data", async (_, setup) => {
    withRow({ report: SAMPLE_REPORT });
    setup();
    const el = await render();
    expect(el.name).toBe("Private");
    expect(el.props).toEqual({});
  });

  it("a stranger can't read the idea from the page title either", async () => {
    withRow({ report: SAMPLE_REPORT });
    const { generateMetadata } = await import("../app/t/[id]/page");
    expect((await generateMetadata({ params: Promise.resolve({ id: "abc" }) })).title).toBe("Teardown");
    jar.set(ownerCookie("abc"), owner.token);
    expect((await generateMetadata({ params: Promise.resolve({ id: "abc" }) })).title).toBe(`${SAMPLE_REPORT.idea.name} — Teardown`);
  });

  it("a teardown from before payments (no owner) is admin-only", async () => {
    withRow({ report: SAMPLE_REPORT, owner_token_hash: null });
    jar.set(ownerCookie("abc"), "");
    expect((await render()).name).toBe("Private");
  });

  it("an in-progress or unpaid teardown is private too", async () => {
    withRow({ report: null, status: "awaiting_payment" });
    expect((await render()).name).toBe("Private");
    jar.set(ownerCookie("abc"), owner.token);
    const el = await render();
    expect(el.name).toBe("Cooking");
    expect(el.props.t).toMatchObject({ status: "awaiting_payment" });
  });

  it("the sample stays public", async () => {
    expect((await render("sample")).name).toBe("Report");
  });
});

describe("checkout on submit", () => {
  const form = (values: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(values)) f.set(k, v);
    return f;
  };

  it("saves the row awaiting payment, sets the owner cookie, and redirects to Stripe Checkout", async () => {
    jar.set("td_admin", adminCookieValue());
    const err = await submitIdea({ errors: {}, values: {} }, form(INPUT)).catch((e) => e);
    expect(err).toBeInstanceOf(Redirect);
    expect(err.message).toBe("https://checkout.stripe.com/c/pay/cs_test_1");

    const insert = queries.find((q) => q.text.startsWith("INSERT INTO teardowns"))!;
    expect(insert.text).toContain("'awaiting_payment'");
    const [id, , , , hash] = insert.values as string[];
    // The cookie holds the token; the row holds only its sha256.
    const token = jar.get(ownerCookie(id))!;
    expect(token).toBeTruthy();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);

    expect(sessions).toHaveBeenCalledOnce();
    expect(sessions.mock.calls[0][0]).toMatchObject({
      mode: "payment",
      line_items: [{ price: "price_test_1", quantity: 1 }],
      client_reference_id: id,
      metadata: { teardown_id: id },
      success_url: `https://teardown.test/t/${id}`,
      cancel_url: `https://teardown.test/new?draft=${id}`,
    });
    // Nothing runs until the webhook says it's paid.
    expect(after).not.toHaveBeenCalled();
    expect(queries.some((q) => q.text.startsWith("UPDATE teardowns SET status = 'queued'"))).toBe(false);
  });

  it("admin skipping payment queues the row and starts the run without Stripe", async () => {
    jar.set("td_admin", adminCookieValue());
    respond = (t) => (t.startsWith("UPDATE teardowns SET status = 'queued', updated_at") ? [{ id: "x" }] : []);
    const err = await submitIdea({ errors: {}, values: {} }, form({ ...INPUT, skip_payment: "on" })).catch((e) => e);
    expect(err.message).toMatch(/^\/t\//);
    expect(sessions).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledOnce();
  });

  it("back from a cancelled checkout, resubmitting updates that teardown instead of creating another", async () => {
    jar.set("td_admin", adminCookieValue());
    respond = (t) => {
      if (t.startsWith("SELECT owner_token_hash")) return [{ owner_token_hash: null }];
      return t.startsWith("UPDATE teardowns SET idea = $") ? [{ id: "draft1" }] : [];
    };
    const err = await submitIdea({ errors: {}, values: {} }, form({ ...INPUT, draft: "draft1" })).catch((e) => e);
    expect(err).toBeInstanceOf(Redirect);
    expect(queries.some((q) => q.text.startsWith("INSERT INTO teardowns"))).toBe(false);
    expect(sessions.mock.calls[0][0]).toMatchObject({ client_reference_id: "draft1" });
  });

  it("a Stripe error keeps the answers and the draft for another try", async () => {
    jar.set("td_admin", adminCookieValue());
    sessions.mockRejectedValue(new Error("stripe down"));
    const state = await submitIdea({ errors: {}, values: {} }, form(INPUT));
    expect(state.errors.form).toMatch(/checkout/);
    expect(state.values).toMatchObject({ ...INPUT, draft: expect.any(String) });
  });
});
