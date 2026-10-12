import { describe, expect, it, vi } from "vitest";
import { fetchPage, htmlToText, memoryPageCache, pageLoader, pageWindow, quoteInText } from "../lib/engine/fetch";

describe("htmlToText", () => {
  it("keeps the page's text and drops scripts, styles and navigation", () => {
    const html = `<html><head><title>Acme &amp; Co pricing</title><style>p{}</style></head><body>
      <nav><a>Home</a><a>Login</a></nav><script>var x = "<p>no</p>";</script>
      <h1>Pricing</h1><p>Plans start at&nbsp;$99&#47;month.</p><footer>© Acme</footer></body></html>`;
    expect(htmlToText(html)).toBe("Acme & Co pricing\nPricing\nPlans start at $99/month.");
  });

  it("keeps table rows on one line with cells separated", () => {
    const html = "<table><tr><th>Vendor</th><th>Price</th></tr><tr><td>Chronograph LP</td><td>$120K-$650K</td></tr></table>";
    expect(htmlToText(html)).toBe("| Vendor | Price\n| Chronograph LP | $120K-$650K");
  });

  it("caps the text", () => {
    expect(htmlToText(`<p>${"word ".repeat(100)}</p>`, 50)).toHaveLength(50);
  });
});

describe("quoteInText", () => {
  it("matches across case, whitespace, quote and dash styles", () => {
    expect(quoteInText("Pricing starts at roughly $120K – scaling to $650K", "pricing  starts at roughly $120K - scaling\nto $650K for mega")).toBe(true);
    expect(quoteInText("It’s the “best” tool", `It's the "best" tool here`)).toBe(true);
    expect(quoteInText("Spotlight: US $800; Industry Research Report: US $2,850", "| Spotlight | US $800 |\n| Industry Research Report | US $2,850 |")).toBe(true);
  });

  it("rejects a passage that isn't there, and quotes too short to mean anything", () => {
    expect(quoteInText("Pricing starts at $100K", "Pricing starts at $120K")).toBe(false);
    expect(quoteInText("$120K", "$120K")).toBe(false);
    expect(quoteInText("starts at $120", "Pricing starts at $1200 a year")).toBe(false);
  });
});

describe("pageWindow", () => {
  const filler = (n: number) => "Lorem ipsum dolor sit amet. ".repeat(n);
  const page = `Vendor guide\n${filler(400)}\nChronograph LP pricing starts at $120K a year.\n${filler(400)}`;

  it("returns a short page whole", () => {
    expect(pageWindow("short page", { claim: "x", excerpt: "", context: "" })).toBe("short page");
  });

  it("brings in a passage far down a long page that names the claim's figures", () => {
    const w = pageWindow(page, { claim: "$120K a year", excerpt: "", context: 'Alternatives row "Monitoring" (Chronograph LP): its price' }, 6000);
    expect(w.length).toBeLessThanOrEqual(6000);
    expect(w.startsWith("Vendor guide")).toBe(true);
    expect(w).toContain("Chronograph LP pricing starts at $120K a year.");
    expect(w).toContain("[…]");
  });
});

describe("fetchPage", () => {
  it("refuses private addresses and non-web protocols without fetching", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await fetchPage("http://127.0.0.1/admin")).toEqual({ ok: false, error: "private address" });
    expect(await fetchPage("http://169.254.169.254/latest/meta-data")).toEqual({ ok: false, error: "private address" });
    expect(await fetchPage("http://[::1]/")).toEqual({ ok: false, error: "private address" });
    expect(await fetchPage("http://localhost:3000/")).toEqual({ ok: false, error: "private host" });
    expect(await fetchPage("file:///etc/passwd")).toEqual({ ok: false, error: "unsupported protocol file:" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("re-checks the address on every redirect", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://10.0.0.5/" } }));
    expect(await fetchPage("http://93.184.215.14/")).toEqual({ ok: false, error: "private address" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("returns the readable text of an HTML page, and refuses other content types", async () => {
    const body = `<p>${"Real pricing content. ".repeat(20)}</p>`;
    const spy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }))
      .mockResolvedValueOnce(new Response("%PDF", { headers: { "content-type": "application/pdf" } }));
    expect(await fetchPage("http://93.184.215.14/a")).toEqual({ ok: true, text: "Real pricing content. ".repeat(20).trim() });
    expect(await fetchPage("http://93.184.215.14/b")).toEqual({ ok: false, error: "unsupported content type application/pdf" });
    spy.mockRestore();
  });
});

describe("pageLoader", () => {
  it("fetches a URL once, even when asked for it concurrently, and serves it from the cache after", async () => {
    const fetcher = vi.fn(async () => ({ ok: true as const, text: "page" }));
    const cache = memoryPageCache();
    const load = pageLoader(cache, fetcher);
    const [a, b] = await Promise.all([load("https://x.example"), load("https://x.example")]);
    expect(a).toEqual({ page: { ok: true, text: "page" }, cached: false });
    expect(b).toBe(a);
    expect(await pageLoader(cache, fetcher)("https://x.example")).toEqual({ page: { ok: true, text: "page" }, cached: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
