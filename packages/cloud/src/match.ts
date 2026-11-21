// One Durable Object per online match. It owns the authoritative Game, ticks it at 10 Hz while
// anyone is connected and the clock runs, and hibernates (keeping every WebSocket open, at no
// duration cost) while the match is empty, paused or over.
//
// AI never runs on our servers with our keys: the doctrine AI runs here (no key needed), and LLM
// calls (opponent and advisor) are relayed as `aiJob`s to a browser of the right side that holds
// the player's own key. The tick never awaits an AI call.
import { DurableObject } from 'cloudflare:workers';
import { Game, TICK_SEC, warmNav } from '@coldlaunch/engine/core';
import {
  AiOpponent, GAME_TOOLS, advisorSystemPrompt, situationReport, toolCallToCommand,
  type AiHost, type LlmProvider, type LlmResult, type ToolSpec,
} from '@coldlaunch/ai/core';
import {
  ClientMsgSchema, cleanCallsign, enemyOf, randomCallsign, makeMatchLink,
  type AiJob, type ClientMsg, type Command, type MatchInfo, type PlanProposal, type Role, type RosterEntry, type ServerMsg, type Side,
} from '@coldlaunch/shared';
import './geo.ts';

export interface MatchConfig {
  code: string;
  scenario: '1983';
  /** human: a friend plays the other side · rules: built-in doctrine AI · byok: LLM via the host's own key */
  opponent: 'human' | 'rules' | 'byok';
  hostSide: Side;
  speed: number;
  seed: number;
  personality: number;
  host: string;
  created: number;
  /** site origin the match was created on (for share links) */
  origin: string;
}

export type CreateOptions = Partial<Pick<MatchConfig, 'opponent' | 'hostSide' | 'speed' | 'personality' | 'host'>>;

interface Conn {
  role: Role;
  name: string;
  player: string;
  kind: string;
  ai: boolean;
  authed: boolean;
}

interface Live extends Conn {
  eventIdx: number;
}

const SNAP_EVERY = 2; // ticks → 5 Hz snapshots
const PERSIST_MS = 10_000;
const ABANDON_MS = 24 * 3600_000; // delete a match a day after the last player leaves
const AI_TIMEOUT_MS = 45_000;
const MAX_EVENTS = 1500;
const SEAT_GRACE_MS = 120_000; // a dropped player's seat stays theirs this long
const SIDES: Side[] = ['USA', 'USSR'];

export class MatchRoom extends DurableObject<Env> {
  private cfg?: MatchConfig;
  private game?: Game;
  private seats: Partial<Record<Side, { player: string; name: string; leftAt?: number }>> = {};
  private readonly bootAt = Date.now();
  private lastJoin = new Map<string, number>();
  private conns = new Map<WebSocket, Live>();
  private timer?: ReturnType<typeof setInterval>;
  private tickN = 0;
  private lastPersist = 0;
  private listeners = new Set<(g: Game) => void>();
  private opponent?: AiOpponent;
  private plans = new Map<string, { side: Side; plan: PlanProposal }>();
  private jobs = new Map<string, { resolve: (r: LlmResult) => void; reject: (e: Error) => void; ws: WebSocket; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.cfg = await ctx.storage.get<MatchConfig>('cfg');
      this.seats = (await ctx.storage.get<MatchRoom['seats']>('seats')) ?? {};
      if (!this.cfg) return;
      const saved = await ctx.storage.get<string>('state');
      this.game = saved ? Game.deserialize(saved) : new Game(this.cfg.seed);
      this.setupAi();
      // re-attach sockets that stayed open while we hibernated; nothing happened in between,
      // so every client is up to date with the event log
      for (const ws of ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() as Conn | null;
        if (a) this.conns.set(ws, { ...a, eventIdx: this.game.s.events.length });
      }
    });
  }

  // ------------------------------------------------------------------ RPC (from the Worker)

  /** Create the match. Returns false if this code is already taken. */
  async init(code: string, opts: CreateOptions, origin: string): Promise<MatchInfo | null> {
    if (this.cfg) return null;
    this.cfg = {
      code, scenario: '1983',
      opponent: opts.opponent ?? 'human',
      hostSide: opts.hostSide ?? 'USA',
      speed: Math.min(60, Math.max(1, opts.speed ?? 10)),
      seed: Math.floor(Math.random() * 1e9),
      personality: Math.min(1, Math.max(0, opts.personality ?? 0.5)),
      host: cleanCallsign(opts.host) ?? randomCallsign(),
      created: Date.now(),
      origin,
    };
    this.game = new Game(this.cfg.seed);
    this.game.s.speed = this.cfg.speed;
    this.setupAi();
    await this.ctx.storage.put('cfg', this.cfg);
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now() + ABANDON_MS);
    return this.info();
  }

  /** Public lobby info (no fog-sensitive data). */
  async status(): Promise<null | { match: MatchInfo; seats: Partial<Record<Side, string>>; players: number; spectators: number; t: number; over: boolean }> {
    if (!this.cfg || !this.game) return null;
    const live = [...this.conns.values()].filter((c) => c.authed);
    return {
      match: this.info(),
      seats: Object.fromEntries(Object.entries(this.seats).map(([k, v]) => [k, v!.name])),
      players: live.filter((c) => c.role !== 'SPECTATOR').length,
      spectators: live.filter((c) => c.role === 'SPECTATOR').length,
      t: this.game.s.t,
      over: !!this.game.s.over,
    };
  }

  private info(): MatchInfo {
    const c = this.cfg!;
    return { code: c.code, scenario: c.scenario, opponent: c.opponent === 'byok' ? 'your AI key' : c.opponent, created: c.created, host: c.host };
  }

  /** Side played by an AI in this match (none in human-vs-human). */
  private aiSide(): Side | null {
    return this.cfg && this.cfg.opponent !== 'human' ? enemyOf(this.cfg.hostSide) : null;
  }

  // ------------------------------------------------------------------ WebSocket lifecycle

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!this.cfg) return new Response('no such match', { status: 404 });
    if (this.conns.size >= 64) return new Response('match is full', { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const c: Conn = { role: 'SPECTATOR', name: '', player: '', kind: 'other', ai: false, authed: false };
    server.serializeAttachment(c);
    this.conns.set(server, { ...c, eventIdx: 0 });
    await this.ctx.storage.deleteAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const c = this.conns.get(ws);
    if (!c || typeof data !== 'string' || data.length > 64 * 1024) return;
    let raw: unknown;
    try { raw = JSON.parse(data); } catch { return this.send(ws, { t: 'error', msg: 'bad json' }); }
    const parsed = ClientMsgSchema.safeParse(raw);
    if (!parsed.success) return this.send(ws, { t: 'error', msg: `bad message: ${parsed.error.issues[0]?.message}` });
    const m = parsed.data;
    if (!c.authed && m.t !== 'hello') return this.send(ws, { t: 'error', msg: 'hello first' });
    try {
      await this.handle(ws, c, m);
    } catch (e) {
      this.send(ws, { t: 'error', msg: String((e as Error)?.message ?? e) });
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.drop(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.drop(ws);
  }

  private drop(ws: WebSocket) {
    const c = this.conns.get(ws);
    this.conns.delete(ws);
    for (const [id, j] of this.jobs) if (j.ws === ws) { clearTimeout(j.timer); this.jobs.delete(id); j.reject(new Error('AI host disconnected')); }
    if (c?.authed && c.role !== 'SPECTATOR') {
      const seat = this.seats[c.role];
      const stillHere = [...this.conns.values()].some((o) => o.authed && o.player === c.player);
      if (seat?.player === c.player && !stillHere) {
        seat.leftAt = Date.now();
        this.ctx.storage.put('seats', this.seats);
      }
    }
    if (c?.authed) this.sendRoster();
    this.updateLoop();
  }

  /** Clean up matches nobody came back to. */
  async alarm() {
    if (this.ctx.getWebSockets().length) return;
    await this.ctx.storage.deleteAll();
    this.cfg = undefined;
    this.game = undefined;
  }

  // ------------------------------------------------------------------ messages

  private async handle(ws: WebSocket, c: Live, m: ClientMsg) {
    const game = this.game!;
    switch (m.t) {
      case 'hello': {
        if (m.token.toUpperCase() !== this.cfg!.code) {
          this.send(ws, { t: 'error', msg: 'invalid match code' });
          return ws.close(1008, 'invalid match code');
        }
        c.player = m.player ?? `anon-${crypto.randomUUID().slice(0, 8)}`;
        c.name = cleanCallsign(m.name) ?? randomCallsign();
        c.kind = m.client;
        c.ai = !!m.caps?.includes('ai');
        c.role = this.seat(c, m.role ?? this.defaultRole(c));
        c.authed = true;
        c.eventIdx = Math.max(0, game.s.events.length - 200);
        this.saveConn(ws, c);
        const link = makeMatchLink(this.cfg!.origin, this.cfg!.code);
        this.send(ws, {
          t: 'welcome', role: c.role, world: game.staticWorld(), link, match: this.info(), you: c.name,
          aiOpponent: this.cfg!.opponent === 'human' ? undefined : this.cfg!.opponent === 'rules' ? 'doctrine AI' : 'AI (host key)',
        });
        this.send(ws, { t: 'snap', snap: game.snapshot(c.role) });
        if (c.role !== 'SPECTATOR' && m.role && m.role !== c.role) this.send(ws, { t: 'result', ok: false, msg: `${m.role} SEAT IS TAKEN — JOINED AS ${c.role}` });
        // announce people, not screens: extra tabs and reconnects of the same player stay quiet
        const already = [...this.conns.entries()].some(([w, o]) => w !== ws && o.authed && o.player === c.player);
        const recent = this.lastJoin.get(c.player) ?? 0;
        if (!already && Date.now() - recent > 300_000) {
          game.emit({ kind: 'info', text: `${c.name} JOINED${c.role === 'SPECTATOR' ? ' AS SPECTATOR' : ` — ${c.role} COMMAND`}` });
        }
        this.lastJoin.set(c.player, Date.now());
        this.sendRoster();
        this.updateLoop();
        return;
      }
      case 'cmd': {
        if (c.role === 'SPECTATOR' && m.cmd.op !== 'speed' && m.cmd.op !== 'pause') {
          return this.send(ws, { t: 'result', id: m.id, ok: false, msg: 'SPECTATORS CANNOT ISSUE ORDERS' });
        }
        if (c.role === 'SPECTATOR' && !this.isHost(c)) return this.send(ws, { t: 'result', id: m.id, ok: false, msg: 'ONLY PLAYERS CONTROL THE CLOCK' });
        const side = (c.role === 'SPECTATOR' ? this.cfg!.hostSide : c.role) as Side;
        const res = game.apply(side, m.cmd);
        if (res.ok) game.emit({ kind: 'info', visibleTo: [side], side, text: `[${c.name}] ${game.describe(m.cmd)} — ${res.msg}` });
        this.send(ws, { t: 'result', id: m.id, ok: res.ok, msg: res.msg });
        if (m.cmd.op === 'pause' || m.cmd.op === 'speed') this.updateLoop();
        return;
      }
      case 'focus':
        return this.broadcast(c.role, { t: 'focus', focus: m.focus, from: c.name }, ws);
      case 'chat':
        return this.broadcast('ALL', { t: 'chat', from: c.name, role: c.role, text: m.text.slice(0, 300) });
      case 'ask':
        return this.ask(ws, c, m.id, m.text);
      case 'plan': {
        const entry = this.plans.get(m.id);
        this.plans.delete(m.id);
        this.broadcast(c.role, { t: 'planPreview', plan: null });
        if (!entry || !m.cmds || entry.side !== c.role) return this.send(ws, { t: 'result', id: m.id, ok: true, msg: 'PLAN DISCARDED' });
        const msgs: string[] = [];
        let ok = true;
        for (const cmd of m.cmds.slice(0, 12)) {
          const r = game.apply(entry.side, cmd);
          ok &&= r.ok;
          msgs.push(`${r.ok ? '✓' : '✗'} ${game.describe(cmd)}: ${r.msg}`);
        }
        return this.send(ws, { t: 'result', id: m.id, ok, msg: msgs.join('\n') });
      }
      case 'aiResult': {
        const j = this.jobs.get(m.id);
        if (!j || j.ws !== ws) return;
        this.jobs.delete(m.id);
        clearTimeout(j.timer);
        if (m.error) j.reject(new Error(m.error));
        else j.resolve({ calls: m.calls ?? [], text: m.text ?? '', inTok: m.inTok ?? 0, outTok: m.outTok ?? 0 });
        return;
      }
      case 'newgame': {
        if (!this.isHost(c)) return this.send(ws, { t: 'result', ok: false, msg: 'ONLY THE HOST CAN RESTART THE MATCH' });
        this.game = new Game(m.seed ?? Math.floor(Math.random() * 1e9));
        this.game.s.speed = this.cfg!.speed;
        this.setupAi();
        for (const [sock, cc] of this.conns) {
          if (!cc.authed) continue;
          cc.eventIdx = 0;
          this.send(sock, { t: 'welcome', role: cc.role, world: this.game.staticWorld(), link: '', match: this.info(), you: cc.name });
        }
        await this.persist();
        this.updateLoop();
        return this.send(ws, { t: 'result', ok: true, msg: 'NEW SCENARIO STARTED' });
      }
      case 'save':
      case 'load':
        return this.send(ws, { t: 'result', ok: false, msg: 'ONLINE MATCHES SAVE AUTOMATICALLY' });
      case 'share':
        return this.send(ws, {
          t: 'share', info: {
            lan: true, host: new URL(this.cfg!.origin).host, port: 443,
            links: this.shareLinks(c.role),
          },
        });
      case 'ping':
        return this.send(ws, { t: 'pong' });
    }
  }

  private shareLinks(role: Role) {
    const origin = this.cfg!.origin;
    const code = this.cfg!.code;
    const side = role === 'SPECTATOR' ? this.cfg!.hostSide : role;
    const other = enemyOf(side);
    const links = [
      { label: `Your side (${side}) on another screen or phone`, url: makeMatchLink(origin, code, side), kind: 'web' as const },
      { label: 'Spectator wall (TV / big screen)', url: `${makeMatchLink(origin, code, 'SPECTATOR')}&preset=wall`, kind: 'web' as const },
      { label: 'Terminal (any PC)', url: `npx coldlaunch --join ${makeMatchLink(origin, code, side)}`, kind: 'terminal' as const },
    ];
    if (this.cfg!.opponent === 'human') links.splice(0, 0, { label: `Invite a friend (they get ${other})`, url: makeMatchLink(origin, code), kind: 'web' as const });
    return links;
  }

  /**
   * Decide the seat a client gets. Rules:
   *  - one player (same player id) holds at most one side, on as many screens as they like;
   *    asking for the other side's link doesn't switch them over;
   *  - a seat stays reserved for SEAT_GRACE_MS after its owner's last screen drops (phones change
   *    networks and reconnect), so nobody can grab it in between;
   *  - a busy seat sends the newcomer to the free human side, otherwise to the spectators.
   */
  private seat(c: Live, want: Role): Role {
    const mine = SIDES.find((s) => this.seats[s]?.player === c.player);
    if (want === 'SPECTATOR') {
      // spectators see both sides; in a human-vs-human match a seated player can't also watch as one
      return mine && this.cfg!.opponent === 'human' ? mine : 'SPECTATOR';
    }
    if (mine) return this.claim(mine, c);
    if (want === this.aiSide()) want = enemyOf(want);
    if (this.taken(want, c.player)) {
      const other = enemyOf(want);
      if (other === this.aiSide() || this.taken(other, c.player)) return 'SPECTATOR';
      want = other;
    }
    return this.claim(want, c);
  }

  /** Someone else holds this seat: online now, or dropped less than SEAT_GRACE_MS ago. */
  private taken(side: Side, player: string): boolean {
    const s = this.seats[side];
    if (!s || s.player === player) return false;
    if ([...this.conns.values()].some((o) => o.authed && o.player === s.player)) return true;
    return Date.now() - Math.max(s.leftAt ?? 0, this.bootAt) < SEAT_GRACE_MS;
  }

  private claim(side: Side, c: Live): Side {
    const prev = this.seats[side];
    if (!prev || prev.player !== c.player || prev.leftAt || prev.name !== c.name) {
      this.seats[side] = { player: c.player, name: c.name };
      this.ctx.storage.put('seats', this.seats);
    }
    return side;
  }

  private defaultRole(c: Live): Role {
    const mine = SIDES.find((s) => this.seats[s]?.player === c.player);
    if (mine) return mine;
    const host = this.cfg!.hostSide;
    if (!this.taken(host, c.player)) return host;
    const other = enemyOf(host);
    return other === this.aiSide() || this.taken(other, c.player) ? 'SPECTATOR' : other;
  }

  private isHost(c: Live) {
    return this.seats[this.cfg!.hostSide]?.player === c.player;
  }

  private saveConn(ws: WebSocket, c: Live) {
    const { eventIdx, ...a } = c;
    ws.serializeAttachment(a);
  }

  // ------------------------------------------------------------------ AI (doctrine here, LLM in the player's browser)

  private setupAi() {
    this.listeners.clear();
    this.opponent = undefined;
    const side = this.aiSide();
    if (!side || !this.game) return;
    const host: AiHost = {
      game: this.game,
      submit: (s: Side, cmd: Command, source = 'ai') => {
        const res = this.game!.apply(s, cmd);
        if (res.ok && cmd.op !== 'hold') this.game!.emit({ kind: 'ai', visibleTo: [s], side: s, text: `[${source.toUpperCase()}] ${this.game!.describe(cmd)} — ${res.msg}` });
        return res;
      },
      onTick: (fn) => { this.listeners.add(fn); return () => this.listeners.delete(fn); },
    };
    const provider: LlmProvider | 'rules' = this.cfg!.opponent === 'byok' ? this.relayProvider('opponent', side) : 'rules';
    this.opponent = new AiOpponent(host, side, provider, { personality: this.cfg!.personality, cadenceSec: 90 });
    this.opponent.attach();
  }

  /**
   * An LlmProvider whose calls run in a browser that holds the player's own key. For the opponent
   * this is the host's browser (the host chose to play against their own AI, so it is their key and
   * their bill). Fails fast when no such browser is connected; AiOpponent then falls back to doctrine.
   */
  private relayProvider(purpose: AiJob['purpose'], side: Side): LlmProvider {
    return {
      provider: 'claude', model: 'player key', price: null,
      decide: (system: string, user: string, tools: ToolSpec[]) => this.relay({ purpose, side, system, user, tools, model: '' }, purpose === 'opponent' ? this.cfg!.hostSide : side),
    };
  }

  private relay(job: Omit<AiJob, 'id'>, onSide: Side): Promise<LlmResult> {
    const target = [...this.conns.entries()].find(([, c]) => c.authed && c.ai && c.role === onSide);
    if (!target) return Promise.reject(new Error(`no ${onSide} screen with an AI key is connected`));
    const id = `j${++this.seq}`;
    return new Promise<LlmResult>((resolve, reject) => {
      const timer = setTimeout(() => { if (this.jobs.delete(id)) reject(new Error('AI call timed out')); }, AI_TIMEOUT_MS);
      this.jobs.set(id, { resolve, reject, ws: target[0], timer });
      this.send(target[0], { t: 'aiJob', job: { ...job, id } });
    });
  }

  /** Advisor: plain-language orders → plan, computed by an AI-capable screen of the asker's side. */
  private async ask(ws: WebSocket, c: Live, id: string | undefined, text: string) {
    if (c.role === 'SPECTATOR') return this.send(ws, { t: 'result', id, ok: false, msg: 'SPECTATOR' });
    const side = c.role;
    const game = this.game!;
    const snap = game.snapshot(side);
    const report = situationReport(side, snap, game.staticWorld(), game.eventsFor(side, Math.max(0, game.s.events.length - 60)), []);
    try {
      const res = await this.relay({
        purpose: 'advisor', side, model: '', system: advisorSystemPrompt(side), user: `${report}\n\nPLAYER ORDER: ${text}`,
        tools: GAME_TOOLS.filter((t) => t.name !== 'hold'),
      }, side);
      const cmds = res.calls.map(toolCallToCommand).filter((x): x is Command => !!x);
      const plan: PlanProposal = {
        id: `plan${++this.seq}`, cmds,
        summary: (res.text.split('\n')[0] || (cmds.length ? `${cmds.length} ORDER(S) PREPARED` : 'NO ACTION')).slice(0, 300),
      };
      this.plans.set(plan.id, { side, plan });
      this.send(ws, { t: 'plan', plan, askId: id });
      this.broadcast(side, { t: 'planPreview', plan }, ws);
    } catch (e) {
      const msg = String((e as Error).message);
      this.send(ws, {
        t: 'result', id, ok: false,
        msg: /no .* screen/.test(msg)
          ? 'NO AI KEY ON YOUR SIDE — ADD YOUR OWN KEY IN SETTINGS ON THIS OR ANOTHER OF YOUR SCREENS (IT STAYS IN THAT BROWSER)'
          : `ADVISOR ERROR — ${msg}`,
      });
    }
  }

  // ------------------------------------------------------------------ tick loop

  /** Run the clock only while someone is connected and the game is live; otherwise allow hibernation. */
  private updateLoop() {
    const g = this.game;
    const anyone = [...this.conns.values()].some((c) => c.authed);
    const live = !!g && anyone && !g.s.paused && !g.s.over;
    if (live && !this.timer) {
      warmNav(); // ~0.2 s once per wake, so the first ship order replies instantly
      this.timer = setInterval(() => this.loop(), TICK_SEC * 1000);
    } else if (!live && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.flush();
      this.persist();
    }
    if (!anyone) this.ctx.storage.setAlarm(Date.now() + ABANDON_MS);
  }

  private loop() {
    const g = this.game!;
    g.step();
    this.tickN++;
    for (const fn of this.listeners) {
      try { fn(g); } catch (e) { console.error(e); }
    }
    this.flush(this.tickN % SNAP_EVERY === 0);
    if (g.s.events.length > MAX_EVENTS) this.trimEvents();
    if (Date.now() - this.lastPersist > PERSIST_MS) this.persist();
    if (g.s.paused || g.s.over) this.updateLoop();
  }

  /** Send new events (per client, fog-filtered) and, optionally, one snapshot per role (shared JSON). */
  private flush(withSnap = true) {
    const g = this.game!;
    const snaps = new Map<Role, string>();
    for (const [ws, c] of this.conns) {
      if (!c.authed) continue;
      const evs = g.eventsFor(c.role, c.eventIdx);
      c.eventIdx = g.s.events.length;
      if (evs.length) this.send(ws, { t: 'events', events: evs });
      if (withSnap) {
        let s = snaps.get(c.role);
        if (!s) snaps.set(c.role, (s = JSON.stringify({ t: 'snap', snap: g.snapshot(c.role) })));
        this.sendRaw(ws, s);
      }
    }
  }

  private trimEvents() {
    const g = this.game!;
    const cut = g.s.events.length - MAX_EVENTS / 2;
    g.s.events.splice(0, cut);
    for (const c of this.conns.values()) c.eventIdx = Math.max(0, c.eventIdx - cut);
  }

  private async persist() {
    if (!this.game) return;
    this.lastPersist = Date.now();
    const s = this.game.s;
    // events are display history only; keep the tail so a saved match stays well under the value limit
    const json = JSON.stringify({ ...s, events: s.events.slice(-300) });
    await this.ctx.storage.put('state', json);
  }

  // ------------------------------------------------------------------ send helpers

  private sendRoster() {
    const list = [...this.conns.entries()].filter(([, c]) => c.authed);
    for (const [ws, me] of list) {
      const players: RosterEntry[] = list.map(([w, c]) => ({ name: c.name, role: c.role, kind: c.kind, ai: c.ai, you: w === ws || undefined }));
      if (this.aiSide()) players.push({ name: this.cfg!.opponent === 'rules' ? 'DOCTRINE AI' : 'AI OPPONENT', role: this.aiSide()!, kind: 'ai', ai: true });
      this.send(ws, { t: 'roster', players });
      void me;
    }
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: WebSocket, s: string) {
    try { ws.send(s); } catch { /* closed */ }
  }

  private broadcast(role: Role | 'ALL', msg: ServerMsg, except?: WebSocket) {
    const s = JSON.stringify(msg);
    for (const [ws, c] of this.conns) {
      if (!c.authed || ws === except) continue;
      if (role === 'ALL' || c.role === role || c.role === 'SPECTATOR') this.sendRaw(ws, s);
    }
  }
}
