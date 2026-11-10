import test from "node:test";
import assert from "node:assert/strict";
import { resolveTemporal } from "../src/memory/temporal-resolver.js";
import { localDateStr } from "../src/memory/dates.js";

const at = (s: string) => new Date(`${s}T15:00:00`);
const first = (text: string, now: string) => resolveTemporal(text, at(now)).anchors[0]?.windows[0];

test("'On Monday' resolves to the most recent prior Monday", () => {
  assert.deepEqual(first("On Monday we shortlisted 5 CRM tools", "2026-11-10"), { start: "2026-11-09", end: "2026-11-09" });
  assert.deepEqual(first("On Monday we shortlisted 5 CRM tools", "2026-11-12"), { start: "2026-11-09", end: "2026-11-09" });
  // Today is Monday → the previous Monday, never "today".
  assert.deepEqual(first("On Monday we shortlisted", "2026-11-09"), { start: "2026-11-02", end: "2026-11-02" });
});

test("'last Tuesday' includes primary and prior-week fallback on any weekday", () => {
  for (const today of ["2026-11-10", "2026-11-11", "2026-11-14", "2026-11-16"]) {
    const a = resolveTemporal("Last Tuesday I asked you about Postgres hosting", at(today)).anchors[0]!;
    assert.equal(a.windows.length, 2);
    assert.equal(new Date(`${a.windows[0]!.start}T12:00:00`).getDay(), 2);
    assert.equal(a.windows[1]!.start, localDateStr(new Date(new Date(`${a.windows[0]!.start}T12:00:00`).getTime() - 7 * 86400000)));
    assert.ok(a.windows[0]!.start < today);
  }
  assert.equal(first("last Tuesday", "2026-11-10")?.start, "2026-11-03");
  assert.equal(first("last Tuesday", "2026-11-11")?.start, "2026-11-10");
});

test("'3 November' variants resolve to the most recent Nov 3", () => {
  for (const t of ["3 November", "Nov 3", "November 3rd", "3rd of Nov", "Tuesday, 3 November"]) {
    assert.equal(first(`What did I ask you on ${t}?`, "2026-11-10")?.start, "2026-11-03", t);
    assert.equal(first(`What did I ask you on ${t}?`, "2026-02-01")?.start, "2025-11-03", t);
    assert.equal(first(`What did I ask you on ${t}?`, "2026-11-03")?.start, "2026-11-03", t);
  }
  assert.equal(first("on 3 November 2024", "2026-11-10")?.start, "2024-11-03");
  assert.equal(first("on 2025-03-07", "2026-11-10")?.start, "2025-03-07");
});

test("relative expressions", () => {
  assert.equal(first("what did we discuss yesterday", "2026-11-10")?.start, "2026-11-09");
  assert.equal(first("3 days ago", "2026-11-10")?.start, "2026-11-07");
  assert.deepEqual(first("last week", "2026-11-10"), { start: "2026-11-02", end: "2026-11-08" });
  assert.deepEqual(first("last month", "2026-11-10"), { start: "2026-10-01", end: "2026-10-31" });
  assert.deepEqual(first("two weeks ago", "2026-11-10"), { start: "2026-10-24", end: "2026-10-30" });
  assert.equal(resolveTemporal("Is it still correct today?", at("2026-11-10")).anchors.length, 0);
});

test("'since' anchors and recall cues; keywords exclude temporal words", () => {
  const r = resolveTemporal("Has any pricing changed since Monday for HubSpot?", at("2026-11-10"));
  assert.equal(r.anchors[0]?.since, true);
  assert.ok(r.recallCue);
  assert.deepEqual(r.keywords.slice(0, 1), ["hubspot"]);
  assert.ok(!r.keywords.includes("monday"));
  assert.ok(resolveTemporal("anything new since then?", at("2026-11-10")).sinceThen);
  assert.ok(!resolveTemporal("What is Rust?", at("2026-11-10")).recallCue);
});

test("no false positives on ordinary words", () => {
  assert.equal(resolveTemporal("I need 2 decks and a novel on sat nav", at("2026-11-10")).anchors.length, 0);
});
