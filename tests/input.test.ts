import { describe, expect, it } from "vitest";
import { IntakeInputSchema } from "../lib/engine/input";

const valid = {
  idea: "Mobile dog grooming van that comes to your driveway.",
  target_customer: "Dog owners in Halifax",
  price: "$80 per groom",
  billing: "one_time",
  geography: "Halifax, NS",
};

describe("IntakeInputSchema", () => {
  it("accepts the required fields alone", () => {
    expect(IntakeInputSchema.parse(valid)).toEqual(valid);
  });

  it("trims text and turns blank optional fields into undefined", () => {
    const r = IntakeInputSchema.parse({ ...valid, idea: `  ${valid.idea}  `, known_competitors: "  ", stage: "building" });
    expect(r.idea).toBe(valid.idea);
    expect(r.known_competitors).toBeUndefined();
    expect(r.stage).toBe("building");
  });

  it("names each missing required field", () => {
    const r = IntakeInputSchema.safeParse({ idea: "", billing: "weekly" });
    expect(r.success).toBe(false);
    const fields = r.error!.issues.map((i) => i.path[0]);
    expect(fields).toEqual(expect.arrayContaining(["idea", "target_customer", "price", "billing", "geography"]));
  });

  it("rejects an idea that is too long", () => {
    expect(IntakeInputSchema.safeParse({ ...valid, idea: "x".repeat(601) }).success).toBe(false);
  });
});
