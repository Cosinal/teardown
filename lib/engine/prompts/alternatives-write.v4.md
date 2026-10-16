# Section: Existing Alternatives

Write the Existing Alternatives section: what this customer would use instead of the founder's product, what each costs, and where the open position is.

Reply with this JSON shape:

```
{
  "alternatives": [
    { "name": "...", "examples": "..." or null, "workaround": false, "what_it_does": "...", "price": Part, "weakness": [Part, ...] }
  ],
  "market_gap": [Part, ...],
  "scorecard": { "rating": "strong" | "mixed" | "weak", "key_figure": { "value": "...", "unit": "..." }, "finding": "...", "source": "S12" or null, "estimate": "..." or null }
}
```

`Part` is a cited text part as described above.

Character limits are hard: count characters and stay under each one. Aim about ten percent under. `finding` is at most 56 characters.

## alternatives

2 to 5 rows, including the workaround. **Most relevant first**: the first non-workaround row is the main rival, the closest direct substitute (same job for this customer, closest price and offer to the founder's). Do not lead with a better-known or better-sourced product when a closer substitute is in the notes.

- Each row is what this customer would actually use instead of the founder's product. Prefer real, named products. **Every credible named direct competitor in the sources and notes gets its own row** (its own product name and site), up to the row cap. Do not fold two priced tools that do the same job into one grouped row, and do not drop a named direct competitor because another is more famous, has a nicer source, or you already used the slot for a group. When you must cut to fit 5 rows, keep named direct products and the workaround; drop adjacent platforms or grouped "kind of" rows first.
- A grouped row (name "Fund-ops platforms", examples "Arcesium, FundGuard") is only for several similar products of the same kind that are not the closest substitutes. Cover other kinds (broader platforms, outsourced services, general-purpose tools) after the named direct competitors.
- Include "do it by hand" (or "do nothing") as a row with `workaround: true` and `examples: null` when it is realistic for this customer, which it usually is. At most one workaround row.
- Cite a source only when its quoted text, title or URL is about **that row's product** (or that group). A page about product A, including A's pricing page or a comparison A wrote, does not support a price or weakness for product B.
- `name`: at most 26 characters.
- `examples`: who offers it, e.g. "ChatGPT, Claude, Gemini". At most 30 characters. Required unless `workaround` is true. For a single named product, the site or domain is enough.
- `what_it_does`: one plain sentence, at most 64 characters.
- `price`: what it costs and how the price is structured, e.g. "$19 to $49 a month". At most 30 characters. Found or estimated, never plain, with one exception: when a real competitor publishes no pricing, keep the row and set the price to exactly `{ "text": "Not public", "source": null, "estimate": null }`. Do not drop a relevant competitor because its price is not public. A "Not public" row must still cite, in its `weakness`, a source that is about that product, so the row shows the product exists.
- `weakness`: 1 to 4 parts, at most 90 characters in total: why this customer would still look for something else. Cite parts that state facts found in a source; a judgement is a plain part.

## market_gap

1 to 4 parts, at most 400 characters in total. In plain language, where the open position sits among these alternatives: what none of them does well for this customer, and whether the founder's product, at its price, fills that. Cite the factual parts. Name the main rival when the gap depends on it. Do not cheerlead: if the sources show no gap, say so.

## scorecard

One entry that summarises the section.

- `rating`: "strong" when the alternatives leave a clear opening for this idea, "mixed" when there is an opening but strong alternatives exist, "weak" when the alternatives already serve this customer well.
- `key_figure`: `value` at most 6 characters and `unit` at most 14 characters, at most 16 characters combined, e.g. value "5", unit "alternatives". A count of alternatives counts the rows you wrote.
- `finding`: one line, at most 56 characters, e.g. "Free chatbots below, $50-plus human research above."
- Cite a source that supports the finding, or an estimate that produces the key figure.

Cite at most {{max_sources}} distinct sources and estimate methods in total across the whole section. Reuse a source where it supports several claims about the same product.
