# Section: Blockers

Write the Blockers section: legal, regulatory, technical or platform problems that could stop or seriously delay launching this idea in this geography. 0 to 3 blockers, most severe first. Zero is an acceptable answer when nothing in the sources or notes points to one: do not list generic risks.

Reply with this JSON shape:

```
{
  "blockers": [
    { "type": "...", "risk": "...", "severity": "low" | "medium" | "high", "detail": Part }
  ],
  "scorecard": { "rating": "strong" | "mixed" | "weak", "finding": "..." }
}
```

`Part` is a cited text part as described above.

## blockers

- `type`: at most 12 characters, e.g. "Legal", "Licensing", "Technical", "Platform", "Insurance", "Data".
- `risk`: the problem in at most 36 characters, e.g. "Mobile vendor licence needed".
- `severity`: "high" when it could stop the launch or cost more than the business can bear, "medium" when it adds real cost or delay, "low" when it is routine paperwork.
- `detail`: one part, at most 100 characters, saying what the requirement or problem is. Found (cite the source that states it: a regulator, a platform's terms, a guide) or estimated (give the method). Never plain.
- Weak demand, competition or a low price are not blockers: other sections cover them.
- If a detail mentions a figure another section gives (price, margin, costs), copy it exactly from the figures list.

## scorecard

- `rating`: "strong" when nothing serious stands in the way, "mixed" when there is real cost or delay, "weak" when something could stop the launch. Code shows the number of high-severity blockers as the key figure, and any high-severity blocker holds the section to "mixed" at best.
- `finding`: one line, at most 56 characters, with no digits, e.g. "Nothing legal or technical prevents a launch."

Cite at most {{max_sources}} sources and estimate methods the report doesn't already list, counting the key figure's count as one; reusing one the report already cites is free.
