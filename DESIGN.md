# Kairo — Design

## 1. How It Works

The challenge's example prompts ("On Monday we shortlisted 5 CRM tools… has any changed since?", "What did I ask you on 3 November? Is your answer still correct today?", "Last Tuesday I asked about Postgres hosting… any pricing change since?") are not stateless web searches. They are **temporal state-diffing queries**: `Memory(t₀) × WebSearch(t_now) → Delta`. An agent needs a precise record of what it said at t₀ and a fast way to re-check it now, all behind **one tool: `web_search`**.

```
user prompt ─▶ ① Pre-flight hydrator ─▶ ② LLM + single web_search tool ─▶ stream to user
                 (in-process, ~ms)         (parallel queries + deep read)        │
                                                                                 ▼
                                                      ③ async fact-ledger extractor (after `done`)
```

1. **Pre-flight temporal & episodic hydrator** (`memory/`). `temporal-resolver.ts` turns "On Monday", "last Tuesday" (primary + prior-week fallback), "3 November", "yesterday", "N days ago", "since …" into concrete local-date windows relative to `now` (or a simulated `asOf`). `context-assembler.ts` queries the indexed `date_bucket` in SQLite, falls back to FTS5/BM25 keyword recall when there is no date, attaches the `fact_snapshots` recorded on those turns, and injects an `<episodic_memory>` block into the system prompt. If nothing matches, it injects a `<no_match>` note listing the dates that do have history, so the model cannot invent a past conversation.
2. **Single-tool parallel search & deep pricing reader** (`tools/`). `web_search` takes up to 5 `queries`, runs them with `Promise.allSettled` and an 8 s per-query timeout, de-duplicates URLs, and ranks official/pricing/changelog pages above review listicles. In `pricing_or_changelog` mode it fetches the best official page per query (max 4, in parallel), strips chrome, and keeps tables, headings and price lines as compact Markdown, so the model sees real tiers rather than 160-character snippets. Providers: Tavily → Serper → Exa, with a zero-key DuckDuckGo→Bing chain and Jina Reader for JS-heavy pages.
3. **Post-turn fact snapshot extractor** (`fact-extractor.ts`). After the `done` event, a cheap model parses the answer into `(entity, attribute, value, source_url)` rows linked to the assistant message and date. It is off the critical path, so it adds no user-visible latency, and it is what makes tomorrow's "what did I claim then?" a lookup instead of a re-read.

## 2. Why I Built It This Way

- **Memory lives in the runtime, not as a second LLM tool.** "It has one tool: web search" is honoured literally (the tool list sent to the model contains exactly one entry, and a test asserts it), and recall costs zero extra model round trips because it is resolved before the first token is requested.
- **Batched queries inside one tool call.** Verifying five CRMs or five Postgres hosts as sequential tool calls costs one LLM round trip per entity; one call with `queries: string[]` costs one. Measured on the zero-key path: two queries plus two deep page reads complete in about 1 s end to end.
- **Deep-read pricing pages.** Snippets routinely omit seat minimums, compute add-ons and usage-based tiers, which produces false "no change" verdicts. Reading the official page and keeping every price/plan/limit line prevents that. (The first live read showed Neon's tiers already differ from the seeded baseline, which a snippet would likely have missed.)
- **A fact ledger beside raw transcripts.** Diffing needs the *claims*, not prose; structured rows let the agent produce a Then-vs-Now table and cite the original source.
- **Deterministic time.** Date resolution is plain date math (tested across several "today" values, including the same-date collision where last Tuesday *is* 3 November), not an LLM guess. A simulated clock (`asOf`) makes the benchmark testable at any time.

## 3. What I Considered and Rejected

- **Vector DB for memory.** Temporal queries and exact entity names need B-tree date lookups and BM25; embeddings blur dates and add infrastructure. SQLite + FTS5 is one file, no service.
- **Multi-agent planner/critic.** Adds seconds of time-to-first-token and tokens; a well-built pre-flight context plus one parallel tool loop gets the answer in a single pass.
- **Headless browser for every search.** Cold-start cost is too high for the default path; HTTP + DOM stripping is fast, with Jina Reader as the JS-rendered fallback.
- **Memory as an LLM tool.** Violates the one-tool constraint and costs a round trip.

## 4. What I'd Do With Another Week

- **Content-hash watchers:** hash normalised pricing DOM subtrees of cited URLs and detect byte-level changes without an LLM, enabling proactive "this page changed" alerts.
- **Playwright worker pool** for SPA pricing calculators that hydrate tiers client-side.
- **Source-contradiction resolver:** when a blog disagrees with the vendor's live `/pricing`, automatically fetch a tiebreaker and say which one wins.
- **Evaluation harness:** replay 50 multi-session traces scoring temporal-recall precision, citation faithfulness and p95 latency; track regressions in CI.
- **Known limits today:** seeded baselines are illustrative, not historically verified; time-travel backdates *messages*, not the web; fact extraction quality depends on the fast model.
