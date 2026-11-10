<div align="center">

# ◐ Kairo

**A chat agent with exactly one tool, `web_search`, and a memory that understands time.**

Ask *"On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?"* and Kairo recalls what it told you on Monday, checks the live web in one batched search, and answers with a **Then vs Now** comparison.

`TypeScript` · `Node 20+` · `SQLite + FTS5` · `SSE streaming` · `Anthropic / OpenAI`

</div>

<p align="center"><img src="docs/architecture.svg" alt="Kairo architecture" width="100%"></p>

📐 **Architecture and every design decision: [DESIGN.md](DESIGN.md)**

---

## Quick start

```bash
npm install
cp .env.example .env     # add ONE LLM key (Anthropic or OpenAI)
npm run dev              # → http://localhost:3000
```

That is all. The server, the API (SSE streaming) and the UI run in a single process on one port, with no build step.

> **Requirements:** Node 20 or newer. SQLite is bundled (`better-sqlite3`); there is nothing else to install.

## Configuration

Everything is optional except one LLM key. Blank values and `...` placeholders are ignored.

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Use Anthropic (checked first) | none |
| `OPENAI_API_KEY` | Use OpenAI if no Anthropic key | none |
| `LLM_MODEL` | Main model override | `claude-sonnet-4-5` / `gpt-4o` |
| `LLM_FAST_MODEL` | Cheap model for background fact extraction | `claude-haiku-4-5` / `gpt-4o-mini` |
| `TAVILY_API_KEY` | Search provider (recommended) | none |
| `SERPER_API_KEY` | Search provider | none |
| `EXA_API_KEY` | Search provider | none |
| `PORT` | HTTP port | `3000` |

**Search provider order:** Tavily → Serper → Exa, whichever key is present. With no search key, Kairo falls back to a free DuckDuckGo/Bing chain (plus Jina Reader for JavaScript-heavy pages). That works for demos, but a real key is more reliable because free endpoints may rate-limit or show CAPTCHAs.

## Try it

On first boot an empty database is seeded with three conversations anchored to **today's calendar**, so the challenge prompts work on any date:

| Seeded episode | Date |
|---|---|
| Shortlist of 5 CRM tools for a 20-person sales team | most recent Monday |
| Hosted Llama 3.3 70B pricing question | most recent 3 November |
| Postgres hosting comparison (Supabase, Neon, RDS, Render, Railway) | last Tuesday |

Click a suggestion chip in the UI, or paste:

1. *On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?*
2. *What did I ask you on 3 November? Is your answer still correct today?*
3. *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?*

> Seeded prices are **illustrative baselines** for the "then" side of the comparison. The "now" side always comes from live search.
> In some years "last Tuesday" and "3 November" are the same date. Kairo then uses topic words to pick the right conversation, and keeps both for a bare date.

### Timeline & Seed Manager

Open it from the header or with `Cmd/Ctrl + K`.

- **Timeline:** browse every stored day, its messages and its fact snapshots.
- **Simulate date:** send your next message *as of* a past date, then clear the simulation and ask "has anything changed since then?" to test temporal memory live.
- **Seed & reset:** re-seed the benchmark episodes, reset and re-seed, or wipe to a clean slate.

## How a turn flows

1. **Hydrate:** dates in your message ("Monday", "last Tuesday", "3 November", "since…") are resolved with date math, and the matching past turns plus their stored facts are injected into the prompt.
2. **Search and answer:** the model gets one tool and can run up to 5 searches in parallel, deep-reading official pricing pages. The answer streams back with citations.
3. **Ledger:** after the answer is sent, a background pass records the claims (entity, attribute, value, source) for future comparisons.

## Project layout

```
src/
├── server.ts                  Express + SSE endpoints, first-boot seeding
├── config.ts                  Env parsing and provider selection
├── agent/
│   ├── orchestrator.ts        Streaming loop; the model is offered one tool
│   ├── prompts.ts             System prompt: date grounding + verification protocol
│   └── llm.ts                 Anthropic and OpenAI streaming adapters
├── memory/
│   ├── db.ts                  SQLite schema (WAL, FTS5), queries
│   ├── temporal-resolver.ts   "Monday", "last Tuesday", "3 Nov" → date windows
│   ├── context-assembler.ts   Pre-flight recall → <episodic_memory> block
│   ├── fact-extractor.ts      Async post-turn claim extraction
│   ├── seed.ts                Benchmark seeder, anchored to today
│   └── dates.ts               Local-calendar helpers
├── tools/
│   ├── web-search.ts          The single tool: parallel queries, ranking, deep read
│   ├── providers.ts           Tavily / Serper / Exa / free fallback
│   └── page-reader.ts         HTML → compact Markdown (tables and prices kept)
└── public/                    Zero-build UI (index.html, styles.css, app.js)
test/                          24 tests; no API keys needed
docs/                          Architecture diagrams used in the docs
```

## HTTP API

| Endpoint | Description |
|---|---|
| `POST /api/chat` | `{ message, sessionId?, asOf? }` → SSE events: `status`, `delta`, `sources`, `done`, `error` |
| `GET /api/status` | Provider, model, counts, today's date |
| `GET /api/timeline` · `GET /api/timeline/:date` | Stored days; messages and facts for one day |
| `POST /api/debug/context` | `{ message, asOf? }` → exactly what memory would be injected |
| `POST /api/seed` · `POST /api/reset` | Re-seed benchmark episodes · reset (`{ "seed": true }` to re-seed) |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (`tsx watch`) |
| `npm start` | Start without watching |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm test` | Run the test suite (uses a scripted LLM, so it needs no keys) |

## Notes and limits

- Tests verify the plumbing (date resolution, recall, the one-tool guarantee, parallel search, the agent loop), not the model's answer quality.
- Time-travel backdates **messages**, not the web: live results always reflect the real present.
- Data lives in `./data/kairo.db`. Delete the folder, or use the reset button, to start fresh.
