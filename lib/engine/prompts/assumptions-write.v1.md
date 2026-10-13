# Section: Riskiest assumptions

List what must be true for this business to work, riskiest first: the assumptions the finished sections back least. The point is to tell the founder what to check before spending money.

Scorecard ratings: {{ratings}}. The weakest evidence is in: {{weakest}}.

Reply with this JSON shape:

```
{
  "assumptions": [
    { "statement": "...", "short": "...", "if_false": "...", "rests_on": "...", "evidence": "..." }
  ]
}
```

1 to 3 assumptions, ranked: the first is the riskiest.

- `rests_on`: the section whose evidence the assumption depends on: "alternatives", "demand_evidence", "economics", "distribution" or "blockers". The first assumption must rest on a section with the weakest evidence ({{weakest}}). Thin demand evidence usually makes "people will pay for this" the riskiest assumption.
- `evidence`: what that section found, restated from it, at most 200 characters, e.g. "Demand Evidence found one checkable signal: 94 Google reviews for one Halifax mobile groomer." It is fact-checked against the finished sections, so say only what they say.
- `statement`: the assumption as a plain claim about customers, costs or channels, at most 90 characters, e.g. "Halifax dog owners will pay $80 for a groom at home."
- `short`: the same assumption for page 1, at most 100 characters. It stands alone: no "see page", "above" or "below".
- `if_false`: what happens to the business if it is false, at most 100 characters, e.g. "If false, there is no business: salons already serve these owners."

Every figure must come from the figures list, copied exactly. Each assumption must be something a founder can test in under two weeks; leave out what nobody can check (the economy, a competitor's plans).
