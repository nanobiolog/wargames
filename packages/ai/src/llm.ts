// Provider-neutral LLM types and error helpers. No SDK or Node imports: this file is shared by the
// Node providers, the Cloudflare match server (which relays AI calls to a browser that holds the
// player's own key) and the browser itself.
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

const NET_CODES: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out', ETIMEDOUT: 'connection timed out', ENOTFOUND: 'DNS lookup failed',
  EAI_AGAIN: 'DNS lookup failed (temporary)', ECONNREFUSED: 'connection refused', ECONNRESET: 'connection reset',
  ENETUNREACH: 'network unreachable', EHOSTUNREACH: 'host unreachable', UND_ERR_SOCKET: 'socket error',
  CERT_HAS_EXPIRED: 'TLS certificate problem', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate problem (proxy?)',
};

/** True when an error means "couldn't reach the provider" rather than an API/model problem. */
export function isNetworkError(e: unknown): boolean {
  for (let c: any = e; c; c = c.cause) {
    if (c.code && NET_CODES[c.code]) return true;
    if (/fetch failed|Connection error|network/i.test(String(c.message ?? ''))) return true;
  }
  return false;
}

/** Turn SDK errors into something a player can act on ("fetch failed" → which host, why, what to check). */
export function describeAiError(e: unknown, provider: string): string {
  let code = '';
  for (let c: any = e; c; c = c.cause) if (c.code && NET_CODES[c.code]) { code = c.code; break; }
  const host = provider === 'gemini' ? 'generativelanguage.googleapis.com' : provider === 'claude' ? 'api.anthropic.com' : 'the AI endpoint';
  if (code || isNetworkError(e)) {
    return `NETWORK: cannot reach ${host}${code ? ` (${NET_CODES[code]})` : ''} — check your internet connection, VPN or proxy. Built-in doctrine AI is covering.`;
  }
  const msg = String((e as Error)?.message ?? e);
  if (/API key|API_KEY|401|403|permission|unauthori[sz]ed/i.test(msg)) return `${provider.toUpperCase()} rejected the API key — run npm run setup (${msg.slice(0, 80)})`;
  if (/404|not found|is not supported/i.test(msg)) return `${provider.toUpperCase()}: model not available — pick another with npm run models (${msg.slice(0, 80)})`;
  if (/429|quota|rate/i.test(msg)) return `${provider.toUpperCase()}: rate limit or quota reached — slowing down (${msg.slice(0, 80)})`;
  return msg.slice(0, 200);
}

