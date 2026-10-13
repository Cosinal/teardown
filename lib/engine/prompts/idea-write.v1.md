# Section: The idea as understood

Restate the founder's idea for page 1 of the readout, as intake understood it (the idea spec above). Describe it; do not judge it. Use only the spec: no market facts, and no figures the founder didn't give.

Reply with this JSON shape:

```
{ "headline": "...", "customer": "...", "problem": "...", "revenue": "..." }
```

Every field above is a plain string or number, not a cited part object.

Character limits are hard: aim about ten percent under each one, since a field even one character over fails.

- `headline`: the idea in one line, at most 64 characters, e.g. "Mobile dog grooming at the owner's door in Halifax". It is page 1's title.
- `customer`: who buys, at most 90 characters.
- `problem`: what the customer wants solved, in their terms, at most 90 characters.
- `revenue`: how it makes money, at most 90 characters: the founder's price and billing as the spec gives them, e.g. "$80 per groom, paid per visit." If the spec gives a range, give the range, not a midpoint.

Where the spec had to assume something (its ambiguities), you may state the assumption plainly.
