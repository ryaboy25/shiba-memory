/**
 * LLM Provider Layer
 * ==================
 * Provider-agnostic chat completions for extraction, summarization, and NLI.
 * Supports: llama.cpp, Ollama, OpenAI, Anthropic, OpenRouter, or "none".
 *
 * Config via .env:
 *   SHB_LLM_PROVIDER=openai-compatible  (or ollama, anthropic, none)
 *   SHB_LLM_URL=http://localhost:8080
 *   SHB_LLM_MODEL=gemma-4
 *   SHB_LLM_API_KEY=            (optional)
 *   SHB_LLM_TIMEOUT_MS=15000
 *   SHB_LLM_RETRIES=1
 */

import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
const __llmdir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__llmdir, "../../.env") });

const PROVIDER = process.env.SHB_LLM_PROVIDER || "none";
const LLM_URL = process.env.SHB_LLM_URL || "http://localhost:8080";
const LLM_MODEL = process.env.SHB_LLM_MODEL || "";
const LLM_API_KEY = process.env.SHB_LLM_API_KEY || "";
const LLM_TIMEOUT = parseInt(process.env.SHB_LLM_TIMEOUT_MS || "15000");
const LLM_RETRIES = parseInt(process.env.SHB_LLM_RETRIES || "1");

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMProvider {
  chat(messages: ChatMessage[], maxTokens?: number): Promise<string>;
}

// ── OpenAI-compatible (llama.cpp, vLLM, OpenRouter, Together, OpenAI) ──

const openaiCompatible: LLMProvider = {
  async chat(messages, maxTokens = 200) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (LLM_API_KEY) headers["Authorization"] = `Bearer ${LLM_API_KEY}`;

    const body: Record<string, unknown> = {
      messages,
      max_tokens: maxTokens,
      temperature: 0.1,
    };
    if (LLM_MODEL) body.model = LLM_MODEL;

    const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT),
    });

    if (!res.ok) throw new Error(`LLM failed (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as {
      choices: { message: { content?: string; reasoning_content?: string } }[];
    };

    const msg = data.choices[0].message;
    let content = msg.content || "";
    const reasoning = msg.reasoning_content || "";

    // Strip Gemma channel/turn artifacts from non-reasoning template
    if (content.includes("<channel|>")) content = content.split("<channel|>").pop()!;
    content = content.replace(/<end_of_turn>/g, "").replace(/<\|channel>thought\n/g, "").trim();

    // Return content if available, otherwise fall back to reasoning
    if (content) return content;
    if (reasoning.includes("<channel|>")) return reasoning.split("<channel|>").pop()!.replace(/<end_of_turn>/g, "").trim();
    if (reasoning.trim()) return reasoning.trim();
    return "";
  },
};

// ── Ollama native ──

const ollama: LLMProvider = {
  async chat(messages, maxTokens = 200) {
    const url = process.env.SHB_OLLAMA_URL || "http://localhost:11434";
    const model = LLM_MODEL || process.env.SHB_OLLAMA_MODEL || "llama3";

    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { num_predict: maxTokens, temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT),
    });

    if (!res.ok) throw new Error(`Ollama chat failed (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as { message: { content: string } };
    return data.message.content.trim();
  },
};

// ── Anthropic ──

const anthropic: LLMProvider = {
  async chat(messages, maxTokens = 200) {
    if (!LLM_API_KEY) throw new Error("SHB_LLM_API_KEY required for anthropic provider");
    const model = LLM_MODEL || "claude-sonnet-4-20250514";

    // Separate system message
    const systemMsg = messages.find((m) => m.role === "system");
    const chatMsgs = messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: chatMsgs,
    };
    if (systemMsg) body.system = systemMsg.content;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": LLM_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT),
    });

    if (!res.ok) throw new Error(`Anthropic failed (${res.status}): ${await res.text()}`);

    const data = (await res.json()) as { content: { text: string }[] };
    return data.content[0]?.text?.trim() || "";
  },
};

// ── None (no LLM — Tier 1 only) ──

const none: LLMProvider = {
  async chat() {
    return "";
  },
};

// ── Provider registry ──

const providers: Record<string, LLMProvider> = {
  "openai-compatible": openaiCompatible,
  ollama,
  anthropic,
  none,
};

/** Get the configured LLM provider. Returns "none" provider if not configured. */
export function getLLMProvider(): LLMProvider {
  return providers[PROVIDER] || none;
}

/** Check if LLM extraction is available (provider != none). */
export function isLLMAvailable(): boolean {
  return PROVIDER !== "none" && PROVIDER in providers;
}

/** Chat with retry and exponential backoff. Returns empty string on failure. */
export async function llmChat(messages: ChatMessage[], maxTokens?: number): Promise<string> {
  const provider = getLLMProvider();
  if (provider === none) return "";

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    try {
      return await provider.chat(messages, maxTokens);
    } catch (e) {
      lastError = e as Error;
      if (attempt < LLM_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  // Don't throw — extraction failures shouldn't break the system
  console.error(`[shiba-llm] Chat failed after ${LLM_RETRIES + 1} attempts: ${lastError?.message}`);
  return "";
}
