import { assembleContext } from "../memory/context-assembler.js";
import { describeDate, formatClock, localDateStr } from "../memory/dates.js";
import { extractFacts } from "../memory/fact-extractor.js";
import type { Source, Store } from "../memory/db.js";
import { WEB_SEARCH_TOOL, type SearchProgress, type WebSearchRunner } from "../tools/web-search.js";
import { config } from "../config.js";
import type { LlmClient, ToolCall, Turn } from "./llm.js";
import { planPrefetch } from "./prefetch.js";
import { buildSystemPrompt } from "./prompts.js";

export type AgentEvent =
  | { type: "status"; kind: "memory" | "search" | "read" | "info"; icon: string; text: string }
  | { type: "delta"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; messageId: string; timings: { memoryMs: number; firstTokenMs: number | null; totalMs: number }; searches: number; prefetched: boolean }
  | { type: "error"; message: string };

export interface AgentDeps {
  store: Store;
  llm: LlmClient | null;
  search: WebSearchRunner;
  /** Speculative prefetch for verification questions (defaults to config.prefetch). */
  prefetch?: boolean;
  /** Awaited-by-nobody background hook; exposed so tests can observe completion. */
  onBackgroundDone?: (p: Promise<unknown>) => void;
}

export interface TurnRequest {
  sessionId: string;
  text: string;
  /** Simulated message time (time-travel). Messages are stored with this timestamp. */
  asOf?: Date | null;
}

const MAX_STEPS = 4;

/**
 * Streaming agent loop. The model's tool list contains exactly one tool (`web_search`); memory is hydrated into the
 * system prompt before the first token is requested.
 */
export async function runTurn(deps: AgentDeps, req: TurnRequest, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  const { store, llm, search } = deps;
  const started = Date.now();
  const realNow = new Date();
  const now = req.asOf ?? realNow;

  if (!llm) {
    emit({
      type: "error",
      message: "No LLM key configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env (see .env.example) and restart.",
    });
    return;
  }

  // ── Stage 1: pre-flight temporal + episodic hydration (in-process SQLite; no tool round trip) ──
  const ctx = assembleContext(store, req.text, now);
  const memoryMs = Date.now() - started;
  for (const n of ctx.notes) emit({ type: "status", kind: "memory", icon: n.icon, text: n.text });
  if (req.asOf) emit({ type: "status", kind: "info", icon: "⏪", text: `Simulated clock: this message is sent as of ${formatClock(now)}` });

  // History is read before the new message is stored so a turn never recalls itself.
  const history = store.sessionMessages(req.sessionId, 12);
  store.insertMessage({ sessionId: req.sessionId, role: "user", content: req.text, createdAt: now });

  const turns: Turn[] = history.map((m): Turn =>
    m.role === "user"
      ? { role: "user", text: `[sent ${describeDate(m.dateBucket)}] ${m.content}` }
      : { role: "assistant", text: m.content },
  );
  turns.push({ role: "user", text: req.text });

  let firstTokenMs: number | null = null;
  let answer = "";
  let searches = 0;
  const sources = new Map<string, Source>();

  // ── Stage 1b: speculative prefetch. Memory already names the entities to verify, so run the batched search now
  //    instead of paying an LLM round trip just to be told to run it. Failure is harmless: fall back to the normal loop.
  let prefetched = false;
  const plan = (deps.prefetch ?? config.prefetch) ? planPrefetch(ctx, req.text, now) : null;
  if (plan) {
    emit({ type: "status", kind: "search", icon: "⚡", text: `Speculative prefetch: ${plan.entities.length} remembered entit${plan.entities.length === 1 ? "y" : "ies"} → searching before the model starts` });
    const call: ToolCall = {
      id: `prefetch_${Date.now().toString(36)}`,
      name: WEB_SEARCH_TOOL.name,
      input: { queries: plan.queries, topic: "pricing_or_changelog" },
    };
    try {
      const out = await search(call.input, (p) => emitProgress(p, emit), signal);
      if (out.sources.length) {
        for (const src of out.sources) if (!sources.has(src.url)) sources.set(src.url, src);
        turns.push({ role: "assistant", text: "", toolCalls: [call] });
        turns.push({ role: "tool", results: [{ id: call.id, name: call.name, content: out.content }] });
        searches++;
        prefetched = true;
      } else emit({ type: "status", kind: "search", icon: "↩️", text: "Prefetch returned nothing usable; the model will search itself" });
    } catch (err) {
      if (signal?.aborted) return;
      emit({ type: "status", kind: "search", icon: "↩️", text: `Prefetch failed (${(err as Error).message}); the model will search itself` });
    }
  }

  const system = buildSystemPrompt({ now, realNow, timezone: config.timezone, memoryBlock: ctx.block, prefetched });

  // ── Stage 2: tool loop ──

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const lastStep = step === MAX_STEPS - 1;
      const result = await llm.streamTurn({
        system,
        turns,
        tools: lastStep ? [] : [WEB_SEARCH_TOOL],
        signal,
        onText: (delta) => {
          firstTokenMs ??= Date.now() - started;
          emit({ type: "delta", text: delta });
        },
      });
      if (result.text) answer += (answer && !answer.endsWith("\n") ? "\n\n" : "") + result.text;
      if (!result.toolCalls.length) break;

      turns.push({ role: "assistant", text: result.text, toolCalls: result.toolCalls });
      const results = await Promise.all(result.toolCalls.map((c) => executeTool(c, search, emit, sources, signal)));
      searches += result.toolCalls.filter((c) => c.name === WEB_SEARCH_TOOL.name).length;
      turns.push({ role: "tool", results });
    }
  } catch (err) {
    if (signal?.aborted) return;
    emit({ type: "error", message: (err as Error).message });
    return;
  }

  // ── Persist and finish: the user sees `done` before any extraction work starts. ──
  const finalAnswer = answer.trim() || "(no answer produced)";
  const sourceList = [...sources.values()];
  const reply = store.insertMessage({
    sessionId: req.sessionId,
    role: "assistant",
    content: finalAnswer,
    createdAt: new Date(now.getTime() + (Date.now() - started)),
    sources: sourceList,
  });
  if (sourceList.length) emit({ type: "sources", sources: sourceList });
  emit({ type: "done", messageId: reply.id, timings: { memoryMs, firstTokenMs, totalMs: Date.now() - started }, searches, prefetched });

  // ── Stage 3: asynchronous fact ledger extraction (fire-and-forget). ──
  const job = extractFacts(store, llm, {
    question: req.text,
    answer: finalAnswer,
    sources: sourceList,
    assistantMessageId: reply.id,
    recordedDate: localDateStr(now),
  })
    .then((n) => console.log(`[ledger] recorded ${n} fact snapshot(s) for ${localDateStr(now)}`))
    .catch((e) => console.warn(`[ledger] extraction failed: ${(e as Error).message}`));
  deps.onBackgroundDone?.(job);
}

async function executeTool(
  call: ToolCall,
  search: WebSearchRunner,
  emit: (e: AgentEvent) => void,
  sources: Map<string, Source>,
  signal?: AbortSignal,
): Promise<{ id: string; name: string; content: string }> {
  // Hard guarantee behind "one tool": anything other than web_search is rejected.
  if (call.name !== WEB_SEARCH_TOOL.name) {
    return { id: call.id, name: call.name, content: `Error: unknown tool "${call.name}". The only available tool is web_search.` };
  }
  try {
    const out = await search(call.input, (p) => emitProgress(p, emit), signal);
    for (const s of out.sources) if (!sources.has(s.url)) sources.set(s.url, s);
    return { id: call.id, name: call.name, content: out.content };
  } catch (err) {
    emit({ type: "status", kind: "search", icon: "⚠️", text: `web_search failed: ${(err as Error).message}` });
    return { id: call.id, name: call.name, content: `Error: ${(err as Error).message}` };
  }
}

function emitProgress(p: SearchProgress, emit: (e: AgentEvent) => void): void {
  switch (p.type) {
    case "search_start":
      emit({
        type: "status",
        kind: "search",
        icon: "🔍",
        text: `Running ${p.queries.length} parallel web search${p.queries.length > 1 ? "es" : ""} (${p.topic} mode, ${p.provider}): ${p.queries.join(" · ")}`,
      });
      break;
    case "search_done":
      emit({ type: "status", kind: "search", icon: "✅", text: `${p.hits} results in ${(p.ms / 1000).toFixed(1)}s${p.failed ? ` (${p.failed} query failed)` : ""}` });
      break;
    case "read_start":
      emit({ type: "status", kind: "read", icon: "📄", text: `Deep-reading ${p.urls.length} official page${p.urls.length > 1 ? "s" : ""}: ${p.urls.map(hostOf).join(", ")}` });
      break;
    case "read_done":
      emit({ type: "status", kind: "read", icon: "📑", text: `Read ${p.ok} page${p.ok === 1 ? "" : "s"} in ${(p.ms / 1000).toFixed(1)}s${p.failed ? ` (${p.failed} failed)` : ""}` });
      break;
  }
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
