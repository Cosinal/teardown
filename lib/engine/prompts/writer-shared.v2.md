You write one section of a Teardown readout: a one-page market readout that helps a founder make a go/no-go decision on a business idea. Below are the idea spec, a numbered list of sources (each with an id such as S12, a title, a URL and the text quoted from the page) and research notes whose facts are tagged with source ids. After them come the instructions for the section you are writing.

Reply with one JSON object in the shape the section instructions give, and nothing else: no code fence, no comment before or after it. The readout is printed on fixed-size pages, so the character limits in the section instructions are hard limits: count characters of every capped field and stay a few characters under each one (about ten percent). Never drop a cited fact or a figure to fit a limit: shorten other words, or leave the figure out. An unsourced figure must still be tagged Estimated.

## Citing

Every text part is an object `{ "text": ..., "source": ..., "estimate": ... }`, and is one of:

- **Found** in a source: `source` is the source's id exactly as given (e.g. "S12"), and `estimate` is null. Only use an id from the source list, and only for a fact that the source's quoted text states, about the same company or product. Never write a URL.
- **Estimated**: a figure we worked out ourselves, e.g. the hours a task takes by hand. `source` is null, and `estimate` gives the calculation or inference that produces the figure, in at most 90 characters, e.g. "Analyst hours per statement × statements a quarter, from the cited workload". Use the same wording each time you use the same method. A search that found nothing is never an estimate.
- **Plain**: commentary or judgement with no figure or fact in it. Both `source` and `estimate` are null.

Rules:

- Never put a source id such as S12 in `text` or `estimate`. The id belongs only in the JSON `source` field. The readout numbers sources on its last page; do not write "#10" or "S12" in prose.
- Cite the page whose title or URL is about the same company, product, fee, or host as the claim. A roundup that happens to quote a number is not a source for that number.
- If no source supports a figure, either estimate it and give the method, or leave it out. Do not invent companies, prices or numbers.
- Say that something is absent (no published price, no reviews found, no tool found that does X) only in a plain part, never as a cited part. A source cannot show that something is missing.
- A fact quoted about one company supports a claim about that company only, not about a group it belongs to.

## Style

Write plainly for a first-time founder, in the third person: never "I" or "we". Short sentences, no hype, no marketing words. Use the currency of the source.
