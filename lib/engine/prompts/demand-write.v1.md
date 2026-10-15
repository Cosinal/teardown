# Section: Demand Evidence

Write the Demand Evidence section: the checkable signals that people want this, and an honest verdict on how strong they are.

Reply with this JSON shape:

```
{
  "signals": [
    { "kind": "search" | "forum" | "reviews" | "market_size", "signal": "...", "rating": "strong" | "mixed" | "weak", "value": "...", "detail": Part }
  ],
  "evidence": "solid" | "mixed" | "thin",
  "scorecard": { "rating": "strong" | "mixed" | "weak", "headline": "..." or null, "unit": "...", "finding": "..." }
}
```

`Part` is a cited text part as described above.

Character limits are hard: count characters and stay under each one. Aim about ten percent under. `finding` is at most 56 characters.

## signals

0 to 4 signals, strongest first. Only these kinds, and only when a source in the list states the figure:

- `search`: search volume or a search-trend figure.
- `forum`: public posts asking for this or complaining about the problem or the current options (threads, comments, upvotes, members).
- `reviews`: how many reviews an alternative has, or its rating with the review count.
- `market_size`: a market size the source itself states for this market. Never one you calculated.

Rules for each signal:

- `value`: the figure, exactly as the source gives it or rounded, at most 6 characters, e.g. "6,600", "40+", "212", "$1.2B". It must contain a digit.
- `detail`: what the figure counts, at most 50 characters, e.g. "US searches a month for 'mobile dog groomer'". It must cite (`source`) the source that states the figure, and `estimate` must be null. The value and detail together are checked against that source.
- `signal`: a short label, at most 26 characters, e.g. "Search interest".
- Count characters before you reply: `detail` over 50 or `signal` over 26 fails validation.
- `rating`: how strongly this signal shows demand for this idea in this geography.
- No two signals may have the same `value`.

Leave a signal out rather than stretch it. A signal must be big enough to show demand on its own: a review count in single digits or a thread with a handful of replies is not a signal, so mention its absence in the finding instead. A figure about a broader category, a different geography, or a vendor's own claim about demand is not evidence for this idea. Zero signals is an acceptable answer.

## evidence

- "solid": several independent signals point the same way.
- "mixed": some real signals, but they are small, indirect or point different ways.
- "thin": fewer than {{min_signals}} signals, or the ones found are weak. Say it plainly: do not pad.

## scorecard

- `rating`: "strong", "mixed" or "weak". Thin evidence is always "weak".
- `headline`: the `value` of the signal to show as the key figure, or null to show the number of signals.
- `unit`: what the headline value counts, at most 14 characters, e.g. "searches/mo". The value and unit together must be at most 16 characters. Ignored when `headline` is null.
- `finding`: one line, at most 56 characters, with no digits. When evidence is thin it must start with "Thin evidence", e.g. "Thin evidence: no search or forum data for Halifax." The section may conclude that demand is unproven.

Cite at most {{max_sources}} distinct sources across the section; when `headline` is null, the count counts as one of them.
