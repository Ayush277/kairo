import express from "express";
import crypto from "node:crypto";
import { runTurn, type AgentEvent } from "./agent/orchestrator.js";
import { createLlm } from "./agent/llm.js";
import { config } from "./config.js";
import { assembleContext } from "./memory/context-assembler.js";
import { localDateStr, parseAsOf } from "./memory/dates.js";
import { Store } from "./memory/db.js";
import { seedBenchmark } from "./memory/seed.js";
import { createWebSearch } from "./tools/web-search.js";

const store = new Store(config.dbPath);
const llm = createLlm();
const search = createWebSearch();

// First boot: plant the benchmark episodes so the challenge prompts work immediately.
if (store.countMessages() === 0) {
  const seeded = seedBenchmark(store);
  console.log(`[seed] empty database → planted ${seeded.episodes.map((e) => `${e.session}@${e.date}`).join(", ")}`);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(config.publicDir));

function status() {
  return {
    today: localDateStr(new Date()),
    timezone: config.timezone,
    llm: llm ? { provider: llm.provider, model: llm.model } : null,
    search: config.search.provider,
    messages: store.countMessages(),
    facts: store.countFacts(),
  };
}

app.get("/api/status", (_req, res) => res.json(status()));

/** SSE chat endpoint: events are `status`, `delta`, `sources`, `done`, `error`. */
app.post("/api/chat", async (req, res) => {
  const body = (req.body ?? {}) as { message?: unknown; sessionId?: unknown; asOf?: unknown };
  const text = typeof body.message === "string" ? body.message.trim() : "";
  if (!text) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : crypto.randomUUID();
  const asOf = typeof body.asOf === "string" ? parseAsOf(body.asOf) : null;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (e: AgentEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    await runTurn({ store, llm, search }, { sessionId, text, asOf }, send, abort.signal);
  } catch (err) {
    send({ type: "error", message: (err as Error).message });
  }
  res.end();
});

app.get("/api/sessions/:id/messages", (req, res) => {
  res.json(store.sessionMessages(req.params.id, 200));
});

app.get("/api/timeline", (_req, res) => res.json(store.listDays()));

app.get("/api/timeline/:date", (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }
  const messages = store.messagesBetween(date, date);
  res.json({ date, messages, facts: store.factsForMessages(messages.map((m) => m.id)) });
});

/** Transparency endpoint: show exactly what the pre-flight assembler would inject for a prompt. */
app.post("/api/debug/context", (req, res) => {
  const { message, asOf } = (req.body ?? {}) as { message?: string; asOf?: string };
  const now = parseAsOf(asOf) ?? new Date();
  const ctx = assembleContext(store, message ?? "", now);
  res.json({ resolution: ctx.resolution, notes: ctx.notes, block: ctx.block });
});

app.post("/api/seed", (_req, res) => {
  const result = seedBenchmark(store);
  res.json({ ok: true, ...result, ...status() });
});

app.post("/api/reset", (req, res) => {
  store.reset();
  const reseed = (req.body as { seed?: boolean } | undefined)?.seed === true;
  if (reseed) seedBenchmark(store);
  res.json({ ok: true, ...status() });
});

app.listen(config.port, () => {
  const url = `http://localhost:${config.port}`;
  console.log(`\n  Kairo is running → ${url}\n`);
  console.log(`  LLM:    ${llm ? `${llm.provider} (${llm.model})` : "NOT CONFIGURED: set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env"}`);
  console.log(`  Search: ${config.search.provider}${config.search.provider === "duckduckgo" ? " (zero-key fallback; add TAVILY_API_KEY for best results)" : ""}`);
  console.log(`  Memory: ${config.dbPath} (${store.countMessages()} messages, ${store.countFacts()} fact snapshots)\n`);
});

process.on("SIGINT", () => process.exit(0));
