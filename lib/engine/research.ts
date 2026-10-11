import type Anthropic from "@anthropic-ai/sdk";
import type { IdeaSpec } from "./intake";
import { MODEL, ZERO_USAGE, addUsage, anthropic, assertFinished, costUsd, loadPrompt, type StageRun } from "./llm";

export const RESEARCH_PROMPT = "research.v1";

/** Searches allowed per request, and requests allowed per stage (the first plus pause_turn continuations). */
export const MAX_SEARCHES = 10;
const MAX_REQUESTS = 4;
const EXCERPT_MAX = 1200;

/** A web page the research stage found. Later stages may only cite these ids. */
export interface Source {
  /** "S1", "S2", ... in order of first appearance. */
  id: string;
  url: string;
  title: string;
  retrieved_at: string;
  /** Text quoted from the page, taken from the API's citations. Never empty. */
  excerpt: string;
}

export type SourceStore = Source[];

/** Lowercases the host and drops the fragment and a trailing slash, so one page gets one id. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

/**
 * Builds the SourceStore from the API's own blocks, never from URLs the model
 * writes in prose. Only pages the model quoted are kept, because search results
 * carry no readable text: a page with no citation has nothing a claim could
 * rest on. Ids are assigned after that filter, in order of first appearance.
 */
export function buildSourceStore(responses: { message: Anthropic.Message; retrieved_at: string }[]): SourceStore {
  const byUrl = new Map<string, Source & { quotes: string[] }>();
  const add = (url: string, title: string | null, retrieved_at: string) => {
    const key = normalizeUrl(url);
    let s = byUrl.get(key);
    if (!s) {
      s = { id: "", url, title: title?.trim() || url, retrieved_at, excerpt: "", quotes: [] };
      byUrl.set(key, s);
    } else if (s.title === s.url && title?.trim()) {
      s.title = title.trim();
    }
    return s;
  };

  for (const { message, retrieved_at } of responses) {
    for (const block of message.content) {
      // An error result's content is an object, not a list.
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) add(r.url, r.title, retrieved_at);
      } else if (block.type === "text" && block.citations) {
        for (const c of block.citations) {
          if (c.type !== "web_search_result_location") continue;
          const s = add(c.url, c.title, retrieved_at);
          const quote = c.cited_text.trim();
          if (quote && !s.quotes.includes(quote)) s.quotes.push(quote);
        }
      }
    }
  }

  return [...byUrl.values()].filter((s) => s.quotes.length).map(({ quotes, ...s }, i) => {
    const excerpt = quotes.join(" … ");
    return { ...s, id: `S${i + 1}`, excerpt: excerpt.length > EXCERPT_MAX ? `${excerpt.slice(0, EXCERPT_MAX - 1)}…` : excerpt };
  });
}

/** The model's written notes, with each cited passage tagged by source id, e.g. "... $80 per groom [S4]". */
export function notesText(responses: { message: Anthropic.Message }[], store: SourceStore): string {
  const ids = new Map(store.map((s) => [normalizeUrl(s.url), s.id]));
  let out = "";
  for (const { message } of responses) {
    for (const block of message.content) {
      if (block.type !== "text") continue;
      out += block.text;
      const cited = [...new Set((block.citations ?? []).flatMap((c) => (c.type === "web_search_result_location" ? [ids.get(normalizeUrl(c.url))] : [])))];
      if (cited.length) out += ` [${cited.join(", ")}]`;
    }
  }
  return out.trim();
}

export function researchRequest(spec: IdeaSpec): string {
  return `Here is the idea spec from intake, as JSON:\n\n${JSON.stringify(spec, null, 2)}`;
}

/**
 * Research: runs Claude with server-side web search over the spec's queries and
 * returns the sources it found. Resumes pause_turn up to MAX_REQUESTS requests.
 */
export async function runResearch(spec: IdeaSpec): Promise<{
  sources: SourceStore;
  notes: string;
  run: StageRun;
  /** Raw API responses, for debugging and fixtures. */
  responses: { message: Anthropic.Message; retrieved_at: string }[];
}> {
  const started = new Date();
  const system = loadPrompt(RESEARCH_PROMPT);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: researchRequest(spec) }];
  const responses: { message: Anthropic.Message; retrieved_at: string }[] = [];
  let usage = ZERO_USAGE;

  for (let i = 0; i < MAX_REQUESTS; i++) {
    const message = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      system,
      // The basic variant on purpose. web_search_20260209 (dynamic filtering) runs
      // searches from code execution, so results never come back as citable
      // blocks and the response has no citations, which leaves the SourceStore
      // with no excerpts (measured 2026-10-11: 0 excerpts across 292 sources).
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }],
      messages,
    });
    responses.push({ message, retrieved_at: new Date().toISOString() });
    usage = addUsage(usage, message.usage);
    if (message.stop_reason !== "pause_turn") {
      assertFinished(message, "research");
      break;
    }
    // Resume: send the paused turn back as is; the server continues from it.
    messages.push({ role: "assistant", content: message.content });
  }

  const sources = buildSourceStore(responses);
  if (!sources.length) throw new Error("research: no sources found");
  return {
    sources,
    notes: notesText(responses, sources),
    run: {
      stage: "research",
      prompt_version: RESEARCH_PROMPT,
      model: responses[0].message.model,
      usage,
      cost_usd: costUsd(MODEL, usage),
      started_at: started.toISOString(),
      duration_ms: Date.now() - started.getTime(),
    },
    responses,
  };
}
