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

## alternatives

2 to 5 rows, most relevant first, including the workaround.

- Each row is what this customer would actually use instead of the founder's product. A row may be one product or a group of similar products of the same kind (e.g. name "Fund-ops platforms", examples "Arcesium, FundGuard"). Prefer real, named products. When the sources show more than one kind of solution (direct tools, broader platforms or suites, outsourced services, general-purpose tools), cover the kinds rather than listing five products of the same kind.
- Include "do it by hand" (or "do nothing") as a row with `workaround: true` and `examples: null` when it is realistic for this customer, which it usually is. At most one workaround row.
- `name`: at most 26 characters.
- `examples`: who offers it, e.g. "ChatGPT, Claude, Gemini". At most 30 characters. Required unless `workaround` is true.
- `what_it_does`: one plain sentence, at most 64 characters.
- `price`: what it costs and how the price is structured, e.g. "$19 to $49 a month". At most 30 characters. Found or estimated, never plain, with one exception: when a real competitor publishes no pricing, keep the row and set the price to exactly `{ "text": "Not public", "source": null, "estimate": null }`. Do not drop a relevant competitor because its price is not public. A "Not public" row must still cite, in its `weakness`, a source that is about that product, so the row shows the product exists.
- `weakness`: 1 to 4 parts, at most 90 characters in total: why this customer would still look for something else. Cite parts that state facts found in a source; a judgement is a plain part.

## market_gap

1 to 4 parts, at most 400 characters in total. In plain language, where the open position sits among these alternatives: what none of them does well for this customer, and whether the founder's product, at its price, fills that. Cite the factual parts. Do not cheerlead: if the sources show no gap, say so.

## scorecard

One entry that summarises the section.

- `rating`: "strong" when the alternatives leave a clear opening for this idea, "mixed" when there is an opening but strong alternatives exist, "weak" when the alternatives already serve this customer well.
- `key_figure`: `value` at most 6 characters and `unit` at most 14 characters, at most 16 characters combined, e.g. value "5", unit "alternatives". A count of alternatives counts the rows you wrote.
- `finding`: one line, at most 56 characters, e.g. "Free chatbots below, $50-plus human research above."
- Cite a source that supports the finding, or an estimate that produces the key figure.

Cite at most {{max_sources}} distinct sources and estimate methods in total across the whole section. Reuse a source where it supports several claims.
