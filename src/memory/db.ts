import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { localDateStr } from "./dates.js";

export interface Source {
  title: string;
  url: string;
}

export interface MessageRow {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  dateBucket: string;
  sources: Source[];
}

export interface FactRow {
  id: string;
  messageId: string;
  entity: string;
  attribute: string;
  valueThen: string;
  sourceUrl: string | null;
  recordedDate: string;
  createdAt: string;
}

export interface NewFact {
  entity: string;
  attribute: string;
  value: string;
  sourceUrl?: string | null;
}

export interface DaySummary {
  date: string;
  messageCount: number;
  factCount: number;
  firstQuestion: string;
  sessions: string[];
  seeded: boolean;
}

interface RawMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  date_bucket: string;
  sources_json: string | null;
}

interface RawFact {
  id: string;
  message_id: string;
  entity: string;
  attribute: string;
  value_then: string;
  source_url: string | null;
  recorded_date: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  date_bucket TEXT NOT NULL,
  sources_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_bucket  ON messages(date_bucket);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  message_id UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS fact_snapshots (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL,
  entity        TEXT NOT NULL,
  attribute     TEXT NOT NULL,
  value_then    TEXT NOT NULL,
  source_url    TEXT,
  recorded_date TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_message ON fact_snapshots(message_id);
CREATE INDEX IF NOT EXISTS idx_facts_entity  ON fact_snapshots(entity COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_facts_date    ON fact_snapshots(recorded_date);
`;

const toMessage = (r: RawMessage): MessageRow => ({
  id: r.id,
  sessionId: r.session_id,
  role: r.role,
  content: r.content,
  createdAt: r.created_at,
  dateBucket: r.date_bucket,
  sources: r.sources_json ? (JSON.parse(r.sources_json) as Source[]) : [],
});

const toFact = (r: RawFact): FactRow => ({
  id: r.id,
  messageId: r.message_id,
  entity: r.entity,
  attribute: r.attribute,
  valueThen: r.value_then,
  sourceUrl: r.source_url,
  recordedDate: r.recorded_date,
  createdAt: r.created_at,
});

/** SQLite-backed episodic store: messages, an FTS5 index over them, and the fact snapshot ledger. */
export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  insertMessage(m: {
    id?: string;
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    createdAt: Date;
    sources?: Source[];
  }): MessageRow {
    const id = m.id ?? crypto.randomUUID();
    const row = {
      id,
      session_id: m.sessionId,
      role: m.role,
      content: m.content,
      created_at: m.createdAt.toISOString(),
      date_bucket: localDateStr(m.createdAt),
      sources_json: m.sources?.length ? JSON.stringify(m.sources) : null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, created_at, date_bucket, sources_json)
           VALUES (@id, @session_id, @role, @content, @created_at, @date_bucket, @sources_json)`,
        )
        .run(row);
      this.db.prepare(`INSERT INTO messages_fts (content, message_id) VALUES (?, ?)`).run(m.content, id);
    })();
    return toMessage(row);
  }

  /** Messages whose local calendar day falls in [startDate, endDate], oldest first. */
  messagesBetween(startDate: string, endDate: string): MessageRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM messages WHERE date_bucket BETWEEN ? AND ? ORDER BY created_at, rowid`,
        )
        .all(startDate, endDate) as RawMessage[]
    ).map(toMessage);
  }

  /** BM25-ranked keyword recall. `ftsQuery` must already be a valid FTS5 expression. */
  searchMessages(ftsQuery: string, limit = 8): MessageRow[] {
    try {
      return (
        this.db
          .prepare(
            `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.message_id
             WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?`,
          )
          .all(ftsQuery, limit) as RawMessage[]
      ).map(toMessage);
    } catch {
      return [];
    }
  }

  sessionMessages(sessionId: string, limit = 12): MessageRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`)
      .all(sessionId, limit) as RawMessage[];
    return rows.reverse().map(toMessage);
  }

  messageById(id: string): MessageRow | undefined {
    const r = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as RawMessage | undefined;
    return r ? toMessage(r) : undefined;
  }

  insertFacts(messageId: string, facts: NewFact[], recordedDate: string): number {
    const stmt = this.db.prepare(
      `INSERT INTO fact_snapshots (id, message_id, entity, attribute, value_then, source_url, recorded_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const f of facts) {
        stmt.run(crypto.randomUUID(), messageId, f.entity, f.attribute, f.value, f.sourceUrl ?? null, recordedDate, now);
      }
    })();
    return facts.length;
  }

  factsForMessages(ids: string[]): FactRow[] {
    if (!ids.length) return [];
    const marks = ids.map(() => "?").join(",");
    return (
      this.db
        .prepare(`SELECT * FROM fact_snapshots WHERE message_id IN (${marks}) ORDER BY recorded_date, entity, attribute`)
        .all(...ids) as RawFact[]
    ).map(toFact);
  }

  factsByEntityTerms(terms: string[], limit = 30): FactRow[] {
    if (!terms.length) return [];
    const clause = terms.map(() => "(entity LIKE ? COLLATE NOCASE OR attribute LIKE ? COLLATE NOCASE)").join(" OR ");
    const args = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
    return (
      this.db
        .prepare(`SELECT * FROM fact_snapshots WHERE ${clause} ORDER BY recorded_date DESC LIMIT ?`)
        .all(...args, limit) as RawFact[]
    ).map(toFact);
  }

  listDays(): DaySummary[] {
    const days = this.db
      .prepare(
        `SELECT date_bucket AS date, COUNT(*) AS messageCount FROM messages GROUP BY date_bucket ORDER BY date_bucket DESC`,
      )
      .all() as { date: string; messageCount: number }[];
    return days.map((d) => {
      const msgs = this.messagesBetween(d.date, d.date);
      const first = msgs.find((m) => m.role === "user");
      const factCount = (
        this.db
          .prepare(`SELECT COUNT(*) AS c FROM fact_snapshots WHERE message_id IN (SELECT id FROM messages WHERE date_bucket = ?)`)
          .get(d.date) as { c: number }
      ).c;
      const sessions = [...new Set(msgs.map((m) => m.sessionId))];
      return {
        date: d.date,
        messageCount: d.messageCount,
        factCount,
        firstQuestion: first?.content.slice(0, 140) ?? "",
        sessions,
        seeded: sessions.length > 0 && sessions.every((s) => s.startsWith("seed-")),
      };
    });
  }

  allDates(): string[] {
    return (
      this.db.prepare(`SELECT DISTINCT date_bucket AS d FROM messages ORDER BY d`).all() as { d: string }[]
    ).map((r) => r.d);
  }

  recentDaysBefore(date: string, n: number): string[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT date_bucket AS d FROM messages WHERE date_bucket < ? ORDER BY d DESC LIMIT ?`)
        .all(date, n) as { d: string }[]
    ).map((r) => r.d);
  }

  countMessages(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM messages`).get() as { c: number }).c;
  }

  countFacts(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM fact_snapshots`).get() as { c: number }).c;
  }

  /** Delete every message (and its facts + FTS rows) whose session id starts with `prefix`. */
  deleteSessionsWithPrefix(prefix: string): void {
    const like = `${prefix}%`;
    this.db.transaction(() => {
      const ids = `SELECT id FROM messages WHERE session_id LIKE ?`;
      this.db.prepare(`DELETE FROM fact_snapshots WHERE message_id IN (${ids})`).run(like);
      this.db.prepare(`DELETE FROM messages_fts WHERE message_id IN (${ids})`).run(like);
      this.db.prepare(`DELETE FROM messages WHERE session_id LIKE ?`).run(like);
    })();
  }

  reset(): void {
    this.db.transaction(() => {
      this.db.exec(`DELETE FROM fact_snapshots; DELETE FROM messages_fts; DELETE FROM messages;`);
    })();
  }
}
