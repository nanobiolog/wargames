import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolCall, ToolSpec } from './tools.ts';

export interface LlmResult {
  calls: ToolCall[];
  text: string;
  inTok: number;
  outTok: number;
}

export interface LlmProvider {
  provider: 'claude' | 'gemini' | 'openai';
  model: string;
  /** USD per 1M tokens [input, output]; null when unknown */
  price: [number, number] | null;
  decide(system: string, user: string, tools: ToolSpec[]): Promise<LlmResult>;
}

export interface AiConfig {
  anthropicApiKey?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  opponent?: string;
  advisor?: string;
  personality?: number;
  display?: 'electron' | 'browser' | 'none';
}

/** ~/.coldlaunch/config.json (keys never leave this process except to their own provider). */
export function loadConfig(): AiConfig {
  const f = join(homedir(), '.coldlaunch', 'config.json');
  let cfg: AiConfig = {};
  if (existsSync(f)) {
    try { cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { /* ignore */ }
  }
  return {
    ...cfg,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? cfg.anthropicApiKey,
    geminiApiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? cfg.geminiApiKey,
    openaiApiKey: process.env.OPENAI_API_KEY ?? cfg.openaiApiKey,
  };
}

const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-2': [8, 40],
  'gemini-4-hydrogen': [1.5, 7.5],
};

export const DEFAULT_MODELS = {
  claude: 'claude-opus-5-5',
  gemini: 'gemini-4-hydrogen',
};

// Models that accept the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1']);

class ClaudeProvider implements LlmProvider {
  provider = 'claude' as const;
  price: [number, number] | null;
  private client: Anthropic;
  constructor(public model: string, apiKey?: string, private effort: 'low' | 'medium' | 'high' = 'low') {
    // With no explicit key the SDK resolves credentials itself (env, `ant auth login` profile, ...).
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    this.price = PRICES[model] ?? null;
  }
  async decide(system: string, user: string, tools: ToolSpec[]): Promise<LlmResult> {
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 8000,
      ...(FALLBACK_MODELS.has(this.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      output_config: { effort: this.effort },
      // static rules prompt first so it is cached across turns
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: user }],
    });
    if (res.stop_reason === 'refusal') {
      throw new Error(`model declined (${res.stop_details?.category ?? 'refusal'})`);
    }
    const calls: ToolCall[] = [];
    let text = '';
    for (const b of res.content) {
      if (b.type === 'tool_use') calls.push({ name: b.name, args: (b.input ?? {}) as Record<string, unknown> });
      else if (b.type === 'text') text += b.text;
    }
    return { calls, text: text.trim(), inTok: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0), outTok: res.usage.output_tokens };
  }
}

class GeminiProvider implements LlmProvider {
  provider = 'gemini' as const;
  price: [number, number] | null;
  private ai: GoogleGenAI;
  constructor(public model: string, apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
    this.price = PRICES[model] ?? null;
  }
  async decide(system: string, user: string, tools: ToolSpec[]): Promise<LlmResult> {
    const r = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: user }] }],
      config: {
        systemInstruction: system,
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
      },
    });
    const calls: ToolCall[] = (r.functionCalls ?? []).map((c) => ({ name: c.name ?? '', args: (c.args ?? {}) as Record<string, unknown> }));
    let text = '';
    for (const p of r.candidates?.[0]?.content?.parts ?? []) if (p.text && !p.thought) text += p.text;
    return { calls, text: text.trim(), inTok: r.usageMetadata?.promptTokenCount ?? 0, outTok: r.usageMetadata?.candidatesTokenCount ?? 0 };
  }
}

/** Any OpenAI-compatible chat endpoint (Ollama, LM Studio, OpenRouter, vLLM ...). */
class OpenAiCompatProvider implements LlmProvider {
  provider = 'openai' as const;
  price = null;
  constructor(public model: string, private baseUrl: string, private apiKey?: string) {}
  async decide(system: string, user: string, tools: ToolSpec[]): Promise<LlmResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: 'auto',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as any;
    const msg = j.choices?.[0]?.message ?? {};
    const calls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => {
      let args = {};
      try { args = JSON.parse(c.function?.arguments ?? '{}'); } catch { /* ignore malformed */ }
      return { name: c.function?.name ?? '', args };
    });
    return { calls, text: String(msg.content ?? '').trim(), inTok: j.usage?.prompt_tokens ?? 0, outTok: j.usage?.completion_tokens ?? 0 };
  }
}

/**
 * Provider spec:
 *   rules                      built-in doctrine AI (no key)
 *   claude[:model]             default claude-opus-5-5
 *   gemini[:model]             default gemini-4-hydrogen
 *   openai:model@http://host/v1
 */
export function makeProvider(spec: string, cfg: AiConfig = loadConfig(), effort: 'low' | 'medium' | 'high' = 'low'): LlmProvider | 'rules' {
  const s = spec.trim();
  if (!s || s === 'rules' || s === 'builtin') return 'rules';
  const [kind, ...rest] = s.split(':');
  const model = rest.join(':');
  switch (kind.toLowerCase()) {
    case 'claude':
    case 'anthropic':
      return new ClaudeProvider(model || DEFAULT_MODELS.claude, cfg.anthropicApiKey, effort);
    case 'gemini':
    case 'google': {
      if (!cfg.geminiApiKey) throw new Error('GEMINI_API_KEY is not set (env or ~/.coldlaunch/config.json)');
      return new GeminiProvider(model || DEFAULT_MODELS.gemini, cfg.geminiApiKey);
    }
    case 'openai': {
      const at = model.lastIndexOf('@');
      if (at < 0) throw new Error('openai spec must be openai:<model>@<baseURL>');
      return new OpenAiCompatProvider(model.slice(0, at), model.slice(at + 1), cfg.openaiApiKey);
    }
    default:
      throw new Error(`unknown AI provider "${kind}" (use rules, claude[:model], gemini[:model], openai:model@url)`);
  }
}
