import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZERO_USAGE, currentBudget, type StageRun } from "../lib/engine/llm";
import { WriterError } from "../lib/engine/sections/common";

// Running a teardown from the app: the atomic claim, startRun, and the admin
// submit and re-run actions. No database and no model calls: `sql`,
// runPipeline and Next's request APIs are mocked.

/** Every statement sent to the mocked database, whitespace collapsed, with its values. */
const queries: { text: string; values: unknown[] }[] = [];
/** What the mocked database returns for a statement, by its text. */
let respond: (text: string) => unknown[] = () => [];

vi.mock("@/lib/db", () => ({
  init: async () => {},
  sql: () => {
    const q = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("$").replace(/\s+/g, " ").trim();
      queries.push({ text, values });
      return Promise.resolve(respond(text));
    };
    q.transaction = async (list: Promise<unknown>[]) => Promise.all(list);
    return q;
  },
}));

const runPipeline = vi.fn();
vi.mock("../lib/engine/pipeline", () => ({ runPipeline: (...args: unknown[]) => runPipeline(...args) }));

const refundPayment = vi.fn();
vi.mock("@/lib/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stripe")>()),
  refundPayment: (...args: unknown[]) => refundPayment(...args),
}));

const after = vi.fn();
vi.mock("next/server", () => ({ after: (fn: () => unknown) => after(fn) }));
/** The admin cookie's value; other cookies are ignored here (see tests/payments.test.ts). */
const cookie = { value: undefined as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "td_admin" && cookie.value !== undefined ? { value: cookie.value } : undefined),
    set: () => {},
  }),
  headers: async () => new Headers({ origin: "https://teardown.test" }),
}));
class Redirect extends Error {}
class NotFound extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Redirect(url); },
  notFound: () => { throw new NotFound(); },
}));

const INPUT = { idea: "A mobile dog grooming van.", target_customer: "Dog owners", price: "$80", billing: "one_time", geography: "Halifax" };
const RUN: StageRun = {
  stage: "idea", step: "write", prompt_version: "v1", model: "claude-sonnet-5-5", usage: ZERO_USAGE, cost_usd: 0.0421,
  started_at: "2026-10-14T00:00:00.000Z", duration_ms: 1000,
};

const { runStages, AlreadyClaimedError, failStaleRun, STALE_RUN_ERROR } = await import("../lib/engine/store");
const { startRun } = await import("../lib/engine/run");
const { submitIdea } = await import("../app/new/actions");
const { rerunTeardown } = await import("../app/t/[id]/actions");
const { adminCookieValue } = await import("../lib/admin");
const { default: TeardownPage } = await import("../app/t/[id]/page");

const claimSql = (t: string) => t.startsWith("UPDATE teardowns SET status = 'intake'");
const failedSql = (t: string) => t.startsWith("UPDATE teardowns SET status = $, error = $");

beforeEach(() => {
  queries.length = 0;
  respond = () => [];
  runPipeline.mockReset();
  refundPayment.mockReset();
  after.mockReset();
  cookie.value = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runStages claim", () => {
  it("claims a queued row atomically and runs it with the saved input", async () => {
    respond = (t) => (claimSql(t) ? [{ id: "abc", input: INPUT }] : []);
    runPipeline.mockResolvedValue({ ok: true });
    await runStages("abc");
    expect(queries[0].text).toBe("UPDATE teardowns SET status = 'intake', updated_at = now() WHERE id = $ AND status = 'queued' RETURNING id, input");
    expect(queries[0].values).toEqual(["abc"]);
    expect(runPipeline).toHaveBeenCalledOnce();
    expect(runPipeline.mock.calls[0][0]).toEqual(INPUT);
  });

  it("throws not found for an unknown id", async () => {
    await expect(runStages("nope")).rejects.toThrow("Teardown nope not found");
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("a caller that loses the claim neither runs nor marks the row failed", async () => {
    respond = (t) => (t.startsWith("SELECT status") ? [{ status: "research" }] : []);
    await expect(runStages("abc")).rejects.toBeInstanceOf(AlreadyClaimedError);
    expect(runPipeline).not.toHaveBeenCalled();
    expect(queries.map((q) => q.text).filter((t) => t.includes("error ="))).toEqual([]);
  });

  it("records a WriterError's spend before marking the row failed", async () => {
    respond = (t) => (claimSql(t) ? [{ id: "abc", input: INPUT }] : []);
    runPipeline.mockRejectedValue(new WriterError("idea: writer output invalid: too long", RUN));
    await expect(runStages("abc")).rejects.toBeInstanceOf(WriterError);
    const texts = queries.map((q) => q.text);
    const record = texts.findIndex((t) => t.includes("stage_runs = stage_runs ||"));
    const failed = texts.findIndex((t) => failedSql(t));
    expect(record).toBeGreaterThan(0);
    expect(failed).toBeGreaterThan(record);
    expect(queries[record].values).toEqual([JSON.stringify([RUN]), 0.0421, "abc"]);
    expect(queries[failed].values).toEqual(["failed", "idea: writer output invalid: too long", "abc"]);
  });

  it("still marks the row failed if recording the spend fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    respond = (t) => {
      if (t.includes("stage_runs = stage_runs ||")) throw new Error("db down");
      return claimSql(t) ? [{ id: "abc", input: INPUT }] : [];
    };
    runPipeline.mockRejectedValue(new WriterError("idea: writer output invalid", RUN));
    await expect(runStages("abc")).rejects.toBeInstanceOf(WriterError);
    expect(queries.some((q) => failedSql(q.text) && q.values[0] === "failed")).toBe(true);
  });

  it("other errors are marked failed with no extra run", async () => {
    respond = (t) => (claimSql(t) ? [{ id: "abc", input: INPUT }] : []);
    runPipeline.mockRejectedValue(new Error("search timed out"));
    await expect(runStages("abc")).rejects.toThrow("search timed out");
    expect(queries.some((q) => q.text.includes("stage_runs = stage_runs ||"))).toBe(false);
  });
});

describe("startRun", () => {
  it("runs once; a second call on the same id does nothing", async () => {
    let status = "queued";
    respond = (t) => {
      if (claimSql(t)) {
        if (status !== "queued") return [];
        status = "intake";
        return [{ id: "abc", input: INPUT }];
      }
      return t.startsWith("SELECT status") ? [{ status }] : [];
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    runPipeline.mockResolvedValue({ ok: true });
    await startRun("abc");
    await startRun("abc");
    expect(runPipeline).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
  });

  it("logs the id and message of a failed run and doesn't throw", async () => {
    respond = (t) => (claimSql(t) ? [{ id: "abc", input: INPUT }] : []);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    runPipeline.mockRejectedValue(new Error("search timed out"));
    await expect(startRun("abc")).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith("Teardown abc failed: search timed out");
  });
});

describe("admin submit", () => {
  const form = (values: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(values)) f.set(k, v);
    return f;
  };

  it("skipping payment queues the row, schedules startRun after the response, and redirects at once", async () => {
    vi.stubEnv("ADMIN_KEY", "s3cret");
    cookie.value = adminCookieValue();
    respond = (t) => (t.startsWith("UPDATE teardowns SET status = 'queued'") ? [{ id: "x" }] : []);
    const err = await submitIdea({ errors: {}, values: {} }, form({ ...INPUT, skip_payment: "on" })).catch((e) => e);
    expect(err).toBeInstanceOf(Redirect);
    const insert = queries.find((q) => q.text.startsWith("INSERT INTO teardowns"));
    expect(insert?.text).toContain("'awaiting_payment'");
    const id = insert!.values[0];
    const queue = queries.find((q) => q.text.startsWith("UPDATE teardowns SET status = 'queued'"));
    expect(queue?.text).toContain("status = 'awaiting_payment'");
    expect(queue?.values).toEqual([id]);
    expect(err.message).toBe(`/t/${id}`);
    expect(after).toHaveBeenCalledOnce();
    // Scheduled, not run: nothing has claimed the row yet.
    expect(runPipeline).not.toHaveBeenCalled();
    expect(queries.some((q) => claimSql(q.text))).toBe(false);

    respond = (t) => (claimSql(t) ? [{ id, input: INPUT }] : []);
    runPipeline.mockResolvedValue({ ok: true });
    await after.mock.calls[0][0]();
    expect(runPipeline).toHaveBeenCalledOnce();
  });

  it("404s without the admin cookie and schedules nothing", async () => {
    vi.stubEnv("ADMIN_KEY", "s3cret");
    await expect(submitIdea({ errors: {}, values: {} }, form(INPUT))).rejects.toBeInstanceOf(NotFound);
    expect(after).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });
});

describe("admin re-run", () => {
  it("requeues only a failed row, keeps its spend, and schedules startRun", async () => {
    vi.stubEnv("ADMIN_KEY", "s3cret");
    cookie.value = adminCookieValue();
    respond = (t) => (t.startsWith("UPDATE teardowns SET status = 'queued'") ? [{ id: "abc" }] : []);
    await expect(rerunTeardown("abc")).rejects.toThrow("/t/abc");
    expect(queries[0].text).toBe("UPDATE teardowns SET status = 'queued', error = NULL, updated_at = now() WHERE id = $ AND status = 'failed' RETURNING id");
    expect(queries[0].text).not.toMatch(/stage_runs|cost_usd/);
    expect(after).toHaveBeenCalledOnce();
  });

  it("does nothing for a row that isn't failed", async () => {
    vi.stubEnv("ADMIN_KEY", "s3cret");
    cookie.value = adminCookieValue();
    await expect(rerunTeardown("abc")).rejects.toBeInstanceOf(Redirect);
    expect(after).not.toHaveBeenCalled();
  });

  it("404s without the admin cookie", async () => {
    vi.stubEnv("ADMIN_KEY", "s3cret");
    cookie.value = "forged";
    await expect(rerunTeardown("abc")).rejects.toBeInstanceOf(NotFound);
    expect(queries).toEqual([]);
    expect(after).not.toHaveBeenCalled();
  });
});

describe("stale-run sweep", () => {
  const staleSql = (t: string) => t.startsWith("UPDATE teardowns SET status = 'failed'");
  const page = async (id: string) =>
    (await TeardownPage({ params: Promise.resolve({ id }) })) as { props: { t: { status: string }; admin?: { error: string | null } } };

  it("fails an in-progress row only if the database says it's 6 minutes stale", async () => {
    respond = (t) => (staleSql(t) ? [{ id: "abc" }] : []);
    expect(await failStaleRun("abc")).toBe(true);
    expect(queries[0].text).toBe(
      "UPDATE teardowns SET status = 'failed', error = $, updated_at = now() WHERE id = $ AND status NOT IN ('awaiting_payment', 'queued', 'done', 'failed') AND updated_at < now() - interval '6 minutes' RETURNING id",
    );
    expect(queries[0].values).toEqual(["Run timed out or lost connection", "abc"]);
  });

  it("returns false when no row matched (fresh, settled or unknown)", async () => {
    expect(await failStaleRun("abc")).toBe(false);
  });

  describe("on /t/[id]", () => {
    beforeEach(() => vi.stubEnv("DATABASE_URL", "postgres://mock"));
    const row = (status: string) => (t: string) => {
      if (t.startsWith("SELECT status, idea, report, error")) return [{ status, idea: "Bike repair van", report: null, error: null, owner_token_hash: null }];
      return staleSql(t) ? [{ id: "abc" }] : [];
    };

    it("a stale in-progress run shows as failed, with the error and re-run for admins", async () => {
      vi.stubEnv("ADMIN_KEY", "s3cret");
      cookie.value = adminCookieValue();
      respond = row("factcheck");
      const el = await page("abc");
      expect(queries.some((q) => staleSql(q.text))).toBe(true);
      expect(el.props.t.status).toBe("failed");
      expect(el.props.admin?.error).toBe(STALE_RUN_ERROR);
    });

    it("sweeps a stale run even when the viewer can't see it", async () => {
      respond = row("writing");
      const el = await page("abc");
      expect(queries.some((q) => staleSql(q.text))).toBe(true);
      expect(el.props.t).toBeUndefined();
    });

    it("a fresh in-progress run keeps cooking", async () => {
      vi.stubEnv("ADMIN_KEY", "s3cret");
      cookie.value = adminCookieValue();
      respond = (t) => (staleSql(t) ? [] : row("research")(t));
      const el = await page("abc");
      expect(queries.some((q) => staleSql(q.text))).toBe(true);
      expect(el.props.t.status).toBe("research");
    });

    it.each(["awaiting_payment", "queued", "failed"])("a %s row is never swept", async (status) => {
      vi.stubEnv("ADMIN_KEY", "s3cret");
      cookie.value = adminCookieValue();
      respond = row(status);
      const el = await page("abc");
      expect(queries.some((q) => staleSql(q.text))).toBe(false);
      expect(el.props.t.status).toBe(status);
    });
  });
});

describe("a run that passes its time budget", () => {
  it("ends failed before Vercel's limit and is refunded once, also when the page loads it later", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DATABASE_URL", "postgres://mock");
    vi.stubEnv("ADMIN_KEY", "s3cret");
    cookie.value = adminCookieValue();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The row, as the database would keep it.
    const row = { status: "queued", error: null as string | null, payment_intent: "pi_1", refunded_at: null as string | null };
    respond = (t) => {
      const q = queries.at(-1)!;
      if (claimSql(t)) {
        row.status = "intake";
        return [{ id: "abc", input: INPUT }];
      }
      if (failedSql(t)) [row.status, row.error] = q.values as [string, string];
      if (t.startsWith("UPDATE teardowns SET refunded_at = now()")) {
        if (row.status !== "failed" || row.refunded_at) return [];
        row.refunded_at = "now";
        return [{ payment_intent: row.payment_intent }];
      }
      // The stale sweep only matches a row still in progress.
      if (t.startsWith("UPDATE teardowns SET status = 'failed'")) return [];
      if (t.startsWith("SELECT status, idea, report")) return [{ ...row, idea: "Bike repair van", report: null, owner_token_hash: null }];
      return [];
    };
    // A step that never returns until the run's deadline aborts it, as an API call does.
    runPipeline.mockImplementation(() => new Promise((_, reject) => {
      currentBudget()!.signal.addEventListener("abort", () => reject(new Error("Request was aborted.")));
    }));

    const t0 = Date.now();
    let ended = 0;
    const done = startRun("abc").then(() => { ended = Date.now(); });
    await vi.advanceTimersByTimeAsync(300_000);
    await done;
    vi.useRealTimers();

    expect(ended - t0).toBe(275_000);
    expect(row).toMatchObject({ status: "failed", error: "Run passed its 275 s time budget", refunded_at: "now" });
    expect(refundPayment).toHaveBeenCalledExactlyOnceWith("pi_1");
    expect(errors).toHaveBeenCalledWith("Teardown abc failed: Run passed its 275 s time budget");

    // The owner opens /t/abc: the row is already failed and refunded, so nothing is swept or refunded again.
    const el = (await TeardownPage({ params: Promise.resolve({ id: "abc" }) })) as { props: { t: { status: string; refunded: boolean } } };
    expect(el.props.t).toMatchObject({ status: "failed", refunded: true });
    expect(refundPayment).toHaveBeenCalledOnce();
  });
});
