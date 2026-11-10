import type { LlmClient } from "../agent/llm.js";
import type { NewFact, Source, Store } from "./db.js";

const SYSTEM = `You extract a structured ledger of concrete, checkable claims from an assistant's answer so they can be diffed against the live web later.
Return ONLY a JSON array (no prose, no code fences). Each item: {"entity": string, "attribute": string, "value": string, "source_url": string|null}.
Rules:
- Only concrete, time-sensitive facts: prices, plan tiers, limits, versions, release dates, feature availability, policy terms.
- "entity" is the product/vendor (e.g. "Supabase", "HubSpot Sales Hub"); "attribute" is what was claimed (e.g. "Pro plan price", "Free tier limit", "Latest release"); "value" is the claim exactly as stated, with units and billing terms.
- "source_url" must be one of the provided source URLs that supports the claim, else null.
- Skip opinions, advice, and anything that is not a verifiable fact. Max 40 items. If there are none, return [].`;

export interface ExtractInput {
  question: string;
  answer: string;
  sources: Source[];
  assistantMessageId: string;
  recordedDate: string;
}

export function parseFacts(raw: string, allowedUrls: Set<string>): NewFact[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const facts: NewFact[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const entity = typeof o.entity === "string" ? o.entity.trim() : "";
    const attribute = typeof o.attribute === "string" ? o.attribute.trim() : "";
    const value = typeof o.value === "string" ? o.value.trim() : "";
    if (!entity || !attribute || !value) continue;
    const url = typeof o.source_url === "string" && allowedUrls.has(o.source_url) ? o.source_url : null;
    facts.push({ entity: entity.slice(0, 120), attribute: attribute.slice(0, 160), value: value.slice(0, 400), sourceUrl: url });
  }
  return facts.slice(0, 40);
}

/**
 * Post-turn, off the critical path: parse concrete claims from the finished answer into `fact_snapshots`.
 * Called fire-and-forget after the SSE stream has closed, so it adds zero user-visible latency.
 */
export async function extractFacts(store: Store, llm: LlmClient, input: ExtractInput): Promise<number> {
  if (input.answer.length < 80) return 0;
  const sourceList = input.sources.map((s) => `- ${s.url}`).join("\n") || "(none)";
  const raw = await llm.complete({
    system: SYSTEM,
    user: `Question:\n${input.question}\n\nAnswer:\n${input.answer.slice(0, 8000)}\n\nSource URLs available:\n${sourceList}`,
    maxTokens: 2500,
  });
  const facts = parseFacts(raw, new Set(input.sources.map((s) => s.url)));
  if (!facts.length) return 0;
  return store.insertFacts(input.assistantMessageId, facts, input.recordedDate);
}
