import { z } from "zod";
import type { CheckClaim, Fixed, SectionCheck } from "../factcheck";
import type { IdeaSpec } from "../intake";
import { STAGE_MODELS, loadPrompt } from "../llm";
import { SOURCE_BUDGETS, buildPartialReport } from "../report";
import type { SourceStore } from "../research";
import { PartSchema, type Part } from "./alternatives";
import { runSectionResearch, runWriter, type SectionOptions } from "./common";
import { SECTIONS } from "./config";

// Economics: the writer gives three inputs (price, unit cost, monthly fixed
// costs), each as a number plus the cited or estimated parts it rests on.
// Gross margin and break-even are never written by the model: code computes
// them from the inputs that survive fact-check and writes out the arithmetic,
// tagged as an estimate with one fixed method. Every part that holds a figure
// must cite a source or give an estimate method.

export const ECONOMICS_RESEARCH_PROMPT = "economics-research.v1";
export const ECONOMICS_WRITE_PROMPT = "economics-write.v1";

/** The method behind every computed figure. */
export const ARITHMETIC_METHOD = "Arithmetic on the price, unit cost and fixed costs in Economics";
/** A cited figure its source didn't confirm keeps its place in the arithmetic, re-tagged with this method. */
export const UNCONFIRMED_METHOD = "Benchmark figure its cited page did not confirm; treat as rough";

const InputSchema = z.object({ amount: z.number(), note: z.array(PartSchema) });

export const EconomicsSchema = z.object({
  /** What one sale is, e.g. "groom", "report", "customer a month". */
  per: z.string(),
  /** ISO code, e.g. "CAD". */
  currency: z.string(),
  price: InputSchema,
  unit_cost: InputSchema,
  /** A month. */
  fixed_costs: InputSchema,
  /** What break-even counts, e.g. "grooms a month", "paying customers". */
  break_even_unit: z.string(),
  scorecard: z.object({ rating: z.enum(["strong", "mixed", "weak"]), finding: z.string() }),
});

export type EconomicsSection = z.infer<typeof EconomicsSchema>;

const INPUTS = ["price", "unit_cost", "fixed_costs"] as const;
type InputName = (typeof INPUTS)[number];
const INPUT_LABEL: Record<InputName, string> = { price: "Price", unit_cost: "Unit cost", fixed_costs: "Fixed costs" };
/** Note lengths: price and unit cost also appear in the four-figure row, which is narrow. */
const NOTE_MAX: Record<InputName, number> = { price: 60, unit_cost: 60, fixed_costs: 130 };
const ESTIMATE_MAX = 90;

/** "$80", "$7.50", "$3,500", "$12.5K", "$1.2M": at most 6 characters for amounts under $1B. */
export function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (a >= 1e6) return `${sign}$${trim(a / 1e6)}M`;
  if (a >= 1e4) return `${sign}$${a >= 99950 ? Math.round(a / 1e3) : trim(a / 1e3)}K`;
  if (a >= 100 || Number.isInteger(a)) return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
  return `${sign}$${a.toFixed(2)}`;
}

function count(n: number): string {
  return n >= 1e6 ? "1M+" : n.toLocaleString("en-US");
}

/** The figures computed from the inputs. Break-even is null when each sale loses money. */
export function computeEconomics(s: Pick<EconomicsSection, "price" | "unit_cost" | "fixed_costs">) {
  const kept = s.price.amount - s.unit_cost.amount;
  return {
    kept,
    margin: kept / s.price.amount,
    breakEven: kept > 0 ? Math.ceil(s.fixed_costs.amount / kept) : null,
  };
}

type FigureParts = { value: string; label: string; note: Part[] };

/** The section as report fields, still citing SourceStore ids. report.ts numbers them. */
export function economicsReport(s: EconomicsSection) {
  const { kept, margin, breakEven } = computeEconomics(s);
  const est = (text: string): Part => ({ text, source: null, estimate: ARITHMETIC_METHOD });
  const p = money(s.price.amount), c = money(s.unit_cost.amount), f = money(s.fixed_costs.amount), k = money(kept);
  const pct = `${Math.round(margin * 100)}%`;
  const be = breakEven === null ? "None" : count(breakEven);
  const beLong = breakEven === null ? "None" : `${be} ${s.break_even_unit}`;

  const unit: { price: FigureParts; cost_to_serve: FigureParts; margin: FigureParts; break_even: FigureParts } = {
    price: { value: p, label: "Price", note: s.price.note },
    cost_to_serve: { value: c, label: "Unit cost", note: s.unit_cost.note },
    margin: { value: pct, label: "Gross margin", note: [est(`(${p} − ${c}) ÷ ${p}`)] },
    break_even: {
      value: be,
      label: `Break-even, ${s.break_even_unit}`,
      note: [est(breakEven === null ? `Each sale loses ${money(-kept)}` : `${f} fixed ÷ ${k} kept a sale`)],
    },
  };
  const workings: FigureParts[] = [
    { label: "Price", value: `${p} a ${s.per}`.length <= 22 ? `${p} a ${s.per}` : p, note: s.price.note },
    { label: "Unit cost", value: c, note: s.unit_cost.note },
    { label: "Fixed costs", value: `${f} a month`, note: s.fixed_costs.note },
    { label: "Gross margin", value: pct, note: [est(`(${p} price − ${c} unit cost) ÷ ${p} = ${pct}, so ${k} is kept on each sale`)] },
    {
      label: "Break-even",
      value: beLong.length <= 22 ? beLong : be,
      note: [est(breakEven === null
        ? `Unit cost is above the price, so no volume covers the ${f} of fixed costs`
        : `${f} fixed costs a month ÷ ${k} kept a sale = ${(s.fixed_costs.amount / kept).toFixed(1)}, rounded up`)],
    },
  ];
  return {
    per: s.per,
    currency: s.currency,
    unit,
    workings,
    score: {
      rating: s.scorecard.rating,
      key_figure: { value: pct, unit: "gross margin" },
      finding: s.scorecard.finding,
      part: est(s.scorecard.finding),
    },
  };
}

/**
 * Checks the writer's JSON against the section rules. Throws with a message
 * that names the field, so the writer can be told what to fix.
 */
export function parseEconomics(raw: unknown, store: SourceStore, maxSources = SOURCE_BUDGETS.economics): EconomicsSection {
  const section = EconomicsSchema.parse(raw);
  const ids = new Set(store.map((s) => s.id));
  const cited = new Set<string>([`estimate:${ARITHMETIC_METHOD}`]);

  for (const name of INPUTS) {
    const input = section[name];
    if (!Number.isFinite(input.amount) || input.amount < 0) throw new Error(`${name}.amount: must be a number, 0 or more`);
    if (!input.note.length || input.note.length > 4) throw new Error(`${name}.note: 1 to 4 parts`);
    const chars = input.note.reduce((n, p) => n + p.text.length, 0);
    if (chars > NOTE_MAX[name]) throw new Error(`${name}.note: longer than ${NOTE_MAX[name]} characters in total`);
    if (!input.note.some((p) => p.source || p.estimate)) throw new Error(`${name}.note: needs at least one part that cites a source or gives an estimate`);
    input.note.forEach((p, j) => {
      const path = `${name}.note[${j}]`;
      if (p.source && p.estimate) throw new Error(`${path}: give a source id or an estimate method, not both`);
      if (/\d/.test(p.text) && !p.source && !p.estimate) throw new Error(`${path}: every figure must cite a source or give an estimate method`);
      if (p.source) {
        if (!ids.has(p.source)) throw new Error(`${path}: ${p.source} is not in the source list`);
        cited.add(p.source);
      }
      if (p.estimate) {
        if (p.estimate.trim().length > ESTIMATE_MAX) throw new Error(`${path}.estimate: longer than ${ESTIMATE_MAX} characters`);
        cited.add(`estimate:${p.estimate.trim()}`);
      }
    });
  }
  if (section.price.amount <= 0) throw new Error("price.amount: must be more than 0");
  if (section.price.amount >= 1e9 || section.fixed_costs.amount >= 1e9) throw new Error("amounts: under 1 billion");
  if (!/^[A-Z]{3}$/.test(section.currency)) throw new Error("currency: a three-letter ISO code, e.g. USD");
  if (!section.per.trim() || section.per.length > 20) throw new Error("per: 1 to 20 characters");
  if (!section.break_even_unit.trim() || section.break_even_unit.length > 20) throw new Error("break_even_unit: 1 to 20 characters");
  if (section.scorecard.finding.length > 56) throw new Error(`scorecard.finding: ${section.scorecard.finding.length} characters, at most 56`);
  if (/\d/.test(section.scorecard.finding)) throw new Error("scorecard.finding: no figures (the key figure carries the number)");
  if (cited.size > maxSources) throw new Error(`cites ${cited.size} distinct sources and estimate methods, counting the arithmetic; the limit is ${maxSources}`);
  return section;
}

/** Validates against the section rules and, through a report build, the page limits. */
function parseForReport(raw: unknown, store: SourceStore, maxSources: number): EconomicsSection {
  const section = parseEconomics(raw, store, maxSources);
  buildPartialReport({ economics: section }, store);
  return section;
}

const numbers = (text: string) => (text.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, "")).sort().join("|");

/**
 * Fact-check's view of the section. The amounts drive the arithmetic, so a
 * figure is never silently dropped: an unconfirmed one is re-tagged as a rough
 * estimate, and a rewrite may not change the numbers in a part.
 */
export function economicsCheck(store: SourceStore, maxSources = SOURCE_BUDGETS.economics): SectionCheck<EconomicsSection> {
  const locate = (id: string) => {
    const m = id.match(/^(price|unit_cost|fixed_costs)\.note\[(\d+)\]$/);
    if (!m) throw new Error(`unknown claim id ${id}`);
    return { name: m[1] as InputName, part: Number(m[2]) };
  };
  return {
    claims: (section) => INPUTS.flatMap((name) => section[name].note.flatMap((p, j): CheckClaim[] => (p.source ? [{
      id: `${name}.note[${j}]`,
      text: p.text,
      source: p.source,
      context: `Economics, the ${INPUT_LABEL[name].toLowerCase()} input (${money(section[name].amount)} ${section.currency}${name === "fixed_costs" ? " a month" : ` per ${section.per}`}): a benchmark it rests on`,
    }] : []))),
    fix(section, id, how, r): Fixed<EconomicsSection> | null {
      const { name, part } = locate(id);
      const s = structuredClone(section);
      const note = s[name].note;
      const p = note[part];
      const text = r.text?.trim();
      if (how === "rewrite") {
        if (!text || numbers(text) !== numbers(p.text)) return null;
        note[part] = { ...p, text };
        return { section: s, action: "rewritten", result: text };
      }
      if (how === "estimate" || (how === "drop" && /\d/.test(p.text))) {
        const method = (how === "estimate" && r.method?.trim()) || UNCONFIRMED_METHOD;
        note[part] = { text: (how === "estimate" && text && numbers(text) === numbers(p.text) ? text : p.text), source: null, estimate: method };
        return { section: s, action: "estimated", result: method };
      }
      if (how !== "drop") return null;
      note.splice(part, 1);
      return { section: s, action: "dropped" };
    },
    fallbacks: () => ["estimate", "drop"],
    rank: (id) => {
      const { name, part } = locate(id);
      return [INPUTS.indexOf(name), part];
    },
    row: () => undefined,
    parse: (s) => parseForReport(s, store, maxSources),
  };
}

/** The section's own instructions, after the shared writer context. */
export function economicsPrompt(maxSources = SOURCE_BUDGETS.economics): string {
  // The arithmetic is always cited, so the writer's own share is one less.
  return loadPrompt(ECONOMICS_WRITE_PROMPT).replaceAll("{{own_sources}}", String(maxSources - 1));
}

/** The section's own searches, merged into the store. */
export function researchEconomics(spec: IdeaSpec, store: SourceStore, notes: string, options: SectionOptions = {}) {
  return runSectionResearch("economics", {
    spec, store, notes,
    searches: options.maxSearches ?? SECTIONS.economics.searches,
    model: options.model ?? STAGE_MODELS.economics,
    prompt: ECONOMICS_RESEARCH_PROMPT,
  });
}

/** Writes the section from the shared writer context. `store` must be the store the context was built from. */
export function writeEconomics(context: string, store: SourceStore, options: SectionOptions = {}) {
  const maxSources = SOURCE_BUDGETS.economics;
  return runWriter("economics", {
    model: options.model ?? STAGE_MODELS.economics,
    context,
    sectionPrompt: economicsPrompt(maxSources),
    promptVersion: ECONOMICS_WRITE_PROMPT,
    parse: (json) => parseForReport(json, store, maxSources),
  });
}
