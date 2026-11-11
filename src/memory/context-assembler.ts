import type { FactRow, MessageRow, Store } from "./db.js";
import { describeDate } from "./dates.js";
import { resolveTemporal, toFtsQuery, type TemporalResolution } from "./temporal-resolver.js";

export interface StatusNote {
  icon: string;
  text: string;
}

export interface AssembledContext {
  /** `<episodic_memory>` block for the system prompt, or null when nothing is relevant. */
  block: string | null;
  notes: StatusNote[];
  resolution: TemporalResolution;
  messageCount: number;
  factCount: number;
  /** The fact snapshots injected into the block (the "then" side of a diff). */
  facts: FactRow[];
}

const MAX_MESSAGES = 16;
const MAX_FACTS = 60;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [truncated]` : s);
const esc = (s: string) => s.replace(/</g, "&lt;");

/**
 * Pre-flight context assembly: runs before the LLM sees the turn, entirely in-process (SQLite), so memory costs
 * no tool-call round trip. Resolves temporal anchors → queries the day index → falls back to FTS5 keyword recall
 * → attaches the fact snapshots recorded on those turns.
 */
export function assembleContext(store: Store, userText: string, now: Date): AssembledContext {
  const resolution = resolveTemporal(userText, now);
  const notes: StatusNote[] = [];
  const picked = new Map<string, MessageRow>();
  const missing: string[] = [];
  let method = "";

  // 1. Date-anchored recall.
  for (const anchor of resolution.anchors) {
    let hit: MessageRow[] = [];
    let usedWindow = anchor.windows[0];
    for (const w of anchor.windows) {
      hit = store.messagesBetween(w.start, w.end);
      usedWindow = w;
      if (hit.length) break;
    }
    const range = usedWindow && usedWindow.start !== usedWindow.end ? `${usedWindow.start} → ${usedWindow.end}` : usedWindow?.start;
    notes.push({
      icon: "🕒",
      text: `Resolved “${anchor.phrase}” → ${range ?? anchor.label}${hit.length ? ` · ${hit.length} recorded messages` : " · nothing recorded"}`,
    });
    if (hit.length) for (const m of hit) picked.set(m.id, m);
    else missing.push(`${anchor.phrase} (${anchor.label})`);
  }
  if (picked.size) method = "date";

  // Several conversations can share a date (e.g. "last Tuesday" == "3 November"). When the prompt names a topic,
  // keep only the sessions that mention it; with no topic words, keep them all and let the model disambiguate.
  if (picked.size && resolution.keywords.length) {
    const sessions = new Set([...picked.values()].map((m) => m.sessionId));
    if (sessions.size > 1) {
      const relevant = new Set<string>();
      for (const m of picked.values()) {
        const text = m.content.toLowerCase();
        if (resolution.keywords.some((k) => text.includes(k))) relevant.add(m.sessionId);
      }
      if (relevant.size && relevant.size < sessions.size) {
        for (const [id, m] of picked) if (!relevant.has(m.sessionId)) picked.delete(id);
        notes.push({ icon: "🎯", text: `Several conversations share that date; kept the ${relevant.size} matching “${resolution.keywords.slice(0, 3).join(", ")}”` });
      }
    }
  }

  // 2. Keyword recall (BM25 over FTS5) when there is no usable date anchor, but the prompt refers back.
  const needsKeywordRecall = !picked.size && (resolution.recallCue || resolution.anchors.length > 0);
  if (needsKeywordRecall) {
    const q = toFtsQuery(resolution.keywords);
    if (q) {
      const hits = store.searchMessages(q, 6);
      for (const m of hits) picked.set(m.id, m);
      if (hits.length) {
        method = "keyword";
        notes.push({ icon: "🧠", text: `Keyword recall (${resolution.keywords.slice(0, 4).join(", ")}) → ${hits.length} matching messages` });
      }
    }
  }

  // 3. "since then" with nothing else to go on → most recent prior day(s).
  if (!picked.size && resolution.sinceThen) {
    const days = store.recentDaysBefore(resolution.now, 1);
    for (const d of days) for (const m of store.messagesBetween(d, d)) picked.set(m.id, m);
    if (picked.size) {
      method = "recent";
      notes.push({ icon: "🕒", text: `“since then” → most recent prior conversation (${days[0]})` });
    }
  }

  // Pull the user message together with its answer so a hit on either side yields the whole exchange.
  const pairs = new Map<string, MessageRow>(picked);
  for (const m of picked.values()) {
    const sibling = siblingOf(store, m);
    if (sibling) pairs.set(sibling.id, sibling);
  }
  const messages = [...pairs.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_MESSAGES);

  const facts = collectFacts(store, messages, resolution);

  if (!messages.length) {
    const dates = store.allDates();
    const block = missing.length || resolution.anchors.length
      ? `<episodic_memory>\n<no_match>No recorded conversation matches ${esc(missing.join("; ") || "the referenced time")}. Dates that DO have history: ${
          dates.length ? dates.join(", ") : "none (memory is empty)"
        }. Say so plainly; do not invent a past conversation.</no_match>\n</episodic_memory>`
      : null;
    if (block) notes.push({ icon: "🗂️", text: `No history on that date · memory holds ${dates.length} day(s)` });
    return { block, notes, resolution, messageCount: 0, factCount: 0, facts: [] };
  }

  notes.push({
    icon: "🧠",
    text: `Hydrated ${messages.length} past messages${facts.length ? ` + ${facts.length} fact snapshots` : ""} into context (${method})`,
  });

  return {
    block: renderBlock(messages, facts, resolution),
    notes,
    resolution,
    messageCount: messages.length,
    factCount: facts.length,
    facts,
  };
}

function siblingOf(store: Store, m: MessageRow): MessageRow | undefined {
  const row = store.db
    .prepare(
      m.role === "user"
        ? `SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' AND rowid > (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid LIMIT 1`
        : `SELECT id FROM messages WHERE session_id = ? AND role = 'user' AND rowid < (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid DESC LIMIT 1`,
    )
    .get(m.sessionId, m.id) as { id: string } | undefined;
  return row ? store.messageById(row.id) : undefined;
}

function collectFacts(store: Store, messages: MessageRow[], res: TemporalResolution): FactRow[] {
  const byId = new Map<string, FactRow>();
  for (const f of store.factsForMessages(messages.map((m) => m.id))) byId.set(f.id, f);
  // Entity-name matches add baselines recorded on other turns (e.g. the same vendor quoted on two dates).
  if (byId.size < 10) {
    for (const f of store.factsByEntityTerms(res.keywords.slice(0, 4), 20)) byId.set(f.id, f);
  }
  return [...byId.values()].slice(0, MAX_FACTS);
}

function renderBlock(messages: MessageRow[], facts: FactRow[], res: TemporalResolution): string {
  const factsByMessage = new Map<string, FactRow[]>();
  const leftovers: FactRow[] = [];
  const ids = new Set(messages.map((m) => m.id));
  for (const f of facts) {
    if (ids.has(f.messageId)) {
      const list = factsByMessage.get(f.messageId) ?? [];
      list.push(f);
      factsByMessage.set(f.messageId, list);
    } else leftovers.push(f);
  }

  const renderFacts = (list: FactRow[]) =>
    list
      .map((f) => `  - ${esc(f.entity)} | ${esc(f.attribute)} | ${esc(f.valueThen)} | source: ${f.sourceUrl ?? "n/a"} | recorded ${f.recordedDate}`)
      .join("\n");

  const parts: string[] = [];
  parts.push(`<episodic_memory today="${res.now}">`);
  if (res.anchors.length) {
    parts.push(
      `<resolution>${res.anchors.map((a) => `“${esc(a.phrase)}” = ${esc(a.label)}${a.since ? " [since-anchor: compare then vs now]" : ""}`).join("; ")}</resolution>`,
    );
  }
  for (const m of messages) {
    const when = new Date(m.createdAt);
    const stamp = `${describeDate(m.dateBucket)} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    const tag = m.role === "user" ? "user_question" : "assistant_answer";
    parts.push(`<${tag} at="${stamp}" date="${m.dateBucket}">\n${esc(clip(m.content, m.role === "user" ? 800 : 3500))}\n</${tag}>`);
    const mf = factsByMessage.get(m.id);
    if (mf?.length) parts.push(`<fact_snapshots message_date="${m.dateBucket}">\n${renderFacts(mf)}\n</fact_snapshots>`);
  }
  if (leftovers.length) parts.push(`<related_fact_snapshots>\n${renderFacts(leftovers)}\n</related_fact_snapshots>`);
  parts.push(`</episodic_memory>`);
  return parts.join("\n");
}
