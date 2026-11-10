import * as chrono from "chrono-node";
import {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  addDays,
  describeDate,
  lastWeekday,
  localDateStr,
  mostRecentMonthDay,
  parseDateStr,
  weekdayOf,
} from "./dates.js";

export interface DateWindow {
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
}

export interface TemporalAnchor {
  /** The phrase as the user wrote it. */
  phrase: string;
  /** Human-readable resolution, e.g. "Tuesday 3 November 2026". */
  label: string;
  /** Priority-ordered candidate windows; the assembler uses the first one that has recorded history. */
  windows: DateWindow[];
  /** True when the phrase was introduced by "since". */
  since: boolean;
}

export interface TemporalResolution {
  now: string;
  anchors: TemporalAnchor[];
  /** Content keywords for FTS recall (temporal phrases and stopwords removed). */
  keywords: string[];
  /** The prompt refers back to earlier conversation ("still correct", "since then", ...). */
  recallCue: boolean;
  /** "since then" / "since last time" without an explicit date. */
  sinceThen: boolean;
}

const WEEKDAY_LOOKUP: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, tues: 2, wednesday: 3, thursday: 4, thurs: 4, friday: 5, saturday: 6,
};
const MONTH_LOOKUP: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2,
};

const WEEKDAY_RE = "(?:sunday|monday|tuesday|tues|wednesday|thursday|thurs|friday|saturday)";
const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

interface Hit {
  start: number;
  end: number;
  anchor: TemporalAnchor;
}

const overlaps = (hits: Hit[], s: number, e: number) => hits.some((h) => s < h.end && e > h.start);

function dayAnchor(phrase: string, date: string, since: boolean, extra: DateWindow[] = []): TemporalAnchor {
  return { phrase, label: describeDate(date), windows: [{ start: date, end: date }, ...extra], since };
}

function isoDay(year: number, month: number, day: number): string | null {
  const d = new Date(year, month - 1, day, 12);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return localDateStr(d);
}

/**
 * Deterministically resolve temporal expressions in `text` relative to `now`.
 * Custom rules handle the anchors that matter most (weekdays, "3 November", relative days/weeks);
 * chrono-node is the fallback for anything else it can pin to a concrete day.
 */
export function resolveTemporal(text: string, now: Date): TemporalResolution {
  const today = localDateStr(now);
  const hits: Hit[] = [];
  const add = (m: RegExpMatchArray, anchor: TemporalAnchor) => {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (!overlaps(hits, start, end)) hits.push({ start, end, anchor });
  };
  const sinceBefore = (index: number) => /\bsince\s+(?:the\s+)?(?:last\s+)?$/i.test(text.slice(Math.max(0, index - 20), index));

  // 1. ISO dates: 2026-11-03
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const iso = isoDay(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) add(m, dayAnchor(m[0], iso, sinceBefore(m.index ?? 0)));
  }

  // 2. "3 November", "3rd of Nov 2025", "Tuesday, 3 November"
  const dayFirst = new RegExp(
    `\\b(?:${WEEKDAY_RE},?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\.?(?:,?\\s+(\\d{4}))?\\b`,
    "gi",
  );
  // 3. "November 3rd", "Nov 3, 2025"
  const monthFirst = new RegExp(
    `\\b(?:${WEEKDAY_RE},?\\s+)?(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`,
    "gi",
  );
  const namedDate = (m: RegExpMatchArray, monthStr: string, dayStr: string, yearStr?: string) => {
    const month = MONTH_LOOKUP[monthStr.toLowerCase()];
    const day = Number(dayStr);
    if (!month || day < 1 || day > 31) return;
    const iso = yearStr ? isoDay(Number(yearStr), month, day) : mostRecentMonthDay(today, month, day);
    if (!iso) return;
    // Without a year, also consider the year before in case nothing was recorded on the first guess.
    const prior = yearStr ? [] : [{ start: addYear(iso, -1), end: addYear(iso, -1) }];
    add(m, dayAnchor(m[0], iso, sinceBefore(m.index ?? 0), prior));
  };
  for (const m of text.matchAll(dayFirst)) namedDate(m, m[2] as string, m[1] as string, m[3]);
  for (const m of text.matchAll(monthFirst)) namedDate(m, m[1] as string, m[2] as string, m[3]);

  // 4. Relative expressions
  for (const m of text.matchAll(/\bday before yesterday\b/gi)) add(m, dayAnchor(m[0], addDays(today, -2), false));
  for (const m of text.matchAll(/\b(?:yesterday|last night)\b/gi)) {
    add(m, dayAnchor(m[0], addDays(today, -1), sinceBefore(m.index ?? 0)));
  }
  for (const m of text.matchAll(/\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|couple of)\s+(day|week|month)s?\s+ago\b/gi)) {
    const raw = (m[1] as string).toLowerCase().replace(/ of$/, "");
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw] ?? 1;
    const unit = (m[2] as string).toLowerCase();
    const center = addDays(today, -n * (unit === "day" ? 1 : unit === "week" ? 7 : 30));
    const pad = unit === "day" ? 0 : unit === "week" ? 3 : 15;
    add(m, {
      phrase: m[0],
      label: pad ? `around ${describeDate(center)} (±${pad} days)` : describeDate(center),
      windows: [{ start: addDays(center, -pad), end: addDays(center, pad) }],
      since: sinceBefore(m.index ?? 0),
    });
  }
  for (const m of text.matchAll(/\b(?:last|past|previous)\s+week\b/gi)) {
    const monThis = addDays(today, -((weekdayOf(today) + 6) % 7));
    const start = addDays(monThis, -7);
    add(m, { phrase: m[0], label: `week of ${describeDate(start)}`, windows: [{ start, end: addDays(start, 6) }], since: false });
  }
  for (const m of text.matchAll(/\bthis\s+week\b/gi)) {
    const start = addDays(today, -((weekdayOf(today) + 6) % 7));
    add(m, { phrase: m[0], label: `this week (from ${describeDate(start)})`, windows: [{ start, end: today }], since: false });
  }
  for (const m of text.matchAll(/\b(?:last|past|previous)\s+month\b/gi)) {
    const t = parseDateStr(today);
    const first = new Date(t.getFullYear(), t.getMonth() - 1, 1, 12);
    const last = new Date(t.getFullYear(), t.getMonth(), 0, 12);
    add(m, {
      phrase: m[0],
      label: `${MONTH_NAMES[first.getMonth()]} ${first.getFullYear()}`,
      windows: [{ start: localDateStr(first), end: localDateStr(last) }],
      since: false,
    });
  }

  // 5. Weekdays: "On Monday", "last Tuesday", "since Friday".
  //    Primary = most recent such weekday strictly before today; the week before that is kept as a fallback so
  //    "last Tuesday" can never miss whether today is Tuesday or Wednesday.
  const weekdayRe = new RegExp(`\\b(?:(last|past|previous|this past|since|on|from)\\s+)?(${WEEKDAY_RE})\\b`, "gi");
  for (const m of text.matchAll(weekdayRe)) {
    const dow = WEEKDAY_LOOKUP[(m[2] as string).toLowerCase()];
    if (dow === undefined) continue;
    const primary = lastWeekday(today, dow);
    const secondary = addDays(primary, -7);
    add(m, {
      phrase: m[0],
      label: `${describeDate(primary)} (fallback ${describeDate(secondary)})`,
      windows: [
        { start: primary, end: primary },
        { start: secondary, end: secondary },
      ],
      since: (m[1] ?? "").toLowerCase() === "since",
    });
  }

  // 6. chrono fallback for anything else with a concrete day/month.
  if (!hits.length) {
    for (const r of chrono.en.GB.parse(text, now, { forwardDate: false })) {
      if (!r.start.isCertain("day") && !r.start.isCertain("month")) continue;
      const iso = localDateStr(r.start.date());
      if (iso >= today) continue;
      const m = [r.text] as unknown as RegExpMatchArray;
      m.index = r.index;
      add(m, dayAnchor(r.text, iso, sinceBefore(r.index)));
    }
  }

  hits.sort((a, b) => a.start - b.start);
  const anchors = hits.map((h) => h.anchor);

  // Keyword extraction on the text with temporal spans blanked out.
  let rest = text;
  for (const h of [...hits].reverse()) rest = rest.slice(0, h.start) + " " + rest.slice(h.end);

  return {
    now: today,
    anchors,
    keywords: extractKeywords(rest),
    recallCue: RECALL_CUE.test(text),
    sinceThen: /\bsince\s+(?:then|that|last\s+time|we\s+(?:spoke|talked|chatted))\b/i.test(text),
  };
}

function addYear(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-") as [string, string, string];
  return `${Number(y) + delta}-${m}-${d}`;
}

const RECALL_CUE =
  /\b(earlier|before|previous(?:ly)?|last\s+time|again|since|still|(?:has|have|had|did|does)\b.{0,40}\bchang(?:e|ed)|updated?|ago|we\s+(?:discussed|shortlisted|talked|looked|compared|chose|picked)|i\s+(?:asked|told|said|mentioned)|you\s+(?:said|told|recommended|suggested|answered|gave)|our\s+(?:chat|conversation|discussion)|back\s+then|as\s+of|correct\s+today|still\s+(?:correct|true|valid|accurate))\b/i;

const STOPWORDS = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in into is it its just me my of on or our out so than that the their them then there these they this to up us was we were what when where which who why will with would you your about any anything something some tell show give need want please also again still since last next today now new latest current currently ask asked question answer answers said told ago shortlisted shortlist changed change changes pricing price prices shipped ship big team people tools tool`.split(
    /\s+/,
  ),
);

/** Domain terms worth keeping even when short. */
const KEEP_SHORT = new Set(["crm", "sql", "aws", "rds", "gpu", "llm", "api", "sdk", "ai", "ml", "ci", "cd"]);

export function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9+.#-]*/g) ?? []) {
    const w = raw.replace(/[.-]+$/g, "");
    if (STOPWORDS.has(w) || (w.length < 3 && !KEEP_SHORT.has(w))) continue;
    if (WEEKDAY_NAMES.some((d) => d.toLowerCase() === w) || MONTH_LOOKUP[w] !== undefined) continue;
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out.slice(0, 8);
}

/** Build a safe FTS5 expression from keywords: `"crm"* OR "postgres"*`. */
export function toFtsQuery(keywords: string[]): string | null {
  const terms = keywords.map((k) => k.replace(/[^a-z0-9]/gi, "")).filter((k) => k.length >= 2);
  return terms.length ? terms.map((t) => `"${t}"*`).join(" OR ") : null;
}
