# Section: Economics

Write the inputs for the Economics section: the price, the cost of one sale and the monthly fixed costs, each with the sourced benchmarks or estimates it rests on. Code computes the gross margin and break-even from your inputs and shows the arithmetic; do not compute them yourself.

Reply with this JSON shape:

```
{
  "per": "...",
  "currency": "...",
  "price": { "amount": 0, "note": [Part, ...] },
  "unit_cost": { "amount": 0, "note": [Part, ...] },
  "fixed_costs": { "amount": 0, "note": [Part, ...] },
  "break_even_unit": "...",
  "scorecard": { "rating": "strong" | "mixed" | "weak", "finding": "..." }
}
```

`Part` is a cited text part as described above.

## Fields

- `per`: what one sale is, at most 20 characters, e.g. "groom", "report", "customer a month". For a subscription, one sale is one customer for one billing period.
- `currency`: the ISO code every amount is in, e.g. "CAD". Use the currency of the geography. If a benchmark is in another currency, convert it in an estimated part and say so in its method.
- `price.amount`: the price of one sale, a plain number (e.g. 80, or 7.5). Start from the founder's price in the spec. If the spec gives a range, use its midpoint and say so in an estimated part. Cite a source in the note when competitor prices show where this price sits.
- `unit_cost.amount`: the direct cost of delivering one sale: payment fees, supplies, labour time, fuel, API or hosting cost, commissions. Add up the main lines; the note shows the biggest ones.
- `fixed_costs.amount`: what the business costs to run each month whatever the volume: vehicle, insurance, software, rent, the founder's own pay if the idea needs a full-time person. For a one-person online product with low fixed costs, a small figure is right.
- `break_even_unit`: what break-even counts, at most 20 characters, e.g. "grooms a month", "reports a month", "paying customers".
- `note`: 1 to 4 parts that show where the amount comes from, so a reader can follow it. Price and unit cost notes: at most 60 characters in total each. Fixed costs note: at most 130 characters in total.
  - Every part that contains a figure must be **found** (cite the source id that states it) or **estimated** (give the calculation in `estimate`). Plain parts may only join or explain, with no digits.
  - Use the same method wording each time you use the same method.
  - Example unit cost note: `[{ "text": "$0.30 + 2.9% card fee", "source": "S14", "estimate": null }, { "text": "+ $9 shampoo and fuel", "source": null, "estimate": "Supplies and fuel per visit, from the cited cost guide" }]`.

## scorecard

- `rating`: "strong" when the margin leaves clear room to grow at a reachable volume, "mixed" when it works only at a volume that is a stretch, "weak" when the numbers don't work.
- `finding`: one line, at most 56 characters, with no digits (the key figure carries the number), e.g. "Healthy margin, but break-even needs a full calendar."

If the sources give no benchmark for a cost line, estimate it and say how, or leave it out. Do not invent sourced figures. Cite at most {{max_sources}} distinct sources and estimate methods in total; the arithmetic counts as one.
