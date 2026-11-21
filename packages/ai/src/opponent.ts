import { describeCommand, type AiStatus, type Command, type GameEvent, type PlanProposal, type Side } from '@coldlaunch/shared';
import type { Game, CommandResult } from '@coldlaunch/engine/core';
import { GAME_TOOLS, toolCallToCommand } from './tools.ts';
import { describeAiError, isNetworkError, type LlmProvider } from './llm.ts';
import { RuleBrain } from './rules.ts';
import { situationReport, opponentSystemPrompt, advisorSystemPrompt } from './situation.ts';

/** What an AI driver needs from its host (the live server or a headless loop). */
export interface AiHost {
  readonly game: Game;
  submit(side: Side, cmd: Command, source?: string): CommandResult;
  onTick(fn: (g: Game) => void): () => void;
}

export interface OpponentOptions {
  personality?: number; // 0 dove .. 1 hawk
  /** game seconds between routine decisions */
  cadenceSec?: number;
  /** minimum real ms between LLM calls */
  minIntervalMs?: number;
  log?: (msg: string) => void;
}

const TRIGGER_KINDS = new Set<GameEvent['kind']>(['alert', 'detect', 'hotline', 'impact', 'launch', 'defcon', 'destroyed']);

export class AiOpponent {
  private evIdx = 0;
  private recent: GameEvent[] = [];
  private orders: string[] = [];
  private nextT = 30;
  private busy = false;
  private lastCall = 0;
  private triggered = false;
  private failures = 0;
  /** real-time backoff after failed calls (ms epoch) — event triggers can't bypass it */
  private retryAt = 0;
  private rules: RuleBrain;
  status: AiStatus;
  private detach?: () => void;

  constructor(
    private host: AiHost,
    readonly side: Side,
    private llm: LlmProvider | 'rules',
    private opts: OpponentOptions = {},
  ) {
    this.rules = new RuleBrain(side, opts.personality ?? 0.5, side === 'USA' ? 11 : 23);
    this.status = {
      provider: llm === 'rules' ? 'builtin' : llm.provider,
      model: llm === 'rules' ? 'doctrine-1983' : llm.model,
      thinking: false, calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
    };
  }

  get label() {
    return `${this.status.provider}:${this.status.model}`;
  }

  attach() {
    this.detach = this.host.onTick((g) => this.tick(g));
    this.host.game.ai[this.side] = this.status;
    return this;
  }

  stop() {
    this.detach?.();
  }

  private tick(g: Game) {
    g.ai[this.side] = this.status;
    // collect events visible to this side
    const evs = g.eventsFor(this.side, this.evIdx);
    this.evIdx = g.s.events.length;
    for (const e of evs) {
      this.recent.push(e);
      if (TRIGGER_KINDS.has(e.kind) && !(e.kind === 'defcon' && e.side === this.side) && !(e.kind === 'launch' && e.side === this.side)) {
        if (!(e.kind === 'hotline' && e.from === this.side)) this.triggered = true;
      }
    }
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
    if (g.s.over || g.s.paused) return;
    const cadence = this.opts.cadenceSec ?? (this.llm === 'rules' ? 30 : 240);
    const due = g.s.t >= this.nextT || this.triggered;
    if (!due || this.busy) return;
    if (this.llm !== 'rules' && Date.now() - this.lastCall < (this.opts.minIntervalMs ?? 6000)) return;
    if (this.llm !== 'rules' && Date.now() < this.retryAt) {
      // provider unreachable: the doctrine AI keeps playing on its normal cadence until the backoff expires
      if (g.s.t >= this.nextT || this.triggered) { this.triggered = false; this.nextT = g.s.t + 30; this.runRules(g, evs); }
      return;
    }
    this.triggered = false;
    this.nextT = g.s.t + cadence;
    if (this.llm === 'rules') {
      this.runRules(g, evs);
    } else {
      void this.runLlm(g, this.llm);
    }
  }

  private runRules(g: Game, newEvents: GameEvent[]) {
    const snap = g.snapshot(this.side);
    const { cmds } = this.rules.decide(snap, newEvents.length ? newEvents : []);
    this.exec(cmds, 'doctrine');
  }

  private exec(cmds: Command[], source: string) {
    for (const c of cmds) {
      const r = this.host.submit(this.side, c, source);
      this.orders.push(`${describeCommand(c)} → ${r.ok ? 'OK' : 'FAILED: ' + r.msg}`);
    }
    if (this.orders.length > 40) this.orders.splice(0, this.orders.length - 40);
  }

  private async runLlm(g: Game, llm: LlmProvider) {
    this.busy = true;
    this.status.thinking = true;
    this.lastCall = Date.now();
    const snap = g.snapshot(this.side);
    const report = situationReport(this.side, snap, g.staticWorld(), this.recent, this.orders);
    try {
      const res = await llm.decide(opponentSystemPrompt(this.side, this.opts.personality ?? 0.5), report, GAME_TOOLS);
      this.status.calls++;
      this.status.tokensIn += res.inTok;
      this.status.tokensOut += res.outTok;
      if (llm.price) this.status.costUsd += (res.inTok * llm.price[0] + res.outTok * llm.price[1]) / 1e6;
      this.status.lastError = undefined;
      this.status.lastNote = res.text.slice(0, 200) || undefined;
      if (this.failures) {
        this.opts.log?.(`[${this.side} AI] ${llm.provider} reachable again`);
        if (this.host.game === g) g.emit({ kind: 'info', text: `AI OPPONENT LINK RESTORED (${llm.provider}:${llm.model})` });
      }
      this.failures = 0;
      this.retryAt = 0;
      const cmds = res.calls.map(toolCallToCommand).filter((c): c is Command => !!c).slice(0, 8);
      if (this.host.game === g) this.exec(cmds, llm.provider);
      if (res.text) this.opts.log?.(`[${this.side} AI] ${res.text}`);
    } catch (e) {
      this.failures++;
      this.status.lastError = describeAiError(e, llm.provider).slice(0, 160);
      // back off: 15 s, 30 s, 1 min, 2 min … up to 5 min (network errors) / 10 min (API errors)
      const cap = isNetworkError(e) ? 300_000 : 600_000;
      const wait = Math.min(cap, 15_000 * 2 ** (this.failures - 1));
      this.retryAt = Date.now() + wait;
      this.opts.log?.(`[${this.side} AI] ${this.status.lastError} — retry in ${Math.round(wait / 1000)} s`);
      if (this.failures === 1 && this.host.game === g) {
        g.emit({ kind: 'warn', text: `AI OPPONENT LINK DOWN: ${this.status.lastError}` });
      }
      // fall back to doctrine so the opponent never freezes
      if (this.host.game === g) this.runRules(g, []);
    } finally {
      this.busy = false;
      this.status.thinking = false;
    }
  }
}

/** Natural-language advisor: turns player instructions into a confirmable plan. */
export function makeAdvisor(llm: LlmProvider) {
  let seq = 0;
  return async (side: Side, text: string, game: Game): Promise<PlanProposal | { error: string }> => {
    const snap = game.snapshot(side);
    const report = situationReport(side, snap, game.staticWorld(), game.eventsFor(side, Math.max(0, game.s.events.length - 60)), []);
    try {
      const res = await llm.decide(advisorSystemPrompt(side), `${report}\n\nPLAYER ORDER: ${text}`, GAME_TOOLS.filter((t) => t.name !== 'hold'));
      const cmds = res.calls.map(toolCallToCommand).filter((c): c is Command => !!c);
      const summary = (res.text.split('\n')[0] || (cmds.length ? `${cmds.length} ORDER(S) PREPARED` : 'NO ACTION')).slice(0, 300);
      return { id: `plan${++seq}`, summary, cmds };
    } catch (e) {
      return { error: `ADVISOR ERROR — ${describeAiError(e, llm.provider)}`.replace('Built-in doctrine AI is covering.', 'You can still type orders directly (help).') };
    }
  };
}
