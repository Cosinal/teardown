# Section: Verdict

Write the verdict for page 1 and the one-paragraph summaries at the top of pages 2 to 4. You write last: summarize what the eight finished sections say, and nothing else. Add no fact, figure or judgement they don't contain.

Reply with this JSON shape:

```
{
  "call": "pursue" | "test_first" | "drop",
  "confidence": "low" | "medium" | "high",
  "summary": "...",
  "page_summaries": { "market": "...", "business": "...", "next_steps": "..." }
}
```

## call

- "pursue": the sections support building it now: real demand signals, workable economics, channels that pay for themselves, no serious blocker.
- "test_first": it could work, but the riskiest assumption is unproven, so the founder should run the first test before building.
- "drop": the sections show it can't work as described: each sale loses money, no channel can pay for customers, or a blocker stops it.

{{limits}}

## confidence

How much evidence the sections give for the call: "high" only with several independent signals pointing the same way, "low" when the call rests mostly on estimates or thin evidence.

## summary

One or two sentences, at most 160 characters, that justify the call from the strongest findings (e.g. the gap among the alternatives, the demand verdict, the margin). Page 1 must stand alone: a reader who sees only page 1 must follow it, so no "see page", "above" or "below", and name what you refer to.

## page_summaries

Each at most 160 characters, in plain sentences:

- `market`: what Existing Alternatives and Demand Evidence add up to.
- `business`: what Economics and Distribution add up to.
- `next_steps`: what Blockers, the riskiest assumptions and the tests add up to.

Every figure must come from the figures list, copied exactly; leave a figure out rather than restate it. If a section says the evidence is thin, say so plainly.
