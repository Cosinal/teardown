import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Cooking, Private } from "@/components/Waiting";
import type { TeardownStatus } from "@/lib/engine/pipeline";
import { STALE_RUN_ERROR } from "@/lib/engine/store";
import {
  DESIGN_ERROR,
  DESIGN_WAITING,
  PIPELINE_STAGES,
  PRIVATE_COPY,
  autoRefresh,
  isDesignId,
  publicStrings,
  showsProgress,
  stageIndex,
  stageStates,
  waitingCopy,
  waitingKind,
} from "@/lib/waiting";

vi.mock("@/app/t/[id]/actions", () => ({
  rerunTeardown: async () => {},
  resumeCheckout: async () => {},
}));

const STAGES = ["intake", "research", "section_research", "writing", "factcheck"] as const;
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe("pipeline stages on the waiting page", () => {
  it("lists the five stages a live run records, in order", () => {
    expect(PIPELINE_STAGES.map((s) => s.id)).toEqual([...STAGES]);
  });

  it.each([
    ["queued", "intake", 0],
    ["intake", "intake", 0],
    ["research", "research", 1],
    ["section_research", "section_research", 2],
    ["writing", "writing", 3],
    ["drafted", "writing", 3],
    ["factcheck", "factcheck", 4],
  ] as const)("%s highlights %s", (status, id, index) => {
    expect(stageIndex(status)).toBe(index);
    expect(PIPELINE_STAGES[index].id).toBe(id);
    expect(showsProgress(status)).toBe(true);
    expect(stageStates(status)).toEqual(
      PIPELINE_STAGES.map((_, i) => (i < index ? "done" : i === index ? "now" : "todo")),
    );
  });

  it.each(["awaiting_payment", "failed", "done"] as const)("%s has no step list", (status) => {
    expect(stageIndex(status)).toBe(-1);
    expect(showsProgress(status)).toBe(false);
    expect(stageStates(status)).toEqual(["todo", "todo", "todo", "todo", "todo"]);
  });

  it("refreshes while a run can still move, not after it failed", () => {
    const statuses: TeardownStatus[] = [
      "awaiting_payment", "queued", "intake", "research", "section_research",
      "writing", "factcheck", "drafted", "failed", "done",
    ];
    for (const status of statuses) {
      expect(autoRefresh(status)).toBe(status !== "failed");
    }
  });
});

describe("waiting copy", () => {
  it("names each outcome without a price or a claim that the product is live", () => {
    expect(waitingKind("queued", true, false)).toBe("running");
    expect(waitingKind("awaiting_payment", false, false)).toBe("unpaid");
    expect(waitingKind("failed", true, true)).toBe("failed_refunded");
    expect(waitingKind("failed", true, false)).toBe("failed_paid");
    expect(waitingKind("failed", false, false)).toBe("failed");

    const running = waitingCopy("running");
    expect(running.eyebrow).toBe("Building");
    expect(running.dek).toMatch(/2–5 minutes/);
    expect(running.title).toBe("Your readout is being built.");

    const blob = publicStrings().join("\n");
    expect(blob).not.toMatch(/\$\d/);
    expect(blob.toLowerCase()).not.toMatch(/\bis live\b/);
    expect(blob.toLowerCase()).not.toMatch(/cooking/);
    expect(PRIVATE_COPY.href).toBe("/");
    expect(waitingCopy("failed").dek.toLowerCase()).toMatch(/waitlist/);
  });
});

describe("design fixtures", () => {
  it("keeps sample, waiting and error off the database", () => {
    expect(isDesignId("sample")).toBe(true);
    expect(isDesignId("sample-waiting")).toBe(true);
    expect(isDesignId("sample-error")).toBe(true);
    expect(isDesignId("abc")).toBe(false);
    expect(DESIGN_WAITING.status).toBe("section_research");
    expect(DESIGN_ERROR).toMatchObject({ status: "failed", error: STALE_RUN_ERROR, refunded: true });
  });
});

describe("waiting markup", () => {
  const running = { status: "section_research" as const, idea: "A mobile dog grooming van.", error: null, paid: true, refunded: false };

  it("renders the five stages and the time range while a run is underway", () => {
    const markup = html(createElement(Cooking, { id: "abc", t: running }));
    for (const stage of PIPELINE_STAGES) {
      expect(markup).toContain(stage.label);
      expect(markup).toContain(stage.detail);
    }
    expect(markup).toContain("About 2–5 minutes");
    expect(markup).toContain("Stage 3 of 5");
    expect(markup).toContain("Tearitdown");
    expect(markup).not.toMatch(/\$\d/);
    expect(markup.toLowerCase()).not.toMatch(/\bis live\b/);
    expect(markup).toContain('aria-current="step"');
    expect(markup).not.toContain("Re-run from saved answers");
  });

  it("shows the admin re-run on a failed run and keeps the same action label", () => {
    const markup = html(createElement(Cooking, { id: "abc", t: DESIGN_ERROR, admin: { error: DESIGN_ERROR.error } }));
    expect(markup).toContain("Re-run from saved answers");
    expect(markup).toContain(STALE_RUN_ERROR);
    expect(markup).toContain("This readout didn");
    expect(markup).toContain("been refunded");
    expect(markup).not.toContain("About 2–5 minutes");
    expect(markup).not.toContain("Reading your idea");
  });

  it("hides the error and re-run from anyone who is not admin", () => {
    const markup = html(createElement(Cooking, { id: "abc", t: DESIGN_ERROR }));
    expect(markup).not.toContain("Re-run from saved answers");
    expect(markup).not.toContain(STALE_RUN_ERROR);
  });

  it("points a failed unpaid run at the waitlist, not at intake", () => {
    const markup = html(createElement(Cooking, {
      id: "abc",
      t: { status: "failed", idea: "Van", error: null, paid: false, refunded: false },
    }));
    expect(markup).toContain('href="/"');
    expect(markup).toContain("Join the waitlist");
    expect(markup).not.toContain("/new");
  });

  it("the private page has one public CTA, to the waitlist, and says building", () => {
    const markup = html(createElement(Private));
    expect(markup).toContain(PRIVATE_COPY.title);
    expect(markup).toContain('href="/"');
    expect(markup).toContain("Join the waitlist");
    expect(markup).toContain("Tearitdown is building.");
    expect(markup).not.toContain("/new");
    expect(markup).not.toMatch(/\$\d/);
    expect(markup.toLowerCase()).not.toContain("live");
  });
});
