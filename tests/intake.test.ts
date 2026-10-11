import { describe, expect, it } from "vitest";
import { formatInput, parseIdeaSpec, type IdeaSpec } from "../lib/engine/intake";

const spec: IdeaSpec = {
  name: "Halifax mobile dog grooming",
  customer: "Dog owners in Halifax who don't want to drive to a salon",
  problem: "Getting a dog groomed without a trip and a wait",
  revenue_model: { price: "$80 per groom", billing: "one_time", notes: "Per visit" },
  category: "mobile pet grooming",
  geography: { scope: "local", places: ["Halifax, NS, Canada"] },
  search_queries: [
    { query: "mobile dog grooming Halifax", purpose: "competitors" },
    { query: "dog groomers Halifax NS", purpose: "competitors" },
    { query: "mobile dog grooming price Halifax", purpose: "pricing" },
    { query: "Halifax dog grooming reviews", purpose: "customers" },
    { query: "dog ownership Nova Scotia statistics", purpose: "demand" },
  ],
  ambiguities: [],
};

describe("parseIdeaSpec", () => {
  it("accepts a valid spec", () => {
    expect(parseIdeaSpec(spec)).toEqual(spec);
  });

  it("rejects too few or too many search queries", () => {
    expect(() => parseIdeaSpec({ ...spec, search_queries: spec.search_queries.slice(0, 3) })).toThrow(/4 to 10/);
    const many = Array.from({ length: 11 }, () => spec.search_queries[0]);
    expect(() => parseIdeaSpec({ ...spec, search_queries: many })).toThrow(/got 11/);
  });

  it("rejects unknown enums and empty names", () => {
    expect(() => parseIdeaSpec({ ...spec, geography: { scope: "planet", places: [] } })).toThrow();
    expect(() => parseIdeaSpec({ ...spec, name: " " })).toThrow(/name is empty/);
  });
});

describe("formatInput", () => {
  it("states missing optional fields", () => {
    const text = formatInput({ idea: "An idea.", target_customer: "Founders", price: "$5", billing: "one_time", geography: "online" });
    expect(text).toContain("Price: $5 (one-time)");
    expect(text).toContain("Known competitors: (not given)");
  });
});
