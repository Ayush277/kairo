import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "../config.js";

/** Provider-neutral tool definition. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Provider-neutral conversation turn, including tool round-trips. */
export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: { id: string; name: string; content: string }[] };

export interface StreamArgs {
  system: string;
  turns: Turn[];
  tools: ToolDef[];
  onText: (delta: string) => void;
  signal?: AbortSignal;
}

export interface LlmClient {
  provider: string;
  model: string;
  /** Stream one model turn; resolves with the full text and any tool calls the model requested. */
  streamTurn(args: StreamArgs): Promise<{ text: string; toolCalls: ToolCall[] }>;
  /** Small, non-streaming completion on the fast model (used for background extraction). */
  complete(args: { system: string; user: string; maxTokens?: number }): Promise<string>;
}

function createAnthropic(apiKey: string, model: string, fastModel: string): LlmClient {
  const client = new Anthropic({ apiKey });
  return {
    provider: "anthropic",
    model,
    async streamTurn({ system, turns, tools, onText, signal }) {
      const messages: Anthropic.MessageParam[] = turns.map((t): Anthropic.MessageParam => {
        if (t.role === "user") return { role: "user", content: t.text };
        if (t.role === "assistant") {
          const content: Anthropic.ContentBlockParam[] = [];
          if (t.text) content.push({ type: "text", text: t.text });
          for (const c of t.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
          return { role: "assistant", content };
        }
        return {
          role: "user",
          content: t.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content })),
        };
      });
      const stream = client.messages.stream(
        {
          model,
          max_tokens: 4096,
          system,
          messages,
          ...(tools.length
            ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema })) }
            : {}),
        },
        { signal },
      );
      stream.on("text", onText);
      const final = await stream.finalMessage();
      let text = "";
      const toolCalls: ToolCall[] = [];
      for (const block of final.content) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      }
      return { text, toolCalls };
    },
    async complete({ system, user, maxTokens = 2048 }) {
      const res = await client.messages.create({
        model: fastModel,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      });
      return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    },
  };
}

function createOpenAI(apiKey: string, model: string, fastModel: string): LlmClient {
  const client = new OpenAI({ apiKey });
  return {
    provider: "openai",
    model,
    async streamTurn({ system, turns, tools, onText, signal }) {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
      for (const t of turns) {
        if (t.role === "user") messages.push({ role: "user", content: t.text });
        else if (t.role === "assistant") {
          messages.push({
            role: "assistant",
            content: t.text || null,
            ...(t.toolCalls?.length
              ? {
                  tool_calls: t.toolCalls.map((c) => ({
                    id: c.id,
                    type: "function" as const,
                    function: { name: c.name, arguments: JSON.stringify(c.input) },
                  })),
                }
              : {}),
          });
        } else {
          for (const r of t.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
        }
      }
      const stream = await client.chat.completions.create(
        {
          model,
          messages,
          stream: true,
          ...(tools.length
            ? { tools: tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
            : {}),
        },
        { signal },
      );
      let text = "";
      const acc: { id: string; name: string; args: string }[] = [];
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          onText(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const slot = (acc[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }
      const toolCalls: ToolCall[] = acc.filter(Boolean).map((c, i) => {
        let input: Record<string, unknown> = {};
        try {
          input = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {};
        } catch {
          /* malformed arguments → empty input; the tool will report a validation error back to the model */
        }
        return { id: c.id || `call_${i}`, name: c.name, input };
      });
      return { text, toolCalls };
    },
    async complete({ system, user }) {
      const res = await client.chat.completions.create({
        model: fastModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      return res.choices[0]?.message.content ?? "";
    },
  };
}

/** Returns null when no LLM key is configured (the server then explains how to add one). */
export function createLlm(): LlmClient | null {
  const c = config.llm;
  if (!c) return null;
  return c.provider === "anthropic"
    ? createAnthropic(c.apiKey, c.model, c.fastModel)
    : createOpenAI(c.apiKey, c.model, c.fastModel);
}
