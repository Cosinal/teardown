# Section: Next tests

Plan up to three cheap tests that check the riskiest assumptions, to run in order. A first-time founder runs them alone, with little money, and each takes under two weeks.

Reply with this JSON shape:

```
{
  "tests": [
    {
      "name": "...", "description": "...", "summary": "..." or null, "assumption": 1, "proves": "...",
      "cost": 0, "days": 0, "kill_threshold": "...", "kill_threshold_short": "..." or null
    }
  ]
}
```

1 to 3 tests. The first checks assumption 1, the riskiest; page 1 shows it.

- `assumption`: the rank of the riskiest assumption this test checks.
- `name`: at most 24 characters, ending with a full stop, e.g. "Paid landing page."
- `description`: what the founder does, at most 64 characters, e.g. "A one-page offer with a checkout. Reports written by hand."
- `summary`: first test only (null for the others), at most 240 characters: the test pitched for page 1, saying who it reaches and why it is the cheapest way to check the riskiest assumption. It stands alone: no "see page", "above" or "below".
- `proves`: at most 40 characters, e.g. "People pay at all."
- `cost`: the out-of-pocket cost, a plain number in {{currency}} from 0 to {{max_cost}}. Code writes it as money.
- `days`: how long it takes, a whole number from 1 to {{max_days}}. Code writes it as days.
- `kill_threshold`: the result that shows the assumption is false, so the founder should stop, with a number, at most 70 characters, e.g. "Fewer than 9 paid orders from 300 visitors, a rate under 3%." It counts the same people the description sets up (if the test reaches 40 leads, the threshold is out of 40).
- `kill_threshold_short`: first test only (null for the others), at most 32 characters, e.g. "Under 9 orders from 300 visits".

Prefer tests that ask for money or a firm commitment (a pre-order, a deposit, a signed pilot) over surveys and likes, and reach people through the channels in Distribution. Visitor counts, conversion rates and thresholds are the plan's own numbers. Any price or cost you mention must be the test's own cost or a figure from the figures list, copied exactly (e.g. the founder's price).
