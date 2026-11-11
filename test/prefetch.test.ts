import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/memory/db.js";
import { seedBenchmark } from "../src/memory/seed.js";
import { assembleContext } from "../src/memory/context-assembler.js";
import { planPrefetch } from "../src/agent/prefetch.js";
import { runTurn, type AgentEvent } from "../src/agent/orchestrator.js";
import type { LlmClient, StreamArgs } from "../src/agent/llm.js";
import type { WebSearchRunner } from "../src/tools/web-search.js";

const NOW = new Date("2026-11-10T15:00:00");
const store = () => {
  const s = new Store(":memory:");
  seedBenchmark(s, NOW);
  return s;
};
const plan = (text: string, s = store()) => planPrefetch(assembleContext(s, text, NOW), text, NOW);

test("plans one batched query per remembered entity for the CRM prompt", () => {
  const p = plan("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?");
  assert.deepEqual([...p!.entities].sort(), ["Attio", "Close", "Folk", "HubSpot Sales Hub", "Pipedrive"]);
  assert.deepEqual([...p!.queries].sort(), ["Attio pricing 2026", "Close pricing 2026", "Folk pricing 2026", "HubSpot Sales Hub pricing 2026", "Pipedrive pricing 2026"]);
});

test("a named vendor narrows the check; generic words do not", () => {
  assert.deepEqual(plan("Has Pipedrive changed its pricing since Monday?")?.entities, ["Pipedrive"]);
});

test("Postgres prompt plans the five hosts (and not the Llama episode)", () => {
  const p = plan("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
  assert.deepEqual([...p!.entities].sort(), ["AWS RDS", "Neon", "Railway", "Render", "Supabase"]);
});

test("no prefetch for pure recall, unrelated prompts, or when memory has no facts", () => {
  assert.equal(plan("What did I ask you on Monday?"), null);
  assert.equal(plan("What is the capital of France?"), null);
  assert.equal(plan("Has anything changed since Monday?", new Store(":memory:")), null);
});

test("'what did I ask… is it still correct today?' is both, so it prefetches", () => {
  assert.ok(plan("What did I ask you on 3 November? Is your answer still correct today?"));
});

function fakeLlm(): LlmClient & { calls: StreamArgs[] } {
  const calls: StreamArgs[] = [];
  return {
    provider: "fake", model: "fake", calls,
    async streamTurn(args) { calls.push(args); args.onText("Then vs now: see table."); return { text: "Then vs now: see table.", toolCalls: [] }; },
    async complete() { return "[]"; },
  };
}

const cannedSearch = (log: string[][]): WebSearchRunner => async (input) => {
  log.push((input as { queries: string[] }).queries);
  return { content: "## Query 1\n1. Pricing [official]\n   https://example.com/pricing", sources: [{ title: "Pricing", url: "https://example.com/pricing" }] };
};

test("prefetch: the model's FIRST call already has the search result, so no tool round trip is spent", async () => {
  const s = store(), llm = fakeLlm(), log: string[][] = [], events: AgentEvent[] = [];
  await runTurn({ store: s, llm, search: cannedSearch(log), prefetch: true }, { sessionId: "p1", text: "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?" }, (e) => events.push(e));
  assert.equal(llm.calls.length, 1); // a single model call produced the final answer
  assert.equal(log.length, 1);
  assert.equal(log[0]!.length, 5);
  const turns = llm.calls[0]!.turns;
  assert.equal(turns.at(-1)?.role, "tool");
  assert.equal(turns.at(-2)?.role, "assistant");
  assert.ok(llm.calls[0]!.system.includes("Prefetched live data"));
  assert.deepEqual(llm.calls[0]!.tools.map((t) => t.name), ["web_search"]); // still exactly one tool, still available for gaps
  const done = events.find((e) => e.type === "done");
  assert.ok(done?.type === "done" && done.prefetched && done.searches === 1);
  assert.ok(events.some((e) => e.type === "status" && e.icon === "⚡"));
});

test("prefetch off: the model sees no tool turn and no prefetch note", async () => {
  const llm = fakeLlm(), log: string[][] = [];
  await runTurn({ store: store(), llm, search: cannedSearch(log), prefetch: false }, { sessionId: "p2", text: "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?" }, () => {});
  assert.equal(log.length, 0);
  assert.equal(llm.calls[0]!.turns.at(-1)?.role, "user");
  assert.ok(!llm.calls[0]!.system.includes("Prefetched live data"));
});

test("prefetch failure or empty results falls back silently to the normal loop", async () => {
  for (const search of [
    (async () => { throw new Error("network down"); }) as WebSearchRunner,
    (async () => ({ content: "(no results)", sources: [] })) as WebSearchRunner,
  ]) {
    const llm = fakeLlm(), events: AgentEvent[] = [];
    await runTurn({ store: store(), llm, search, prefetch: true }, { sessionId: `p3${events.length}`, text: "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?" }, (e) => events.push(e));
    assert.equal(llm.calls[0]!.turns.at(-1)?.role, "user");
    const done = events.find((e) => e.type === "done");
    assert.ok(done?.type === "done" && !done.prefetched);
  }
});

test("no prefetch for a plain question, even with memory present", async () => {
  const llm = fakeLlm(), log: string[][] = [];
  await runTurn({ store: store(), llm, search: cannedSearch(log), prefetch: true }, { sessionId: "p4", text: "Explain what a B-tree index is" }, () => {});
  assert.equal(log.length, 0);
});
