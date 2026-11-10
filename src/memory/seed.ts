import type { NewFact, Source, Store } from "./db.js";
import { atLocalTime, describeDate, lastWeekday, localDateStr, mostRecentMonthDay } from "./dates.js";

/**
 * Benchmark seeder. Plants three deterministic historical conversations anchored to the *current* calendar so the
 * challenge prompts work on any day:
 *   - the most recent Monday  → 5-CRM shortlist for a 20-person sales team
 *   - the most recent 3 Nov   → hosted-LLM inference pricing question
 *   - last Tuesday            → Postgres hosting comparison
 *
 * The numbers are illustrative baselines, NOT live-verified: they exist so "has anything changed since?" has a
 * recorded "then" to diff against. The agent always verifies the "now" side with live web search.
 */

interface SeedEpisode {
  sessionId: string;
  date: string;
  hour: number;
  minute: number;
  question: string;
  intro: string;
  facts: (NewFact & { sourceUrl: string })[];
  outro: string;
}

const title = (s: string) => s.replace(/\bhttps?:\/\/(www\.)?/, "");

function renderAnswer(ep: SeedEpisode): string {
  const rows = ep.facts.map((f) => `| ${f.entity} | ${f.attribute} | ${f.value} | [Source](${f.sourceUrl}) |`);
  return [ep.intro, "", "| Entity | Attribute | Value (as of then) | Source |", "|---|---|---|---|", ...rows, "", ep.outro].join("\n");
}

function episodes(now: Date): SeedEpisode[] {
  const today = localDateStr(now);
  const monday = lastWeekday(today, 1);
  const tuesday = lastWeekday(today, 2);
  const nov3 = mostRecentMonthDay(today, 11, 3);

  return [
    {
      sessionId: "seed-crm-shortlist",
      date: monday,
      hour: 10,
      minute: 12,
      question:
        "We're a 20-person sales team and need a CRM. Shortlist 5 tools worth evaluating and give me per-seat pricing and what each is best at.",
      intro: `Here is the shortlist I'd evaluate for a 20-seat sales team (pricing as I found it on ${describeDate(monday)}; per seat per month, billed annually):`,
      facts: [
        { entity: "HubSpot Sales Hub", attribute: "Starter price", value: "$15/seat/mo (annual)", sourceUrl: "https://www.hubspot.com/pricing/sales" },
        { entity: "HubSpot Sales Hub", attribute: "Professional price", value: "$90/seat/mo (annual) + $1,500 one-time onboarding; 5 seats minimum", sourceUrl: "https://www.hubspot.com/pricing/sales" },
        { entity: "Pipedrive", attribute: "Advanced price", value: "$24/user/mo (annual)", sourceUrl: "https://www.pipedrive.com/en/pricing" },
        { entity: "Pipedrive", attribute: "Professional price", value: "$49/user/mo (annual); includes AI email assistant", sourceUrl: "https://www.pipedrive.com/en/pricing" },
        { entity: "Attio", attribute: "Plus price", value: "$29/seat/mo (annual)", sourceUrl: "https://attio.com/pricing" },
        { entity: "Attio", attribute: "Pro price", value: "$59/seat/mo (annual); free plan limited to 3 seats", sourceUrl: "https://attio.com/pricing" },
        { entity: "Close", attribute: "Growth price", value: "$59/user/mo (annual); built-in calling + sequences", sourceUrl: "https://www.close.com/pricing" },
        { entity: "Close", attribute: "Scale price", value: "$109/user/mo (annual); power dialer + predictive dialing", sourceUrl: "https://www.close.com/pricing" },
        { entity: "Folk", attribute: "Standard price", value: "$20/member/mo (annual)", sourceUrl: "https://www.folk.app/pricing" },
        { entity: "Folk", attribute: "Premium price", value: "$40/member/mo (annual); sequences + advanced enrichment", sourceUrl: "https://www.folk.app/pricing" },
      ],
      outro:
        "**Best fit by need:** HubSpot (all-in-one, strongest ecosystem, costly at Professional), Pipedrive (simple pipeline-first), Attio (flexible data model for modern teams), Close (calling-heavy inside sales), Folk (lightweight relationship CRM). For 20 seats, annual cost at the mid tier ranges from about $5.8k (Folk Standard) to $21.6k+ (HubSpot Professional with onboarding).",
    },
    {
      sessionId: "seed-nov3-inference",
      date: nov3,
      hour: 9,
      minute: 41,
      question:
        "What's the cheapest hosted API for Llama 3.3 70B right now? I need price per million tokens and rough speed for a customer-support summarizer.",
      intro: `Snapshot of hosted Llama 3.3 70B pricing as of ${describeDate(nov3)} (USD per 1M tokens):`,
      facts: [
        { entity: "Groq", attribute: "Llama 3.3 70B price", value: "$0.59 input / $0.79 output per 1M tokens; very high tokens/sec", sourceUrl: "https://groq.com/pricing" },
        { entity: "Together AI", attribute: "Llama 3.3 70B Turbo price", value: "$0.88 per 1M tokens (input and output)", sourceUrl: "https://www.together.ai/pricing" },
        { entity: "Fireworks AI", attribute: "Llama 3.3 70B price", value: "$0.90 per 1M tokens (input and output)", sourceUrl: "https://fireworks.ai/pricing" },
        { entity: "DeepInfra", attribute: "Llama 3.3 70B price", value: "$0.23 input / $0.40 output per 1M tokens", sourceUrl: "https://deepinfra.com/pricing" },
      ],
      outro:
        "**Takeaway:** DeepInfra was cheapest on raw token price; Groq was the fastest. For a summarizer with short outputs, input price dominates, so DeepInfra or Groq are the two to benchmark. These prices move often, so re-check before committing.",
    },
    {
      sessionId: "seed-postgres-hosting",
      date: tuesday,
      hour: 14,
      minute: 30,
      question:
        "We're picking managed Postgres hosting for a SaaS app (~50 GB, light traffic, need backups). Compare Supabase, Neon, AWS RDS, Render and Railway on price.",
      intro: `Managed Postgres comparison, pricing as of ${describeDate(tuesday)}:`,
      facts: [
        { entity: "Supabase", attribute: "Pro plan price", value: "$25/mo per project incl. $10 compute credit; 8 GB database, 100 GB file storage; extra DB storage $0.125/GB", sourceUrl: "https://supabase.com/pricing" },
        { entity: "Supabase", attribute: "Free tier limit", value: "500 MB database, projects pause after 1 week of inactivity", sourceUrl: "https://supabase.com/pricing" },
        { entity: "Neon", attribute: "Launch plan price", value: "$19/mo, 10 GB storage included, usage-based compute", sourceUrl: "https://neon.com/pricing" },
        { entity: "Neon", attribute: "Free tier limit", value: "0.5 GB storage per project, 191.9 compute hours/mo", sourceUrl: "https://neon.com/pricing" },
        { entity: "AWS RDS", attribute: "db.t4g.micro PostgreSQL price", value: "≈$0.016/hr (~$12/mo) + gp3 storage $0.115/GB-mo (50 GB ≈ $5.75) + backup beyond free allocation", sourceUrl: "https://aws.amazon.com/rds/postgresql/pricing/" },
        { entity: "Render", attribute: "Basic-256mb Postgres price", value: "$6/mo + storage $0.30/GB-mo", sourceUrl: "https://render.com/pricing" },
        { entity: "Railway", attribute: "Hobby plan price", value: "$5/mo subscription incl. $5 usage; then usage-based (about $0.25/GB-mo volume)", sourceUrl: "https://railway.com/pricing" },
      ],
      outro:
        "**Takeaway:** for 50 GB and light traffic, RDS and Railway were cheapest on paper, Supabase Pro gives the most batteries-included value (auth, storage, APIs), and Neon is best when you want branching and scale-to-zero.",
    },
  ];
}

export interface SeedResult {
  episodes: { session: string; date: string; facts: number }[];
}

export function seedBenchmark(store: Store, now: Date = new Date()): SeedResult {
  store.deleteSessionsWithPrefix("seed-");
  const result: SeedResult = { episodes: [] };
  for (const ep of episodes(now)) {
    const asked = atLocalTime(ep.date, ep.hour, ep.minute);
    const answered = new Date(asked.getTime() + 9_000);
    const sources: Source[] = [...new Map(ep.facts.map((f) => [f.sourceUrl, { title: title(f.sourceUrl), url: f.sourceUrl }])).values()];
    store.insertMessage({ sessionId: ep.sessionId, role: "user", content: ep.question, createdAt: asked });
    const reply = store.insertMessage({ sessionId: ep.sessionId, role: "assistant", content: renderAnswer(ep), createdAt: answered, sources });
    store.insertFacts(reply.id, ep.facts, ep.date);
    result.episodes.push({ session: ep.sessionId, date: ep.date, facts: ep.facts.length });
  }
  return result;
}
