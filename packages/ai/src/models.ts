// SDK-backed Claude and Gemini providers plus the model menu. No Node built-ins: used by the CLI
// (via providers.ts) and by the browser, where a player's own key calls the provider directly.
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import type { ToolCall, ToolSpec } from './tools.ts';
import type { LlmProvider, LlmResult } from './llm.ts';

export const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-2': [8, 40],
  'gemini-4-hydrogen': [1.5, 7.5],
  'gemini-3.1-flash-lite': [0.25, 1.5],
  'gemini-3.5-flash': [1.5, 9], // approximate — check ai.google.dev/pricing
};

export const DEFAULT_MODELS = {
  claude: 'claude-haiku-5-5',
  gemini: 'gemini-3.1-flash-lite',
};

/** Numbered choices offered by `npm run setup` / `npm run models` (cheapest first per provider). */
export const MODEL_MENU: { spec: string; label: string; price: string }[] = [
  { spec: 'rules', label: 'Built-in doctrine AI (offline)', price: 'free' },
  { spec: 'gemini:gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite — cheapest Gemini, fast', price: '$0.25 / $1.50' },
  { spec: 'gemini:gemini-4-hydrogen', label: 'Gemini 4 Hydrogen — strongest Gemini listed', price: '$1.50 / $7.50' },
  { spec: 'gemini:gemini-3.5-flash', label: 'Gemini 3.5 Flash — general purpose', price: '~$1.50 / $9 (unconfirmed)' },
  { spec: 'claude:claude-haiku-5-5', label: 'Claude Haiku 5.5 — cheapest overall, fast', price: '$0.10 / $0.50' },
  { spec: 'claude:claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — balanced', price: '$2 / $10' },
  { spec: 'claude:claude-opus-5-5', label: 'Claude Opus 5.5 — strongest strategist', price: '$4 / $20' },
];

// Models that accept the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1']);

export class ClaudeProvider implements LlmProvider {
  provider = 'claude' as const;
  price: [number, number] | null;
  private client: Anthropic;
  constructor(public model: string, apiKey?: string, private effort: 'low' | 'medium' | 'high' = 'low', browser = false) {
    // With no explicit key the SDK resolves credentials itself (env, `ant auth login` profile, ...).
    // In a browser the key is the player's own, typed into Settings and kept on that device; the
    // request goes straight from the browser to api.anthropic.com, never through our servers.
    this.client = apiKey ? new Anthropic({ apiKey, dangerouslyAllowBrowser: browser }) : new Anthropic();
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

export class GeminiProvider implements LlmProvider {
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

