# Section: Distribution

Write the Distribution section: up to three channels that could bring the first 100 paying customers, each with a rough cost to win one customer through it, judged against Economics.

{{ceiling_rule}} Break-even needs {{break_even}}.

Reply with this JSON shape:

```
{
  "channels": [
    {
      "name": "...",
      "examples": "...",
      "rating": "strong" | "mixed" | "weak",
      "cac": { "low": 0, "high": 0, "source": "S12" or null, "estimate": "..." or null },
      "reason": [Part, ...]
    }
  ],
  "scorecard": { "rating": "strong" | "mixed" | "weak", "finding": "..." }
}
```

`Part` is a cited text part as described above.

## channels

1 to 3 channels, best first: ones a first-time founder can actually run (communities, search, partnerships, referrals, direct outreach, ads, marketplaces) and that the sources and notes point to for this customer and geography.

- `name`: at most 34 characters, e.g. "Founder communities".
- `examples`: at most 46 characters, e.g. "Reddit, Indie Hackers, Discord groups". Name real places from the sources when you can.
- `cac`: the rough cost in {{currency}} to win one paying customer through the channel. `low` and `high` are plain numbers (the same number if you have one figure). Count money spent (ads, fees, commissions, free samples) and, for a free channel, the founder's time at a stated hourly rate. Cite `source` only if a source states the cost per customer, click or lead for this kind of channel; otherwise give `estimate`, the calculation in at most 90 characters, e.g. "Cost per click ÷ visit-to-sale conversion, from cited ad benchmarks". Use one method wording for every channel costed the same way.
- Code writes the cost and its comparison with Economics in front of your reason, e.g. "$40–$90 to win a customer vs $18 kept a groom". Do not repeat them.
- `reason`: 1 or 2 parts on why the channel suits these customers or what limits it, at most 55 characters together (a failed validation tells you the exact room). A part with a figure must cite a source or give an estimate method; plain parts have no digits.
- `rating`: how well the channel can bring the first 100 customers at a cost the business can pay. Code lowers it to "weak" when even the cheapest customer costs more than the ceiling above, and to "mixed" when the dearest one does.

## scorecard

- `rating`: no better than the best channel. "weak" when no channel can win customers at a cost the business can pay.
- `finding`: one line, at most 56 characters, with no digits, that ties acquisition to Economics and says whether the channels can plausibly reach break-even volume, e.g. "Only free channels fit what one sale can pay."

Do not restate Economics figures in your own words: code shows them. Cite at most {{max_sources}} sources and estimate methods the report doesn't already list; reusing one it already cites is free.
