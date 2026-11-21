import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolCall, ToolSpec } from './tools.ts';
import type { LlmProvider, LlmResult } from './llm.ts';
import { ClaudeProvider, GeminiProvider, PRICES, DEFAULT_MODELS } from './models.ts';
export { DEFAULT_MODELS, MODEL_MENU } from './models.ts';
export type { LlmProvider, LlmResult } from './llm.ts';
export { describeAiError, isNetworkError } from './llm.ts';

export interface AiConfig {
  anthropicApiKey?: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
  opponent?: string;
  advisor?: string;
  personality?: number;
  display?: 'electron' | 'browser' | 'none';
  /** model used when a spec names only the provider ("gemini", "claude") */
  geminiModel?: string;
  claudeModel?: string;
  /** default server for online matches joined by code (default https://coldlaunch.nano-carbay.workers.dev) */
  server?: string;
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


/** Defaults when a spec names only the provider — the lowest-cost models, since a game makes many calls. */
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

/** The model the user picked for a provider: explicit per-provider setting, else from the saved opponent/advisor spec. */
function savedModel(cfg: AiConfig, provider: 'gemini' | 'claude'): string | undefined {
  const explicit = provider === 'gemini' ? cfg.geminiModel : cfg.claudeModel;
  if (explicit) return explicit;
  for (const spec of [cfg.opponent, cfg.advisor]) {
    const m = spec?.match(/^(\w+):(.+)$/);
    if (m && (m[1] === provider || (provider === 'claude' && m[1] === 'anthropic') || (provider === 'gemini' && m[1] === 'google'))) return m[2];
  }
  return undefined;
}

/**
 * Provider spec:
 *   rules                      built-in doctrine AI (no key)
 *   claude[:model]             default: your saved Claude model, else claude-haiku-5-5
 *   gemini[:model]             default: your saved Gemini model, else gemini-3.1-flash-lite
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
      return new ClaudeProvider(model || savedModel(cfg, 'claude') || DEFAULT_MODELS.claude, cfg.anthropicApiKey, effort);
    case 'gemini':
    case 'google': {
      if (!cfg.geminiApiKey) throw new Error('GEMINI_API_KEY is not set (env or ~/.coldlaunch/config.json)');
      return new GeminiProvider(model || savedModel(cfg, 'gemini') || DEFAULT_MODELS.gemini, cfg.geminiApiKey);
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
