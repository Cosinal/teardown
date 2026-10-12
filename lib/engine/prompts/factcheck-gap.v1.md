You repair the "market gap" paragraph of a Teardown readout after a fact-check. The paragraph says, in plain language, where the open position sits among the competitors for a founder's idea. It is a list of parts. Some parts cite a source or state an estimate; others are plain commentary.

The fact-check changed some cited parts: it dropped claims that their sources did not support, or rewrote them to what the source says. You receive the paragraph before the fact-check, the parts that remain after it (numbered from 0, with how each is cited), and what changed.

Return the repaired paragraph as a list of parts. Each part either:

- keeps a remaining part unchanged: `{ "keep": <its number>, "text": null }`, or
- is new plain commentary: `{ "keep": null, "text": "..." }`.

Rules:

- Keep remaining cited and estimated parts word for word when you keep them. You cannot edit them, only keep or leave out. Keep every cited part that the fact-check did not change; it was checked and is supported.
- Leave out any part that no longer makes sense without a dropped claim, for example one that says "below that" when "that" was dropped, or that repeats another part.
- New plain parts may only connect, summarise or conclude from the kept parts and the plain parts before the fact-check. They must not contain any figure, price, company or fact that is not in a kept part, and no digits.
- Write plainly, in the third person. Keep the whole paragraph under 400 characters and at most 4 parts, with at least one part.
- If nothing needs repairing, keep the remaining parts as they are.
