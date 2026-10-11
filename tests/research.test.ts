import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import real from "./fixtures/research-response.json";
import { buildSourceStore, normalizeUrl, notesText } from "../lib/engine/research";

// A trimmed response in the shape the API returns for web search: result
// blocks carry only url/title/encrypted content; readable text arrives as
// citations on the model's text blocks.
const message = {
  content: [
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "mobile dog grooming Halifax" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "s1",
      content: [
        { type: "web_search_result", url: "https://Example.com/pricing#plans", title: "Pricing", encrypted_content: "x", page_age: null },
        { type: "web_search_result", url: "https://other.ca/", title: "Other", encrypted_content: "x", page_age: "2026-01-01" },
      ],
    },
    { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "dog grooming price" } },
    { type: "web_search_tool_result", tool_use_id: "s2", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
    { type: "text", text: "Example charges $85.", citations: [
      { type: "web_search_result_location", url: "https://example.com/pricing", title: "Pricing", cited_text: "Full groom $85", encrypted_index: "i" },
      { type: "web_search_result_location", url: "https://example.com/pricing", title: "Pricing", cited_text: "Full groom $85", encrypted_index: "i" },
      { type: "web_search_result_location", url: "https://example.com/pricing", title: "Pricing", cited_text: "Nail trim $20", encrypted_index: "i" },
    ] },
    { type: "text", text: " A third site was cited without appearing in results.", citations: [
      { type: "web_search_result_location", url: "https://third.org/a", title: null, cited_text: "Quote", encrypted_index: "i" },
    ] },
    { type: "text", text: " No public pricing found for Other.", citations: null },
  ],
} as unknown as Anthropic.Message;

const responses = [{ message, retrieved_at: "2026-10-11T12:00:00.000Z" }];

describe("buildSourceStore", () => {
  const store = buildSourceStore(responses);

  it("keeps only quoted pages, deduped by normalized URL, numbered in order of appearance", () => {
    expect(store.map((s) => [s.id, s.url])).toEqual([
      ["S1", "https://Example.com/pricing#plans"],
      ["S2", "https://third.org/a"],
    ]);
  });

  it("builds excerpts from unique cited text only", () => {
    expect(store[0].excerpt).toBe("Full groom $85 … Nail trim $20");
  });

  it("falls back to the URL when there is no title, and records retrieval time", () => {
    expect(store[1].title).toBe("https://third.org/a");
    expect(store.every((s) => s.retrieved_at === "2026-10-11T12:00:00.000Z")).toBe(true);
  });

  it("returns an empty store when nothing was searched", () => {
    expect(buildSourceStore([{ message: { content: [] } as unknown as Anthropic.Message, retrieved_at: "" }])).toEqual([]);
  });
});

describe("notesText", () => {
  it("tags cited text with source ids", () => {
    const notes = notesText(responses, buildSourceStore(responses));
    expect(notes).toBe("Example charges $85. [S1] A third site was cited without appearing in results. [S2] No public pricing found for Other.");
  });
});

// A trimmed real response from the research stage (web_search_20250305, 2026-10-11).
describe("buildSourceStore on a real response", () => {
  const responses = [real as unknown as { message: Anthropic.Message; retrieved_at: string }];
  const store = buildSourceStore(responses);

  it("finds the quoted pages, in order of first appearance, each with an excerpt", () => {
    expect(store.map((s) => s.url)).toEqual([
      "https://www.yelp.ca/search?find_desc=Mobile+Dog+Grooming&find_loc=Halifax%2C+NS",
      "https://www.facebook.com/A4PPets/",
      "https://sudsuppup.ca/mobile-dog-grooming",
    ]);
    expect(store.every((s) => s.excerpt.length > 0)).toBe(true);
    expect(store[2].excerpt).toContain("Now offering MOBILE DOG GROOMING!");
  });

  it("tags the notes with the store's ids", () => {
    const notes = notesText(responses, store);
    expect(notes).toContain("Now offering MOBILE DOG GROOMING! [S3]");
    expect(notes).toMatch(/located in Halifax, NS\. \[S2\]/);
  });
});

describe("normalizeUrl", () => {
  it("ignores host case, fragments and a trailing slash", () => {
    expect(normalizeUrl("https://Example.com/a/#x")).toBe(normalizeUrl("https://example.com/a"));
  });
});
