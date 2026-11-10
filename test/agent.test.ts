import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/memory/db.js";
import { seedBenchmark } from "../src/memory/seed.js";
import { runTurn, type AgentEvent } from "../src/agent/orchestrator.js";
import type { LlmClient, StreamArgs } from "../src/agent/llm.js";
import { WEB_SEARCH_TOOL, createWebSearch, scoreUrl, normalizeUrl } from "../src/tools/web-search.js";
import type { SearchProvider } from "../src/tools/providers.js";
import { htmlToMarkdown, focusPricing } from "../src/tools/page-reader.js";

test("the LLM is offered exactly one tool: web_search", () => {
  assert.equal(WEB_SEARCH_TOOL.name, "web_search");
});

function fakeLlm(script: (args: StreamArgs, call: number) => { text: string; toolCalls: { id: string; name: string; input: Record<string, unknown> }[] }): LlmClient & { calls: StreamArgs[]; completions: string[] } {
  const calls: StreamArgs[] = [];
  const completions: string[] = [];
  return {
    provider: "fake", model: "fake", calls, completions,
    async streamTurn(args) {
      calls.push(args);
      const r = script(args, calls.length - 1);
      if (r.text) args.onText(r.text);
      return r;
    },
    async complete({ user }) {
      completions.push(user);
      return JSON.stringify([{ entity: "Pipedrive", attribute: "Advanced price", value: "$29/user/mo", source_url: "https://www.pipedrive.com/en/pricing" }]);
    },
  };
}

const fakeProvider = (log: string[]): SearchProvider => ({
  name: "fake",
  async search(q) {
    log.push(q);
    if (q.includes("FAIL")) throw new Error("boom");
    const vendor = q.split(" ")[0]!.toLowerCase();
    return [
      { title: `Top 10 ${vendor} alternatives`, url: `https://www.g2.com/${vendor}`, snippet: "listicle" },
      { title: `${vendor} pricing`, url: `https://www.${vendor}.com/pricing`, snippet: "official" },
    ];
  },
});

test("web_search runs queries in parallel, dedupes, ranks official over listicles, tolerates failures", async () => {
  const log: string[] = [];
  const run = createWebSearch(fakeProvider(log));
  const res = await run({ queries: ["pipedrive pricing 2026", "attio pricing 2026", "FAIL pricing", "a", "b", "c", "pipedrive pricing 2026"], topic: "general" });
  assert.equal(log.length, 5); // clamped to 5, duplicates removed
  assert.ok(res.content.includes("[official]"));
  assert.ok(res.content.includes("Some queries failed"));
  assert.ok(res.sources.some((s) => s.url.includes("pipedrive.com")));
});

test("scoring and url normalisation", () => {
  assert.ok(scoreUrl("https://www.hubspot.com/pricing/sales", ["HubSpot Sales Hub pricing 2026"], 3).score > scoreUrl("https://www.g2.com/products/hubspot", ["HubSpot Sales Hub pricing 2026"], 0).score);
  assert.equal(normalizeUrl("https://www.Example.com/a/?utm_source=x#frag"), normalizeUrl("http://example.com/a"));
});

test("html → markdown keeps tables/prices and strips nav/script", () => {
  const { markdown } = htmlToMarkdown(`<html><head><title>P</title></head><body><nav>MENU</nav><script>x()</script><main><h1>Pricing</h1><table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$25/mo</td></tr></table><ul><li>10 GB</li></ul></main><footer>FOOT</footer></body></html>`);
  assert.ok(markdown.includes("| Plan | Price |") && markdown.includes("| Pro | $25/mo |") && markdown.includes("# Pricing") && markdown.includes("- 10 GB"));
  assert.ok(!/MENU|FOOT|x\(\)/.test(markdown));
  const long = `# T\n${"marketing fluff\n".repeat(500)}Pro plan $25/mo\n`;
  assert.ok(focusPricing(long, 500).includes("$25/mo"));
});

test("orchestrator: memory is hydrated pre-flight, one batched search, answer streamed, facts extracted async", { timeout: 30_000 }, async () => {
  const store = new Store(":memory:");
  const now = new Date("2026-11-10T15:00:00");
  seedBenchmark(store, now);
  const log: string[] = [];
  let bg: Promise<unknown> | undefined;
  const llm = fakeLlm((args, call) =>
    call === 0
      ? { text: "", toolCalls: [{ id: "t1", name: "web_search", input: { queries: ["pipedrive pricing 2026", "attio pricing 2026"], topic: "pricing_or_changelog" } }] }
      : { text: "Then vs now: Pipedrive Advanced moved $24 → $29. [Source](https://www.pipedrive.com/en/pricing)", toolCalls: [] },
  );
  const events: AgentEvent[] = [];
  // pricing mode would deep-read real URLs; the fake host names are unresolvable so reads fail fast and are tolerated.
  await runTurn(
    { store, llm, search: createWebSearch(fakeProvider(log)), onBackgroundDone: (p) => (bg = p) },
    { sessionId: "s1", text: "On Monday we shortlisted 5 CRM tools. Has any pricing changed since?" },
    (e) => events.push(e),
  );
  await bg;

  // Pre-flight: first model call saw the Monday episode in its system prompt, and only one tool.
  assert.ok(llm.calls[0]!.system.includes("<episodic_memory"));
  assert.ok(llm.calls[0]!.system.includes("HubSpot Sales Hub"));
  assert.deepEqual(llm.calls[0]!.tools.map((t) => t.name), ["web_search"]);
  assert.equal(llm.calls[1]!.turns.at(-1)?.role, "tool");
  assert.deepEqual(log.sort(), ["attio pricing 2026", "pipedrive pricing 2026"]);

  const types = events.map((e) => e.type);
  assert.ok(types.indexOf("status") < types.indexOf("delta") && types.includes("sources") && types.at(-1) === "done");
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done" && done.searches === 1);

  // Persistence + async ledger.
  const saved = store.sessionMessages("s1");
  assert.equal(saved.length, 2);
  assert.ok(saved[1]!.content.includes("Then vs now"));
  assert.equal(store.factsForMessages([saved[1]!.id]).length, 1);
});

test("orchestrator: unknown tools are rejected; missing LLM yields a clear error", async () => {
  const store = new Store(":memory:");
  const errs: AgentEvent[] = [];
  await runTurn({ store, llm: null, search: createWebSearch(fakeProvider([])) }, { sessionId: "x", text: "hi" }, (e) => errs.push(e));
  assert.equal(errs[0]?.type, "error");

  const llm = fakeLlm((_a, call) => (call === 0 ? { text: "", toolCalls: [{ id: "1", name: "memory_search", input: {} }] } : { text: "ok, no tool", toolCalls: [] }));
  await runTurn({ store, llm, search: createWebSearch(fakeProvider([])) }, { sessionId: "x", text: "hi" }, () => {});
  const toolTurn = llm.calls[1]!.turns.at(-1);
  assert.ok(toolTurn?.role === "tool" && toolTurn.results[0]!.content.includes("only available tool is web_search"));
});

test("time travel: a backdated message is stored on that day and later recalled", async () => {
  const store = new Store(":memory:");
  const llm = fakeLlm(() => ({ text: "Supabase Pro is $25/mo per project, as of then.", toolCalls: [] }));
  const search = createWebSearch(fakeProvider([]));
  const past = new Date(Date.now() - 3 * 86400000);
  await runTurn({ store, llm, search }, { sessionId: "tt", text: "Compare Supabase and Neon pricing", asOf: past }, () => {});
  assert.equal(store.listDays().length, 1);
  const llm2 = fakeLlm(() => ({ text: "ok", toolCalls: [] }));
  await runTurn({ store, llm: llm2, search }, { sessionId: "tt2", text: "3 days ago I asked about Supabase. Has anything changed since?" }, () => {});
  assert.ok(llm2.calls[0]!.system.includes("Compare Supabase and Neon pricing"));
});
