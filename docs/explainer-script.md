# Kairo: 60-second explainer script

Facecam script, about 155 words (roughly 60 seconds at a relaxed pace). Show `docs/architecture-sketch.png` on screen from 0:22 to 0:48.

**[0:00 · Hook]**
Hi, I'm [name], and this is Kairo, a chat agent with exactly one tool: web search. It also has a memory that understands time.

**[0:10 · Why]**
I built it because a question like "what changed since Monday?" isn't really a search. It's a comparison: what I told you then, versus what's true now.

**[0:22 · How: memory]**
So before the model even runs, Kairo works out what "Monday" means using plain date math. It pulls that day from SQLite and loads the exact claims it made: prices, tiers, limits.

**[0:36 · How: speed]**
Then it already knows which vendors to check, so it starts one batched search, up to five queries in parallel, before the first model call. That saves a whole round trip.

**[0:48 · Accuracy]**
It reads the actual pricing page, not the snippet, because snippets miss seat minimums and usage tiers.

**[0:55 · Honest close]**
One caveat: my tests use a scripted model, so live answer quality is the next thing I'll measure. Thanks for watching.

## Delivery tips

- Pause for a beat after "SQLite" and after "round trip". Those are the two key points.
- Say "state diff" out loud for a more technical audience. It is the core idea, but it is left out of the script for simplicity.
- "The five vendors" refers to the CRM benchmark prompt. Adjust it if you demo a different one.

## Before you record

- The prefetch speed gain is by design and not yet measured against a live model.
- The seeded "then" prices are illustrative baselines, not verified history.
- A live demo needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env`.
