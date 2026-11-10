import type { ToolDef } from "../agent/llm.js";
import type { Source } from "../memory/db.js";
import { readPage } from "./page-reader.js";
import { createSearchProvider, type SearchHit, type SearchProvider, type SearchTopic } from "./providers.js";

/** The ONE tool exposed to the LLM. */
export const WEB_SEARCH_TOOL: ToolDef = {
  name: "web_search",
  description:
    "Execute parallel web searches and optionally deep-read specific URLs (such as pricing or changelog pages) to verify live facts. Supports up to 5 concurrent search queries in a single call.",
  inputSchema: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        description:
          "1 to 5 targeted search queries executed in parallel. When verifying multiple entities (e.g., 5 CRM tools or multiple Postgres hosts), batch them in a single call for speed.",
      },
      topic: {
        type: "string",
        enum: ["general", "news", "pricing_or_changelog"],
        description:
          "Use 'pricing_or_changelog' when verifying current prices, tiers, or recent product launches so the engine automatically extracts full pricing tables from top URLs.",
      },
      days_back: {
        type: "number",
        description: "Optional recency filter in days when looking for recent announcements or changes.",
      },
    },
    required: ["queries"],
  },
};

export type SearchProgress =
  | { type: "search_start"; queries: string[]; topic: SearchTopic; provider: string }
  | { type: "search_done"; hits: number; failed: number; ms: number }
  | { type: "read_start"; urls: string[] }
  | { type: "read_done"; ok: number; failed: number; ms: number };

export interface WebSearchResult {
  /** Text handed back to the LLM as the tool result. */
  content: string;
  sources: Source[];
}

export type WebSearchRunner = (input: unknown, onProgress?: (e: SearchProgress) => void, signal?: AbortSignal) => Promise<WebSearchResult>;

const QUERY_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 8_000;
const MAX_QUERIES = 5;
const MAX_DEEP_READS = 4;
const RESULTS_PER_QUERY = 5;
const PAGE_CHARS = 5_000;

const PRICING_WORDS = /\b(pricing|price|prices|plans?|cost|changelog|release notes?|releases?|what'?s new)\b/i;
const GENERIC = new Set(["pricing", "price", "prices", "plans", "plan", "changelog", "release", "releases", "notes", "official", "latest", "update", "updates", "new", "2024", "2025", "2026", "2027", "hosting", "tool", "tools", "best", "review", "reviews", "vs", "cost", "free", "what", "with", "from", "this", "that", "since", "shipped", "announcement", "announcements"]);
const LOW_QUALITY = /(^|\.)(g2|capterra|softwareadvice|getapp|trustradius|trustpilot|forbes|medium|quora|pinterest|youtube|linkedin|facebook|zapier|techradar|pcmag|cloudwards|saasworthy|financesonline|crozdesk|sourceforge|slashdot)\./i;
const PRICING_PATH = /\/(pricing|plans?|prices?|changelog|release-?notes|releases|whats?-new|updates|blog|docs)(\/|$|-|\?)/i;

export interface ScoredHit extends SearchHit {
  score: number;
  official: boolean;
  query: number;
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** Heuristic authority score: official domain > pricing/changelog path > docs/blog > generic > review listicles. */
export function scoreUrl(url: string, queries: string[], position: number): { score: number; official: boolean } {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    path = u.pathname;
  } catch {
    return { score: 0, official: false };
  }
  const label = host.split(".").slice(0, -1).join("");
  const tokens = queries
    .join(" ")
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((t) => !GENERIC.has(t)) ?? [];
  const official = tokens.some((t) => label.includes(t) || (t.length >= 5 && t.includes(label) && label.length >= 4));
  let score = 1 / (position + 1); // provider relevance order
  if (official) score += 3;
  if (PRICING_PATH.test(path)) score += /pricing|plans?|prices?|changelog|release/i.test(path) ? 2 : 0.5;
  if (/^(docs|blog|changelog|status|developers?)\./.test(host)) score += 0.5;
  if (LOW_QUALITY.test(host)) score -= 1.5;
  if (/reddit\.com$/.test(host)) score -= 0.5;
  return { score, official };
}

function withTimeout(ms: number, parent?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([t, parent]) : t;
}

function parseInput(input: unknown): { queries: string[]; topic: SearchTopic; daysBack?: number } {
  const raw = (input ?? {}) as Record<string, unknown>;
  const q = raw.queries ?? raw.query;
  const list = (Array.isArray(q) ? q : typeof q === "string" ? [q] : [])
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
  const queries = [...new Set(list)].slice(0, MAX_QUERIES);
  if (!queries.length) throw new Error("web_search requires `queries`: a non-empty array of search strings");
  let topic: SearchTopic = raw.topic === "news" || raw.topic === "pricing_or_changelog" ? raw.topic : "general";
  if (topic === "general" && queries.some((x) => PRICING_WORDS.test(x))) topic = "pricing_or_changelog";
  const d = Number(raw.days_back);
  return { queries, topic, daysBack: Number.isFinite(d) && d > 0 ? Math.ceil(d) : undefined };
}

export function createWebSearch(provider: SearchProvider = createSearchProvider()): WebSearchRunner {
  return async (input, onProgress, signal) => {
    const { queries, topic, daysBack } = parseInput(input);
    onProgress?.({ type: "search_start", queries, topic, provider: provider.name });
    const t0 = Date.now();

    // 1. Fan out every query concurrently; one slow/failed query never blocks the others.
    const settled = await Promise.allSettled(
      queries.map((q) =>
        provider.search(q, { topic, daysBack, maxResults: 8, signal: withTimeout(QUERY_TIMEOUT_MS, signal) }),
      ),
    );
    const errors: string[] = [];

    // 2. Score, then de-duplicate URLs across queries, keeping each URL under the query where it ranked best.
    const best = new Map<string, ScoredHit>();
    settled.forEach((r, qi) => {
      if (r.status === "rejected") {
        errors.push(`"${queries[qi]}": ${(r.reason as Error).message}`);
        return;
      }
      r.value.forEach((hit, pos) => {
        const { score, official } = scoreUrl(hit.url, queries, pos);
        const key = normalizeUrl(hit.url);
        const prev = best.get(key);
        if (!prev || score > prev.score) best.set(key, { ...hit, score, official, query: qi });
      });
    });
    const byQuery = queries.map((_, qi) =>
      [...best.values()].filter((h) => h.query === qi).sort((a, b) => b.score - a.score).slice(0, RESULTS_PER_QUERY),
    );
    const totalHits = byQuery.reduce((n, l) => n + l.length, 0);
    onProgress?.({ type: "search_done", hits: totalHits, failed: errors.length, ms: Date.now() - t0 });

    // 3. Deep-read: for pricing/changelog lookups pull the best official page per query so the model sees the
    //    real price table rather than a 160-character snippet.
    const pages: { url: string; title: string; markdown: string }[] = [];
    if (topic === "pricing_or_changelog") {
      const targets: ScoredHit[] = [];
      for (const list of byQuery) {
        const pick = [...list].sort((a, b) => Number(b.official) - Number(a.official) || b.score - a.score)[0];
        if (pick && !targets.some((t) => normalizeUrl(t.url) === normalizeUrl(pick.url))) targets.push(pick);
      }
      targets.sort((a, b) => b.score - a.score);
      const chosen = targets.slice(0, MAX_DEEP_READS);
      if (chosen.length) {
        const t1 = Date.now();
        onProgress?.({ type: "read_start", urls: chosen.map((c) => c.url) });
        const reads = await Promise.allSettled(
          chosen.map((c) => readPage(c.url, { signal: withTimeout(READ_TIMEOUT_MS, signal), maxChars: PAGE_CHARS })),
        );
        let failed = 0;
        reads.forEach((r, i) => {
          if (r.status === "fulfilled") pages.push({ url: chosen[i]!.url, title: r.value.title || chosen[i]!.title, markdown: r.value.markdown });
          else failed++;
        });
        onProgress?.({ type: "read_done", ok: pages.length, failed, ms: Date.now() - t1 });
      }
    }

    // 4. Compose the tool result.
    const out: string[] = [];
    queries.forEach((q, qi) => {
      out.push(`## Query ${qi + 1}: ${q}`);
      const list = byQuery[qi] ?? [];
      if (!list.length) out.push("(no results)");
      list.forEach((h, i) => {
        const date = h.publishedDate ? ` (published ${h.publishedDate})` : "";
        out.push(`${i + 1}. ${h.title}${h.official ? " [official]" : ""}${date}\n   ${h.url}\n   ${h.snippet.replace(/\s+/g, " ").slice(0, 320)}`);
      });
    });
    if (pages.length) {
      out.push("\n# Deep-read pages (live content, compressed to Markdown)");
      for (const p of pages) out.push(`\n### ${p.title}\nURL: ${p.url}\n\n${p.markdown}`);
    }
    if (errors.length) out.push(`\n(Some queries failed: ${errors.join("; ")})`);

    const sources: Source[] = [];
    const seen = new Set<string>();
    for (const p of pages) if (!seen.has(p.url)) (seen.add(p.url), sources.push({ title: p.title || p.url, url: p.url }));
    for (const list of byQuery) for (const h of list) if (!seen.has(h.url)) (seen.add(h.url), sources.push({ title: h.title || h.url, url: h.url }));

    return { content: out.join("\n"), sources };
  };
}
