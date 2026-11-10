# Kairo

A chat agent with **one tool, `web_search`**, and a built-in **temporal episodic memory** so it can answer questions like *"On Monday we shortlisted 5 CRM tools — has anything changed since?"*. See [DESIGN.md](DESIGN.md) for the architecture.

## Run

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY or OPENAI_API_KEY (+ optionally TAVILY_API_KEY)
npm run dev               # → http://localhost:3000
```

- LLM: Anthropic if `ANTHROPIC_API_KEY` is set, otherwise OpenAI (`LLM_MODEL` overrides the default `claude-sonnet-4-5` / `gpt-4o`).
- Search: Tavily → Serper → Exa by whichever key is present; with none, a zero-key DuckDuckGo/Bing chain plus Jina Reader is used (fine for demos; a real key is more reliable).
- Requires Node 20+. Data lives in `./data/kairo.db` (SQLite, WAL, FTS5).

## Try the benchmark prompts

On first boot an empty database is seeded with three conversations anchored to today's calendar: **last Monday** (5 CRM tools), the **most recent 3 November** (hosted-LLM pricing) and **last Tuesday** (Postgres hosting). Click the suggestion chips, or paste:

1. *On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?*
2. *What did I ask you on 3 November? Is your answer still correct today?*
3. *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?*

Seeded prices are illustrative baselines for the "then" side of the diff; the "now" side always comes from live search. Note: in some years "last Tuesday" and "3 November" fall on the same date; the assembler then uses topic words to choose the right conversation, and keeps both for a bare date.

**Timeline & Seed Manager** (header button or `Cmd/Ctrl+K`): browse stored days and their fact snapshots, simulate sending a message as of a past date, re-seed, or reset to a clean slate.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | `tsx watch src/server.ts` (API + SSE + UI on one port) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Resolver, memory, tool and orchestrator tests (no API keys needed; uses a scripted LLM) |

## Layout

`src/agent` orchestrator, prompts, LLM adapter · `src/memory` SQLite store, temporal resolver, context assembler, fact extractor, seeder · `src/tools` `web_search`, providers, page reader · `src/public` zero-build UI. `POST /api/debug/context` shows exactly what memory would be injected for a prompt.
