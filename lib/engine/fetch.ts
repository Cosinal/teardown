import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Server-side page fetch for fact-check: a cited page's readable text, so a
// claim can be judged against the page and not only the ~150-character quote
// web search returned. URLs come from the API's search results, never from
// model prose, but they are still fetched as untrusted: http(s) only, public
// addresses only (checked on every redirect), a byte cap and a timeout.

/** Page text sent with one claim: about 6k tokens at ~4 characters a token. */
export const PAGE_CHARS = 24_000;
/** Page text kept in the cache, so a long page's later sections can still be windowed in. */
export const STORED_CHARS = 100_000;
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;
const USER_AGENT = "Mozilla/5.0 (compatible; TeardownFactcheck/1.0; +https://teardown.ing)";

export type PageResult = { ok: true; text: string } | { ok: false; error: string };

/** Fetched pages by URL. Failures are cached too, so a page is tried once. */
export interface PageCache {
  get(url: string): Promise<PageResult | undefined>;
  set(url: string, page: PageResult): Promise<void>;
}

export function memoryPageCache(): PageCache {
  const pages = new Map<string, PageResult>();
  return {
    get: async (url) => pages.get(url),
    set: async (url, page) => void pages.set(url, page),
  };
}

function privateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

async function assertPublic(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported protocol ${url.protocol}`);
  if (url.username || url.password) throw new Error("credentials in URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("private host");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error("private address");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", euro: "€", pound: "£", copy: "©", reg: "®", trade: "™" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Readable text from HTML: drops scripts, styles, navigation and other chrome,
 * keeps block structure as line breaks and table cells as " | " so pricing
 * tables still read row by row. Capped at `max` characters.
 */
export function htmlToText(html: string, max = STORED_CHARS): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form|button|select)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<\/?(p|div|section|article|main|aside|header|h[1-6]|li|ul|ol|tr|table|thead|tbody|br|hr|dt|dd|dl|blockquote|pre|figure|figcaption)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n").map((l) => l.trim()).filter((l) => l && l !== "|").join("\n")
    .replace(/\n{3,}/g, "\n\n");
  if (title && !s.startsWith(decodeEntities(title).trim())) s = `${decodeEntities(title).trim()}\n${s}`;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.byteLength;
    if (n >= MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Fetches a page and returns its readable text, or why it couldn't. Never throws. */
export async function fetchPage(url: string): Promise<PageResult> {
  try {
    let current = new URL(url);
    for (let hop = 0; ; hop++) {
      await assertPublic(current);
      const res = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "accept-language": "en" },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop >= MAX_REDIRECTS) return { ok: false, error: "too many redirects" };
        current = new URL(res.headers.get("location")!, current);
        continue;
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const type = res.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml|text\/plain/i.test(type)) return { ok: false, error: `unsupported content type ${type.split(";")[0] || "(none)"}` };
      const body = await readCapped(res);
      const text = /text\/plain/i.test(type) ? body.replace(/\s+\n/g, "\n").slice(0, STORED_CHARS) : htmlToText(body);
      // A page this short is usually a bot wall or a script-rendered shell.
      if (text.length < 200) return { ok: false, error: "no readable text" };
      return { ok: true, text };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Loads pages through the cache. Concurrent requests for one URL share a
 * fetch, so each URL is fetched at most once; `cached` says the cache had it.
 */
export function pageLoader(cache: PageCache, fetcher: (url: string) => Promise<PageResult> = fetchPage) {
  const inflight = new Map<string, Promise<{ page: PageResult; cached: boolean }>>();
  return (url: string) => {
    let p = inflight.get(url);
    if (!p) {
      p = (async () => {
        const hit = await cache.get(url);
        if (hit) return { page: hit, cached: true };
        const page = await fetcher(url);
        await cache.set(url, page);
        return { page, cached: false };
      })();
      inflight.set(url, p);
    }
    return p;
  };
}

/**
 * Lowercased words, numbers, "$" and "%" only, single-spaced, for matching a
 * quote against page text: punctuation, quote and dash styles, table pipes
 * and line breaks differ between the page and what a model copies from it.
 */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}$%]+/gu, " ").trim();
}

/** Whether `quote` appears in `text` word for word (see normalizeForMatch). */
export function quoteInText(quote: string, text: string): boolean {
  const q = normalizeForMatch(quote);
  return q.length >= 12 && ` ${normalizeForMatch(text)} `.includes(` ${q} `);
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "their", "its", "are", "not", "but", "per", "year", "month", "still", "row", "price", "weakness", "alternatives"]);

/**
 * The parts of a long page most likely to hold the evidence for a claim:
 * the page's start, the passage the search engine quoted, and passages that
 * mention the claim's figures or names. Short pages are returned whole.
 */
export function pageWindow(text: string, terms: { claim: string; excerpt: string; context: string }, max = PAGE_CHARS): string {
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  const span = 1500;
  const hits: number[] = [];
  // Where the quoted excerpt sits: try its first few words.
  for (const piece of terms.excerpt.split(/\s*…\s*/)) {
    const head = piece.replace(/[#*|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).toLowerCase();
    const at = head.length >= 15 ? lower.indexOf(head) : -1;
    if (at >= 0) hits.push(at);
  }
  // Figures first (most specific), then names and other content words.
  const words = `${terms.claim} ${terms.context}`.match(/\$?\d[\d,.]*[kmb%]?|[A-Za-z][A-Za-z'-]{3,}/gi) ?? [];
  const figures = words.filter((w) => /\d/.test(w)).map((w) => w.replace(/^\$/, "").toLowerCase());
  const names = words.filter((w) => !/\d/.test(w) && !STOP.has(w.toLowerCase())).map((w) => w.toLowerCase());
  for (const w of [...new Set([...figures, ...names])]) {
    let at = lower.indexOf(w);
    for (let n = 0; at >= 0 && n < 4; n++, at = lower.indexOf(w, at + span)) hits.push(at);
  }
  const ranges: [number, number][] = [[0, 2000]];
  for (const h of hits) {
    const used = ranges.reduce((t, [a, b]) => t + b - a + 7, 0);
    const next: [number, number] = [Math.max(0, h - span / 2), Math.min(text.length, h + span)];
    if (used + next[1] - next[0] > max) break;
    ranges.push(next);
    ranges.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i][0] <= ranges[i - 1][1]) {
        ranges[i - 1][1] = Math.max(ranges[i - 1][1], ranges[i][1]);
        ranges.splice(i--, 1);
      }
    }
  }
  return ranges.map(([a, b]) => text.slice(a, b)).join("\n[…]\n").slice(0, max);
}
