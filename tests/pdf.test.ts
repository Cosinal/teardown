import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Report from "@/components/Report";
import { Cooking, Private } from "@/components/Waiting";
import { SAMPLE_REPORT } from "@/lib/engine/fixtures/sample";
import { adminCookieValue } from "@/lib/admin";
import { newOwnerToken, ownerCookie } from "@/lib/payments";
import { DESIGN_ERROR, DESIGN_WAITING } from "@/lib/waiting";

vi.mock("@/app/t/[id]/actions", () => ({
  rerunTeardown: async () => {},
  resumeCheckout: async () => {},
}));

const htmlToPdf = vi.hoisted(() => vi.fn(async () => new Uint8Array(Buffer.from("%PDF-1.4 mock"))));

vi.mock("@/lib/pdf", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/pdf")>();
  return { ...orig, htmlToPdf };
});

const queries: { text: string; values: unknown[] }[] = [];
let respond: (text: string, values: unknown[]) => unknown[] = () => [];

vi.mock("@/lib/db", () => ({
  init: async () => {},
  sql: () => {
    const q = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("$").replace(/\s+/g, " ").trim();
      queries.push({ text, values });
      return Promise.resolve().then(() => respond(text, values));
    };
    return q;
  },
}));

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
  }),
}));

const { GET, maxDuration } = await import("@/app/t/[id]/pdf/route");
const { pdfFilename, reportHtml } = await import("@/lib/pdf");

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

function pdfReq(id: string) {
  return GET(new Request(`https://teardown.test/t/${id}/pdf`), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  queries.length = 0;
  respond = () => [];
  jar.clear();
  htmlToPdf.mockClear();
  htmlToPdf.mockResolvedValue(new Uint8Array(Buffer.from("%PDF-1.4 mock")));
  vi.unstubAllEnvs();
  vi.stubEnv("ADMIN_KEY", "s3cret");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("pdfFilename", () => {
  it("slugs the idea name", () => {
    expect(pdfFilename("Single-payment business idea teardowns")).toBe(
      "tearitdown-single-payment-business-idea-teardowns.pdf",
    );
    expect(pdfFilename("Café Report #3")).toBe("tearitdown-cafe-report-3.pdf");
    expect(pdfFilename("")).toBe("tearitdown-report.pdf");
  });
});

describe("report HTML for Chromium", () => {
  it("is five letter sheets with IBM Plex, no download chrome", async () => {
    const doc = await reportHtml(SAMPLE_REPORT, "Sample report");
    expect(doc.match(/class="td-sheet"/g)?.length).toBe(5);
    expect(doc).toContain("IBM Plex");
    expect(doc).toContain("@page{size:letter;margin:0}");
    expect(doc).toContain("data:font/woff2;base64,");
    expect(doc).toContain("Sample report");
    expect(doc).toContain(SAMPLE_REPORT.idea.headline);
    expect(doc).not.toContain("Download PDF");
    expect(doc.toLowerCase()).not.toMatch(/\bis live\b/);
  });
});

describe("Download PDF button", () => {
  it("is on a finished report that has a pdf href, not on waiting or private", () => {
    const done = html(createElement(Report, { report: SAMPLE_REPORT, pdfHref: "/t/sample/pdf" }));
    expect(done).toContain("Download PDF");
    expect(done).toContain('href="/t/sample/pdf"');
    expect(done).toContain('class="td-toolbar"');
    expect(done).toMatch(/<a class="td-btn" href="\/t\/sample\/pdf">Download PDF<\/a>/);

    expect(html(createElement(Report, { report: SAMPLE_REPORT }))).not.toContain("Download PDF");
    expect(html(createElement(Cooking, { id: "abc", t: DESIGN_WAITING }))).not.toContain("Download PDF");
    expect(html(createElement(Cooking, { id: "abc", t: DESIGN_ERROR, admin: { error: DESIGN_ERROR.error } }))).not.toContain("Download PDF");
    expect(html(createElement(Private))).not.toContain("Download PDF");
  });
});

describe("GET /t/[id]/pdf", () => {
  it("allows 60s for Chromium", () => {
    expect(maxDuration).toBe(60);
  });

  it("serves the sample without cookies or the database", async () => {
    const res = await pdfReq("sample");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${pdfFilename(SAMPLE_REPORT.idea.name)}"`,
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toContain("%PDF");
    expect(htmlToPdf).toHaveBeenCalledOnce();
    expect(queries).toEqual([]);
  });

  it("404s the waiting and error fixtures and does not render", async () => {
    expect((await pdfReq("sample-waiting")).status).toBe(404);
    expect((await pdfReq("sample-error")).status).toBe(404);
    expect(htmlToPdf).not.toHaveBeenCalled();
  });

  it("404s an unknown id", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://mock");
    expect((await pdfReq("nope")).status).toBe(404);
    expect(htmlToPdf).not.toHaveBeenCalled();
  });

  describe("a stored teardown", () => {
    const owner = newOwnerToken();
    const withRow = (row: Record<string, unknown>) => {
      respond = (t) =>
        t.startsWith("SELECT status, idea, report")
          ? [{ status: "done", idea: "Van", error: null, payment_intent: "pi_1", refunded_at: null, owner_token_hash: owner.hash, ...row }]
          : [];
    };

    beforeEach(() => vi.stubEnv("DATABASE_URL", "postgres://mock"));

    it("serves the PDF to the owner cookie", async () => {
      withRow({ report: SAMPLE_REPORT });
      jar.set(ownerCookie("abc"), owner.token);
      const res = await pdfReq("abc");
      expect(res.status).toBe(200);
      expect(htmlToPdf).toHaveBeenCalledOnce();
    });

    it("serves the PDF to the admin cookie", async () => {
      withRow({ report: SAMPLE_REPORT });
      jar.set("td_admin", adminCookieValue());
      expect((await pdfReq("abc")).status).toBe(200);
    });

    it.each([
      ["no cookie", () => {}],
      ["another teardown's owner cookie", () => jar.set(ownerCookie("other"), owner.token)],
      ["a wrong token", () => jar.set(ownerCookie("abc"), newOwnerToken().token)],
      ["a forged admin cookie", () => jar.set("td_admin", "s3cret")],
    ])("404s a stranger with %s and does not render", async (_, setup) => {
      withRow({ report: SAMPLE_REPORT });
      setup();
      expect((await pdfReq("abc")).status).toBe(404);
      expect(htmlToPdf).not.toHaveBeenCalled();
    });

    it("404s while the run has no report, even for the owner", async () => {
      withRow({ report: null, status: "writing" });
      jar.set(ownerCookie("abc"), owner.token);
      expect((await pdfReq("abc")).status).toBe(404);
      expect(htmlToPdf).not.toHaveBeenCalled();
    });
  });
});
