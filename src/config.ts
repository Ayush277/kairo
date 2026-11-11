import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LlmProviderName = "anthropic" | "openai";
export type SearchProviderName = "tavily" | "serper" | "exa" | "duckduckgo";

/** Read an env var; treat blanks and copy-pasted `.env.example` placeholders (`sk-...`) as unset. */
function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  if (!v || v.endsWith("...")) return undefined;
  return v;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveLlm() {
  const anthropicKey = env("ANTHROPIC_API_KEY");
  const openaiKey = env("OPENAI_API_KEY");
  const forced = env("LLM_PROVIDER");
  let provider: LlmProviderName | null = null;
  if (forced === "openai" && openaiKey) provider = "openai";
  else if (forced === "anthropic" && anthropicKey) provider = "anthropic";
  else if (anthropicKey) provider = "anthropic";
  else if (openaiKey) provider = "openai";
  if (!provider) return null;
  const isAnthropic = provider === "anthropic";
  return {
    provider,
    apiKey: (isAnthropic ? anthropicKey : openaiKey) as string,
    model: env("LLM_MODEL") ?? (isAnthropic ? "claude-sonnet-4-5" : "gpt-4o"),
    fastModel: env("LLM_FAST_MODEL") ?? (isAnthropic ? "claude-haiku-4-5" : "gpt-4o-mini"),
  };
}

function resolveSearch(): { provider: SearchProviderName; apiKey?: string } {
  const tavily = env("TAVILY_API_KEY");
  if (tavily) return { provider: "tavily", apiKey: tavily };
  const serper = env("SERPER_API_KEY");
  if (serper) return { provider: "serper", apiKey: serper };
  const exa = env("EXA_API_KEY");
  if (exa) return { provider: "exa", apiKey: exa };
  return { provider: "duckduckgo" };
}

export const config = {
  root,
  port: Number(env("PORT") ?? 3000),
  dbPath: env("DB_PATH") ?? path.join(root, "data", "kairo.db"),
  publicDir: path.join(root, "src", "public"),
  /** Speculative prefetch of live data for verification questions. Set KAIRO_PREFETCH=off to disable. */
  prefetch: env("KAIRO_PREFETCH")?.toLowerCase() !== "off",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  llm: resolveLlm(),
  search: resolveSearch(),
};
