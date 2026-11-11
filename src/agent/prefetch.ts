import type { AssembledContext } from "../memory/context-assembler.js";
import type { FactRow } from "../memory/db.js";

/**
 * Speculative prefetch. For "did X change / is it still correct?" questions, memory already tells us WHICH entities
 * to check (the fact snapshots). Waiting for the model to decide that, emit a tool call, and only then search costs
 * a full LLM round trip. So the runtime plans the batched web_search itself, runs it before the model is called, and
 * hands the model the result as an already-completed tool exchange. The model can still search again for gaps.
 */

export interface PrefetchPlan {
  entities: string[];
  queries: string[];
}

/** Prompt asks to verify something against the present. */
const VERIFY_INTENT =
  /\b(chang(?:e|ed|es|ing)|still|since|updated?|shipped|launch(?:ed)?|announc\w*|new(?:er)?|latest|current(?:ly)?|today|right now|correct|accurate|valid|up[- ]to[- ]date|different|increase[ds]?|raised|dropped|cheaper|more expensive)\b/i;

/** Prompt is purely about what was said, with no live check wanted ("what did I ask you on Monday?"). */
const PURE_RECALL = /\b(what did i (?:ask|say|tell)|remind me what|what was my (?:question|ask))\b/i;

const MAX_ENTITIES = 5;

export function planPrefetch(ctx: AssembledContext, text: string, now: Date): PrefetchPlan | null {
  if (!ctx.facts.length) return null;
  const asksVerify = VERIFY_INTENT.test(text);
  // "What did I ask on 3 November? Is it still correct today?" is both; pure recall alone is not.
  if (!asksVerify || (PURE_RECALL.test(text) && !/\b(still|correct|today|changed|accurate)\b/i.test(text))) return null;

  const byEntity = new Map<string, FactRow[]>();
  for (const f of ctx.facts) {
    const key = f.entity.trim().toLowerCase();
    byEntity.set(key, [...(byEntity.get(key) ?? []), f]);
  }

  let groups = [...byEntity.values()];
  // If the user names specific entities, check only those. Match the brand (first word) so a generic prompt word
  // like "sales" cannot narrow the check to "HubSpot Sales Hub".
  const brand = (g: FactRow[]) => g[0]!.entity.toLowerCase().split(/\s+/)[0]!;
  const named = groups.filter((g) => ctx.resolution.keywords.includes(brand(g)));
  if (named.length) groups = named;
  groups = groups.slice(0, MAX_ENTITIES);
  if (!groups.length) return null;

  const year = now.getFullYear();
  const queries = groups.map((g) => `${g[0]!.entity} ${queryKind(g)} ${year}`);
  return { entities: groups.map((g) => g[0]!.entity), queries };
}

function queryKind(facts: FactRow[]): string {
  const attrs = facts.map((f) => `${f.attribute} ${f.valueThen}`).join(" ");
  if (/price|pricing|plan|tier|cost|\$|€|£|free/i.test(attrs)) return "pricing";
  if (/release|version|launch|feature|changelog/i.test(attrs)) return "release notes changelog";
  return "latest changes";
}
