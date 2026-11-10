# Kairo: design

## How it works

The example prompts ("On Monday we shortlisted 5 CRM tools… anything changed since?", "What did I ask you on 3 November? Still correct today?") are not web searches. They are **state diffs**: `what I said at t₀` vs `what is true now`. So the agent needs an exact record of its past claims, a fast live check, and one tool: `web_search`.

```
prompt ─▶ 1. Hydrate (SQLite, in-process) ─▶ 2. LLM + web_search ─▶ stream answer
                                                                        └─▶ 3. Extract facts (async, after `done`)
```

1. **Hydrate before the model runs.** A deterministic resolver (plain date math, tested across several "today" values) turns "Monday", "last Tuesday", "3 November", "yesterday", "N days ago", "since…" into date windows. "Last Tuesday" also keeps the prior week's Tuesday as a fallback. Those windows hit an indexed `date_bucket` in SQLite; with no date, FTS5/BM25 keyword recall takes over. The matching past turns plus their **fact snapshots** are injected as `<episodic_memory>`. If nothing matches, the model is told which dates *do* have history, so it can't invent a past chat.
2. **One tool, built for batching.** `web_search` takes up to 5 queries and runs them concurrently (8 s timeout each, failures tolerated), dedupes URLs, and ranks official pricing/changelog pages above review listicles. In pricing/changelog mode it also reads the best official page per query and compresses it to Markdown that keeps tables and price lines. Providers: Tavily, Serper, Exa, or a no-key Bing/DuckDuckGo chain.
3. **Ledger after the answer.** Once `done` is sent, a cheap model extracts `(entity, attribute, value, source)` rows linked to the message. Tomorrow's "what did I claim then?" is a lookup, and it costs the user no latency.

## Why this way

- **Memory is runtime, not a second tool.** "One tool" holds literally (a test asserts the model sees only `web_search`), and recall costs no extra model round trip.
- **Batch inside the tool.** Checking five vendors one call at a time costs five model round trips; a batched call costs one. Measured on the no-key path: 2 queries + 2 full page reads ≈ 1 s.
- **Read the page, not the snippet.** Snippets drop seat minimums and usage tiers, which yields false "no change" verdicts. A live read of Neon's pricing page already disagrees with my seeded baseline.
- **Structured facts beat transcripts.** A diff needs claims, not prose; rows give a clean Then-vs-Now table with the original source.
- **Time is testable.** A simulated clock lets anyone backdate a message and test "since then" immediately.

## Considered and rejected

- **Vector DB:** blurs dates and exact names; B-tree date lookup + BM25 is exact and one file.
- **Planner/critic agents:** add seconds to first token for no gain here.
- **Headless browser per search:** too slow by default; HTTP + DOM stripping, Jina Reader as the JS fallback.
- **Memory as a tool:** breaks "one tool" and adds a round trip.

## With another week

- **Evals:** replay 50 multi-session traces; score recall precision, citation faithfulness, p95 latency. *Not yet measured: answer quality with a live model; I have only tested the loop with a scripted LLM.*
- **Page-hash watchers** for byte-level change detection without an LLM.
- **Playwright pool** for client-rendered pricing calculators.
- **Conflict resolver:** when a blog contradicts the vendor's `/pricing`, fetch a tiebreaker and say which wins.
- **Honesty fix:** label demo-seed episodes in answers; seeded prices are illustrative baselines.
