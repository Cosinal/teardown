import type { TeardownStatus } from "@/lib/engine/pipeline";
import { STALE_RUN_ERROR } from "@/lib/engine/store";

/**
 * The five stages a live run actually records, in order. Writing and
 * fact-check can repeat after the first pass; the row's `status` is whichever
 * of those two is current. `queued` sits on the first stage (about to start).
 * `drafted` is a leftover from older rows and counts as writing.
 */
export const PIPELINE_STAGES = [
  {
    id: "intake",
    label: "Reading your idea",
    detail: "Turning your answers into a brief",
    statuses: ["queued", "intake"],
  },
  {
    id: "research",
    label: "Searching the market",
    detail: "Finding who already serves this need",
    statuses: ["research"],
  },
  {
    id: "section_research",
    label: "Researching each section",
    detail: "Demand, pricing and alternatives",
    statuses: ["section_research"],
  },
  {
    id: "writing",
    label: "Writing the readout",
    detail: "Drafting the nine sections",
    statuses: ["writing", "drafted"],
  },
  {
    id: "factcheck",
    label: "Checking the facts",
    detail: "Verifying claims against sources",
    statuses: ["factcheck"],
  },
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGES)[number]["id"];
export type StageState = "done" | "now" | "todo";
export type WaitingKind = "unpaid" | "failed_refunded" | "failed_paid" | "failed" | "running";

export interface WaitingView {
  status: TeardownStatus;
  idea: string;
  error: string | null;
  paid: boolean;
  refunded: boolean;
}

export interface WaitingCopy {
  eyebrow: string;
  title: string;
  dek: string;
}

/** Public design fixtures. Like `/t/sample`, they never touch the database. */
export const DESIGN_IDS = ["sample", "sample-waiting", "sample-error"] as const;

export function isDesignId(id: string): boolean {
  return (DESIGN_IDS as readonly string[]).includes(id);
}

export const DESIGN_WAITING: WaitingView = {
  status: "section_research",
  idea: "A mobile dog grooming van.",
  error: null,
  paid: true,
  refunded: false,
};

export const DESIGN_ERROR: WaitingView = {
  status: "failed",
  idea: "A mobile dog grooming van.",
  error: STALE_RUN_ERROR,
  paid: true,
  refunded: true,
};

/** Index of the stage that matches `status`, or -1 if the page has no step list. */
export function stageIndex(status: TeardownStatus): number {
  return PIPELINE_STAGES.findIndex((s) => (s.statuses as readonly string[]).includes(status));
}

export function stageStates(status: TeardownStatus): StageState[] {
  const now = stageIndex(status);
  return PIPELINE_STAGES.map((_, i) => {
    if (now < 0) return "todo";
    if (i < now) return "done";
    if (i === now) return "now";
    return "todo";
  });
}

export function showsProgress(status: TeardownStatus): boolean {
  return stageIndex(status) >= 0;
}

/** Payment and failed pages sit still; everything else refreshes on its own. */
export function autoRefresh(status: TeardownStatus): boolean {
  return status !== "failed";
}

export function waitingKind(status: TeardownStatus, paid: boolean, refunded: boolean): WaitingKind {
  if (status === "awaiting_payment") return "unpaid";
  if (status === "failed" && refunded) return "failed_refunded";
  if (status === "failed" && paid) return "failed_paid";
  if (status === "failed") return "failed";
  return "running";
}

export function waitingCopy(kind: WaitingKind): WaitingCopy {
  switch (kind) {
    case "unpaid":
      return {
        eyebrow: "Checkout",
        title: "Waiting for payment.",
        dek: "Your answers are saved. Once your payment goes through, the readout starts and this page updates on its own.",
      };
    case "failed_refunded":
      return {
        eyebrow: "Stopped",
        title: "This readout didn't finish. You've been refunded.",
        dek: "Your payment has been refunded in full. It can take 5–10 business days to reach your account.",
      };
    case "failed_paid":
      return {
        eyebrow: "Stopped",
        title: "This readout didn't finish.",
        dek: "Your payment will be refunded in full.",
      };
    case "failed":
      return {
        eyebrow: "Stopped",
        title: "This readout didn't finish.",
        dek: "Your answers are still saved. Join the waitlist and we'll be in touch when Tearitdown is ready.",
      };
    case "running":
      return {
        eyebrow: "Building",
        title: "Your readout is being built.",
        dek: "Research, writing and fact-check usually take about 2–5 minutes. This page updates on its own. You can close it and come back to this link.",
      };
  }
}

export const PRIVATE_COPY = {
  eyebrow: "Private",
  title: "This readout is private.",
  dek: "Only the person who ordered it can see it, in the browser they used.",
  note: "Tearitdown is building.",
  cta: "Join the waitlist",
  href: "/",
} as const;

/** Copy that appears on a waiting, error or private page. Used to keep price and "live" off those screens. */
export function publicStrings(): string[] {
  return [
    ...Object.values(waitingCopy("unpaid")),
    ...Object.values(waitingCopy("failed_refunded")),
    ...Object.values(waitingCopy("failed_paid")),
    ...Object.values(waitingCopy("failed")),
    ...Object.values(waitingCopy("running")),
    PRIVATE_COPY.eyebrow,
    PRIVATE_COPY.title,
    PRIVATE_COPY.dek,
    PRIVATE_COPY.note,
    PRIVATE_COPY.cta,
    ...PIPELINE_STAGES.flatMap((s) => [s.label, s.detail]),
  ];
}
