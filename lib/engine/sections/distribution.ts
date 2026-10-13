import { z } from "zod";
import type { CheckClaim, Fixed, SectionCheck } from "../factcheck";
import { STAGE_MODELS, loadPrompt } from "../llm";
import { sourcesUsed } from "../report";
import type { SourceStore } from "../research";
import type { Rating } from "../types";
import { LIMITS } from "../validate";
import { PartSchema, type Part } from "./alternatives";
import { runWriter, type SectionOptions } from "./common";
import { ARITHMETIC_METHOD, UNCONFIRMED_METHOD, computeEconomics, money, type EconomicsSection } from "./economics";
import type { LaterContext } from "./later";

// Distribution: up to three channels for the first 100 customers, each with a
// rough cost to win one paying customer. That cost is held against Economics
// by code, never by the model: for a one-time sale, against the money one
// sale keeps (price − unit cost); for a subscription, as months to pay it
// back. A channel that costs more than a sale can pay for can't be rated
// above weak, so Distribution can't contradict Economics.

export const DISTRIBUTION_WRITE_PROMPT = "distribution-write.v1";

/** A subscription customer may cost at most this many months of the money they keep. */
export const PAYBACK_MONTHS = 12;
/** The method behind a subscription's payback and its acquisition-cost ceiling. */
export const PAYBACK_METHOD = `Acquisition cost ÷ money kept a month, from Economics; ${PAYBACK_MONTHS}-month payback at most`;

const REASON_MAX = 110;
const ESTIMATE_MAX = 90;

const CacSchema = z.object({
  /** In the Economics currency: the cheapest and dearest a paying customer costs through the channel. */
  low: z.number(),
  high: z.number(),
  source: z.string().nullable(),
  estimate: z.string().nullable(),
});

export const DistributionSchema = z.object({
  channels: z.array(z.object({
    name: z.string(),
    examples: z.string(),
    rating: z.enum(["strong", "mixed", "weak"]),
    cac: CacSchema,
    reason: z.array(PartSchema),
  })),
  scorecard: z.object({ rating: z.enum(["strong", "mixed", "weak"]), finding: z.string() }),
});

export type DistributionSection = z.infer<typeof DistributionSchema>;
type Cac = z.infer<typeof CacSchema>;

const ORDER: Record<Rating, number> = { weak: 0, mixed: 1, strong: 2 };
const lower = (a: Rating, b: Rating): Rating => (ORDER[a] <= ORDER[b] ? a : b);

/** The most a customer may cost: one sale's kept money, or a year of it for a subscription. */
export function cacCeiling(econ: EconomicsSection, subscription: boolean): number {
  const { kept } = computeEconomics(econ);
  return Math.max(0, subscription ? kept * PAYBACK_MONTHS : kept);
}

/** The best rating a channel can have at this cost: weak if even its cheapest customer costs more than the ceiling. */
export function channelCap(cac: Pick<Cac, "low" | "high">, ceiling: number): Rating {
  if (ceiling <= 0 || cac.low > ceiling) return "weak";
  return cac.high > ceiling ? "mixed" : "strong";
}

export function cacText(c: Pick<Cac, "low" | "high">): string {
  return c.low === c.high ? `About ${money(c.low)} to win a customer` : `${money(c.low)}–${money(c.high)} to win a customer`;
}

/** The comparison code adds after the cost: against one sale's kept money, or as payback months. */
function comparison(c: Pick<Cac, "low" | "high">, econ: EconomicsSection, subscription: boolean): Part {
  const { kept } = computeEconomics(econ);
  if (kept <= 0) return { text: `while each ${econ.per} loses money`, source: null, estimate: ARITHMETIC_METHOD };
  if (!subscription) return { text: `vs ${money(kept)} kept a ${econ.per}`, source: null, estimate: ARITHMETIC_METHOD };
  const months = (x: number) => Math.max(1, Math.ceil(x / kept));
  const lo = months(c.low), hi = months(c.high);
  const text = hi <= 1 ? "pays back within a month" : lo === hi ? `pays back in ${lo} months` : `pays back in ${lo}–${hi} months`;
  return { text, source: null, estimate: PAYBACK_METHOD };
}

/** The section as report fields, still citing SourceStore ids, with each rating held to what Economics allows. */
export function distributionReport(d: DistributionSection, econ: EconomicsSection, subscription: boolean) {
  const ceiling = cacCeiling(econ, subscription);
  const channels = d.channels.map((c) => ({
    name: c.name,
    examples: c.examples,
    rating: lower(c.rating, channelCap(c.cac, ceiling)),
    reason: [{ text: cacText(c.cac), source: c.cac.source, estimate: c.cac.estimate }, comparison(c.cac, econ, subscription), ...c.reason],
  }));
  const best = channels.reduce<Rating>((r, c) => (ORDER[c.rating] > ORDER[r] ? c.rating : r), "weak");
  return {
    channels,
    score: {
      rating: lower(d.scorecard.rating, best),
      key_figure: { value: money(ceiling), unit: "max CAC" },
      finding: d.scorecard.finding,
      part: { text: d.scorecard.finding, source: null, estimate: subscription ? PAYBACK_METHOD : ARITHMETIC_METHOD },
    },
  };
}

/** Characters the code-written cost and comparison take in a channel's reason. */
function addedLength(c: Cac, econ: EconomicsSection, subscription: boolean): number {
  return cacText(c).length + comparison(c, econ, subscription).text.length;
}

/**
 * Checks the writer's JSON against the section rules and the report's limits.
 * Throws with a message that names the field, so the writer can be told what to fix.
 */
export function parseDistribution(raw: unknown, ctx: LaterContext, store: SourceStore = ctx.store): DistributionSection {
  const section = DistributionSchema.parse(raw);
  const econ = ctx.drafts.economics;
  if (!econ) throw new Error("distribution: needs the economics section");
  const subscription = ctx.build.billing === "subscription";
  const ids = new Set(store.map((s) => s.id));
  if (!section.channels.length || section.channels.length > LIMITS.distribution) throw new Error(`channels: 1 to ${LIMITS.distribution}`);

  const cite = (p: { source: string | null; estimate: string | null }, path: string) => {
    if (p.source && p.estimate) throw new Error(`${path}: give a source id or an estimate method, not both`);
    if (p.source && !ids.has(p.source)) throw new Error(`${path}: ${p.source} is not in the source list`);
    if (p.estimate && p.estimate.trim().length > ESTIMATE_MAX) throw new Error(`${path}.estimate: longer than ${ESTIMATE_MAX} characters`);
  };
  section.channels.forEach((c, i) => {
    const path = `channels[${i}]`;
    if (!Number.isFinite(c.cac.low) || !Number.isFinite(c.cac.high) || c.cac.low < 0 || c.cac.high < c.cac.low) {
      throw new Error(`${path}.cac: low and high are numbers, 0 or more, with low <= high`);
    }
    if (!c.cac.source && !c.cac.estimate) throw new Error(`${path}.cac: cite the source that gives the cost, or give the estimate method`);
    cite(c.cac, `${path}.cac`);
    if (!c.reason.length || c.reason.length > 2) throw new Error(`${path}.reason: 1 or 2 parts`);
    c.reason.forEach((p, j) => {
      cite(p, `${path}.reason[${j}]`);
      if (/\d/.test(p.text) && !p.source && !p.estimate) throw new Error(`${path}.reason[${j}]: every figure must cite a source or give an estimate method`);
    });
    const own = c.reason.reduce((n, p) => n + p.text.length, 0);
    const room = REASON_MAX - addedLength(c.cac, econ, subscription);
    if (own > room) throw new Error(`${path}.reason: ${own} characters; with the cost text code adds, the reason parts may have at most ${room}`);
  });
  const sc = section.scorecard;
  if (sc.finding.length > 56) throw new Error(`scorecard.finding: ${sc.finding.length} characters, at most 56`);
  if (/\d/.test(sc.finding)) throw new Error("scorecard.finding: no figures (the key figure carries the number)");

  const { alternatives, demand_evidence, economics } = ctx.drafts;
  const base = { alternatives, demand_evidence, economics };
  const added = sourcesUsed({ ...base, distribution: section }, store, ctx.build) - sourcesUsed(base, store, ctx.build);
  if (added > ctx.budgets.distribution) {
    throw new Error(`cites ${added} sources and estimate methods the report doesn't already list; the limit is ${ctx.budgets.distribution}. Reuse a source or method, or share one estimate method across channels`);
  }
  return section;
}

/** Fact-check's view of the section. A channel's cost drives its rating, so an unconfirmed cost is re-tagged as a rough estimate, never reworded or dropped. */
export function distributionCheck(ctx: LaterContext): (store: SourceStore) => SectionCheck<DistributionSection> {
  const locate = (id: string) => {
    const m = id.match(/^channels\[(\d+)\]\.(cac|reason\[(\d+)\])$/);
    if (!m) throw new Error(`unknown claim id ${id}`);
    return { row: Number(m[1]), part: m[3] === undefined ? null : Number(m[3]) };
  };
  return (store) => ({
    claims: (section) => section.channels.flatMap((c, i): CheckClaim[] => {
      const channel = `Distribution channel "${c.name}" (${c.examples})`;
      return [
        ...(c.cac.source ? [{ id: `channels[${i}].cac`, text: cacText(c.cac), source: c.cac.source, context: `${channel}: what it costs to win one paying customer through it` }] : []),
        ...c.reason.flatMap((p, j) => (p.source ? [{ id: `channels[${i}].reason[${j}]`, text: p.text, source: p.source, context: `${channel}: why it suits the first 100 customers` }] : [])),
      ];
    }),
    fix(section, id, how, r): Fixed<DistributionSection> | null {
      const { row, part } = locate(id);
      const s = structuredClone(section);
      if (how === "drop_row") {
        if (s.channels.length < 2) return null;
        s.channels.splice(row, 1);
        return { section: s, action: "dropped", result: "(channel dropped)", droppedRow: row };
      }
      const c = s.channels[row];
      if (part === null) {
        if (how === "rewrite") return null;
        const method = (how === "estimate" && r.method?.trim()) || UNCONFIRMED_METHOD;
        c.cac = { ...c.cac, source: null, estimate: method };
        return { section: s, action: "estimated", result: method };
      }
      const text = r.text?.trim();
      if (how === "rewrite") {
        if (!text) return null;
        c.reason[part] = { ...c.reason[part], text };
        return { section: s, action: "rewritten", result: text };
      }
      if (how === "estimate") {
        const method = r.method?.trim();
        if (!method) return null;
        c.reason[part] = { text: text || c.reason[part].text, source: null, estimate: method };
        return { section: s, action: "estimated", result: method };
      }
      if (c.reason.length < 2) return null;
      c.reason.splice(part, 1);
      return { section: s, action: "dropped" };
    },
    fallbacks: (id) => (locate(id).part === null ? ["estimate"] : ["drop", "drop_row"]),
    rank: (id) => {
      const { row, part } = locate(id);
      return [row, part === null ? 0 : part + 1];
    },
    row: (id) => locate(id).row,
    parse: (s) => parseDistribution(s, ctx, store),
  });
}

export function distributionPrompt(ctx: LaterContext): string {
  const econ = ctx.drafts.economics!;
  const { kept, breakEven } = computeEconomics(econ);
  const subscription = ctx.build.billing === "subscription";
  const ceiling = cacCeiling(econ, subscription);
  const rule = kept <= 0
    ? `Each ${econ.per} loses money in Economics, so no channel can pay to win customers: every channel is rated weak.`
    : subscription
      ? `This is a subscription: each customer keeps ${money(kept)} a month. Code shows each channel's payback in months; a customer may cost at most ${PAYBACK_MONTHS} months of that, ${money(ceiling)}.`
      : `Each ${econ.per} keeps ${money(kept)} (price − unit cost). Code shows each channel's cost against that; a customer may cost at most ${money(ceiling)}.`;
  return loadPrompt(DISTRIBUTION_WRITE_PROMPT)
    .replaceAll("{{ceiling_rule}}", rule)
    .replaceAll("{{break_even}}", breakEven === null ? "none: each sale loses money" : `${breakEven} ${econ.break_even_unit}`)
    .replaceAll("{{currency}}", econ.currency)
    .replaceAll("{{max_sources}}", String(ctx.budgets.distribution));
}

export function writeDistribution(ctx: LaterContext, options: SectionOptions = {}) {
  return runWriter("distribution", {
    model: options.model ?? STAGE_MODELS.distribution,
    context: ctx.context,
    finished: ctx.finished,
    sectionPrompt: distributionPrompt(ctx),
    promptVersion: DISTRIBUTION_WRITE_PROMPT,
    parse: (json) => parseDistribution(json, ctx),
  });
}
