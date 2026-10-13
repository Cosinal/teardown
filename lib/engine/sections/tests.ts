import { z } from "zod";
import type { SectionCheck } from "../factcheck";
import { STAGE_MODELS, loadPrompt } from "../llm";
import { buildPartialReport } from "../report";
import type { NextTest } from "../types";
import { LIMITS } from "../validate";
import { checkFigures, knownFigures, pointsElsewhere } from "./brief";
import { runWriter, type SectionOptions } from "./common";
import { money } from "./economics";
import type { LaterContext } from "./later";

// Next Tests: up to three cheap tests, run in order, each checking one of the
// riskiest assumptions, the first checking the riskiest (page 1 shows them
// together). Each fits under two weeks and a small budget; code writes the
// cost and time from numbers so they always fit their columns. A test's own
// plan figures (visitors, orders, a conversion rate) are its own; any money
// figure must be its cost or one the report already gives.

export const TESTS_WRITE_PROMPT = "tests-write.v1";

/** Under two weeks. */
export const MAX_TEST_DAYS = 13;
/** Cheap: a founder pays for it out of pocket. In the Economics currency. */
export const MAX_TEST_COST = 500;

export const TestsSchema = z.object({
  tests: z.array(z.object({
    name: z.string(),
    description: z.string(),
    /** Page-1 pitch. Required for the first test, null for the others. */
    summary: z.string().nullable(),
    /** 1-based rank of the assumption it checks. */
    assumption: z.number(),
    proves: z.string(),
    cost: z.number(),
    days: z.number(),
    kill_threshold: z.string(),
    /** Page-1 version of the kill threshold. Required for the first test. */
    kill_threshold_short: z.string().nullable(),
  })),
});

export type TestsSection = z.infer<typeof TestsSchema>;

export function testTime(days: number): string {
  return days === 7 ? "1 week" : `${days} day${days === 1 ? "" : "s"}`;
}

export function testsReport(t: TestsSection): NextTest[] {
  return t.tests.map((x) => ({
    name: x.name,
    description: x.description,
    ...(x.summary && { summary: x.summary }),
    assumption: x.assumption,
    proves: x.proves,
    cost: money(x.cost),
    time: testTime(x.days),
    kill_threshold: x.kill_threshold,
    ...(x.kill_threshold_short && { kill_threshold_short: x.kill_threshold_short }),
  }));
}

/** Money figures only: a test's counts and rates are its own plan. */
const moneyIn = (text: string) => (text.match(/\$\s?\d[\d,]*(?:\.\d+)?(?:\s*[KkMm](?![A-Za-z]))?/g) ?? []).join(" ");

export function parseTests(raw: unknown, ctx: LaterContext): TestsSection {
  const section = TestsSchema.parse(raw);
  const tests = section.tests;
  const ranks = ctx.drafts.riskiest_assumptions?.assumptions.length ?? 0;
  if (!ranks) throw new Error("tests: need the riskiest assumptions");
  if (!tests.length || tests.length > LIMITS.next_tests) throw new Error(`tests: 1 to ${LIMITS.next_tests}`);
  tests.forEach((t, i) => {
    const path = `tests[${i}]`;
    if (!Number.isInteger(t.assumption) || t.assumption < 1 || t.assumption > ranks) throw new Error(`${path}.assumption: a rank from 1 to ${ranks}`);
    if (!Number.isInteger(t.days) || t.days < 1 || t.days > MAX_TEST_DAYS) throw new Error(`${path}.days: a whole number of days from 1 to ${MAX_TEST_DAYS} (under two weeks)`);
    if (!Number.isFinite(t.cost) || t.cost < 0 || t.cost > MAX_TEST_COST) throw new Error(`${path}.cost: a number from 0 to ${MAX_TEST_COST}`);
    const lengths = [["name", t.name, 24], ["description", t.description, 64], ["proves", t.proves, 40], ["kill_threshold", t.kill_threshold, 70],
      ["summary", t.summary ?? "", 240], ["kill_threshold_short", t.kill_threshold_short ?? "", 32]] as const;
    for (const [k, v, max] of lengths) if (v.length > max) throw new Error(`${path}.${k}: ${v.length} characters, at most ${max}`);
    const known = { values: new Set([...ctx.known.values, ...knownFigures(`$${t.cost}`).values]), shown: [...ctx.known.shown, money(t.cost)] };
    for (const [k, v] of [["name", t.name], ["description", t.description], ["summary", t.summary ?? ""], ["proves", t.proves]] as const) {
      checkFigures(moneyIn(v), known, `${path}.${k}`);
    }
  });
  const first = tests[0];
  if (first.assumption !== 1) throw new Error("tests[0].assumption: the first test checks the riskiest assumption, 1");
  if (!first.summary?.trim() || !first.kill_threshold_short?.trim()) throw new Error("tests[0]: needs summary and kill_threshold_short (page 1 shows them)");
  if (pointsElsewhere(first.summary) || pointsElsewhere(first.kill_threshold_short)) {
    throw new Error("tests[0]: summary and kill_threshold_short stand alone on page 1, so don't refer to other pages or to \"above\" or \"below\"");
  }
  buildPartialReport({ ...ctx.drafts, next_tests: section }, ctx.store, ctx.build);
  return section;
}

/** Nothing in a test plan is cited, so fact-check has no claims; the figure rules above stand in for it. */
export function testsCheck(ctx: LaterContext): () => SectionCheck<TestsSection> {
  return () => ({
    claims: () => [],
    fix: () => null,
    fallbacks: () => [],
    rank: () => [0],
    row: () => undefined,
    parse: (s) => parseTests(s, ctx),
  });
}

export function testsPrompt(ctx: LaterContext): string {
  const econ = ctx.drafts.economics!;
  return loadPrompt(TESTS_WRITE_PROMPT)
    .replaceAll("{{max_days}}", String(MAX_TEST_DAYS))
    .replaceAll("{{max_cost}}", String(MAX_TEST_COST))
    .replaceAll("{{currency}}", econ.currency);
}

export function writeTests(ctx: LaterContext, options: SectionOptions = {}) {
  return runWriter("next_tests", {
    model: options.model ?? STAGE_MODELS.next_tests,
    context: ctx.context,
    finished: ctx.finished,
    sectionPrompt: testsPrompt(ctx),
    promptVersion: TESTS_WRITE_PROMPT,
    parse: (json) => parseTests(json, ctx),
  });
}
