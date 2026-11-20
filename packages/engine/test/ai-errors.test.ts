import { describe, expect, it } from 'vitest';
import { Game } from '@coldlaunch/engine';
import { AiOpponent, describeAiError, makeAdvisor, type AiHost, type LlmProvider } from '@coldlaunch/ai';

const offline = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });

describe('AI provider errors', () => {
  it('explains network failures instead of "fetch failed"', () => {
    const m = describeAiError(offline(), 'gemini');
    expect(m).toContain('generativelanguage.googleapis.com');
    expect(m).toContain('connection timed out');
    expect(m).toMatch(/internet connection, VPN or proxy/);
    expect(describeAiError(new Error('API key not valid. Please pass a valid API key.'), 'gemini')).toMatch(/npm run setup/);
  });

  it('backs off and lets the doctrine AI play while the provider is unreachable', async () => {
    let calls = 0;
    const llm: LlmProvider = { provider: 'gemini', model: 'test', price: null, decide: async () => { calls++; throw offline(); } };
    const game = new Game(5);
    const ls = new Set<(g: Game) => void>();
    const host: AiHost = { game, submit: (s, c) => game.apply(s, c), onTick: (f) => { ls.add(f); return () => ls.delete(f); } };
    const ai = new AiOpponent(host, 'USSR', llm, { minIntervalMs: 0 }).attach();
    for (let i = 0; i < 400; i++) {
      game.step();
      for (const f of ls) f(game);
      await Promise.resolve();
    }
    expect(calls).toBe(1); // no retry storm: next attempt waits 15 s of real time
    expect(ai.status.lastError).toMatch(/NETWORK/);
    expect(game.s.events.some((e) => e.text.startsWith('AI OPPONENT LINK DOWN'))).toBe(true);
  });

  it('advisor reports the network problem and suggests typing orders', async () => {
    const llm: LlmProvider = { provider: 'gemini', model: 'test', price: null, decide: async () => { throw offline(); } };
    const r = await makeAdvisor(llm)('USA', 'scramble the bombers', new Game(1));
    expect('error' in r && r.error).toMatch(/cannot reach generativelanguage\.googleapis\.com.*type orders directly/);
  });
});
