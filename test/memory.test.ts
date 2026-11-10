import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/memory/db.js";
import { seedBenchmark } from "../src/memory/seed.js";
import { assembleContext } from "../src/memory/context-assembler.js";
import { parseFacts } from "../src/memory/fact-extractor.js";

const NOW = new Date("2026-11-10T15:00:00");
const fresh = () => {
  const s = new Store(":memory:");
  seedBenchmark(s, NOW);
  return s;
};

test("seed plants the three benchmark episodes with fact snapshots", () => {
  const s = fresh();
  const days = s.listDays();
  assert.deepEqual(days.map((d) => d.date), ["2026-11-09", "2026-11-03"]); // Nov 3 == last Tuesday this year
  assert.equal(s.messagesBetween("2026-11-09", "2026-11-09").length, 2);
  assert.equal(s.messagesBetween("2026-11-03", "2026-11-03").length, 4);
  assert.ok(s.countFacts() >= 20);
  assert.ok(days.every((d) => d.seeded));
  // Re-seeding is idempotent.
  seedBenchmark(s, NOW);
  assert.equal(s.countMessages(), 6);
});

test("benchmark prompt 1: 'On Monday' hydrates the CRM shortlist and its pricing baselines", () => {
  const ctx = assembleContext(fresh(), "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", NOW);
  assert.ok(ctx.block?.includes("<episodic_memory"));
  for (const v of ["HubSpot Sales Hub", "Pipedrive", "Attio", "Close", "Folk"]) assert.ok(ctx.block!.includes(v), v);
  assert.ok(ctx.factCount >= 10);
});

test("benchmark prompt 2: '3 November' recalls that day's questions", () => {
  const ctx = assembleContext(fresh(), "What did I ask you on 3 November? Is your answer still correct today?", NOW);
  assert.ok(ctx.block?.includes("Llama 3.3 70B"));
  assert.ok(ctx.block?.includes("date=\"2026-11-03\""));
});

test("benchmark prompt 3: 'Last Tuesday' recalls the Postgres comparison", () => {
  const ctx = assembleContext(fresh(), "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", NOW);
  assert.ok(ctx.block?.includes("Supabase") && ctx.block.includes("Neon") && ctx.block.includes("Railway"));
});

test("last-Tuesday fallback: on a Wednesday the prior week's Tuesday is still found", () => {
  const s = new Store(":memory:");
  seedBenchmark(s, NOW); // Tuesday 2026-11-03 recorded
  const ctx = assembleContext(s, "Last Tuesday I asked about Postgres hosting", new Date("2026-11-11T09:00:00"));
  // primary window = 2026-11-10 (empty) → falls back to 2026-11-03
  assert.ok(ctx.block?.includes("Postgres"));
});

test("keyword recall works without a date; unrelated prompts get no memory", () => {
  const s = fresh();
  const hit = assembleContext(s, "Did the CRM pricing change since we last talked?", NOW);
  assert.ok(hit.block?.includes("HubSpot"));
  assert.equal(assembleContext(s, "What is the capital of France?", NOW).block, null);
  assert.equal(assembleContext(s, "hello", NOW).block, null);
});

test("a date with no history says so and lists dates that do", () => {
  const ctx = assembleContext(fresh(), "What did I ask you on 12 March?", NOW);
  assert.ok(ctx.block?.includes("<no_match>"));
  assert.ok(ctx.block?.includes("2026-11-03"));
  assert.equal(ctx.messageCount, 0);
});

test("clean slate: empty memory is reported honestly", () => {
  const s = new Store(":memory:");
  const ctx = assembleContext(s, "What did I ask you on Monday?", NOW);
  assert.ok(ctx.block?.includes("memory is empty"));
});

test("FTS survives hostile input", () => {
  const s = fresh();
  assert.doesNotThrow(() => assembleContext(s, `still "quoted" AND (broken OR * NEAR) crm's pricing`, NOW));
});

test("parseFacts validates shape and source urls", () => {
  const facts = parseFacts('```json\n[{"entity":"A","attribute":"b","value":"$1","source_url":"https://a.com"},{"entity":"","attribute":"x","value":"y"},{"entity":"B","attribute":"c","value":"d","source_url":"https://evil.com"}]\n```', new Set(["https://a.com"]));
  assert.equal(facts.length, 2);
  assert.equal(facts[0]!.sourceUrl, "https://a.com");
  assert.equal(facts[1]!.sourceUrl, null);
  assert.deepEqual(parseFacts("not json", new Set()), []);
});

test("same-date collision: topic words pick the right conversation, bare date keeps both", () => {
  const s = fresh(); // Nov 3 holds both the Llama and Postgres episodes on 2026-11-10
  const pg = assembleContext(s, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", NOW);
  assert.ok(pg.block!.includes("Supabase") && !pg.block!.includes("Llama 3.3 70B"));
  const bare = assembleContext(s, "What did I ask you on 3 November?", NOW);
  assert.ok(bare.block!.includes("Supabase") && bare.block!.includes("Llama 3.3 70B"));
});
