// Browser entry: run AI calls with the player's own key, straight from this device to the provider.
import { ClaudeProvider, GeminiProvider, DEFAULT_MODELS, MODEL_MENU } from './models.ts';
import type { LlmProvider } from './llm.ts';
export { MODEL_MENU, DEFAULT_MODELS } from './models.ts';
export { describeAiError } from './llm.ts';
export type { LlmProvider, LlmResult } from './llm.ts';
export type { ToolSpec } from './tools.ts';

/** spec = "claude:claude-haiku-5-5" | "gemini:gemini-3.1-flash-lite" */
export function browserProvider(spec: string, keys: { anthropic?: string; gemini?: string }): LlmProvider | string {
  const [prov, model] = spec.split(':');
  if (prov === 'claude') {
    if (!keys.anthropic) return 'NO CLAUDE KEY — ADD ONE IN SETTINGS';
    return new ClaudeProvider(model || DEFAULT_MODELS.claude, keys.anthropic, 'low', true);
  }
  if (prov === 'gemini') {
    if (!keys.gemini) return 'NO GEMINI KEY — ADD ONE IN SETTINGS';
    return new GeminiProvider(model || DEFAULT_MODELS.gemini, keys.gemini);
  }
  return `UNKNOWN MODEL ${spec}`;
}
