// One Durable Object per online match. It owns the authoritative Game, ticks it at 10 Hz while
// anyone is connected and the clock runs, and hibernates (keeping every WebSocket open, at no
// duration cost) while the match is in its lobby, empty, paused or over.
//
// A match starts in a LOBBY: players pick a nation and a branch, the host sets the options, and
// the clock only starts when the host presses START. A nation can be shared by a crew of players,
// each commanding a branch (commander, navy, air force, rocket forces); the server checks every
// order against the sender's branch.
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
  BRANCH_LABEL, ClientMsgSchema, cleanCallsign, enemyOf, randomCallsign, makeMatchLink,
  type AiJob, type Branch, type ClientMsg, type Command, type LobbyState, type MatchInfo, type PlanProposal, type Role,
  type RosterEntry, type ServerMsg, type Side,
} from '@coldlaunch/shared';
import { SCENARIOS } from '@coldlaunch/data';
import './geo.ts';

export interface MatchConfig {
  code: string;
  /** scenario id: '1983' (two players) or 'modern' (five factions, AI fills empty seats) */
  scenario: string;
  /** human: friends play · rules: built-in doctrine AI · byok: LLM via the host's own key */
  opponent: 'human' | 'rules' | 'byok';
  hostSide: Side;
  /** player id of the creator (controls the lobby, start and end) */
  hostPlayer?: string;
  speed: number;
  seed: number;
  personality: number;
  host: string;
  created: number;
  /** site origin the match was created on (for share links) */
  origin: string;
  /** lobby: seats and settings, clock stopped · running · (matches created before lobbies have none = running) */
  phase?: 'lobby' | 'running';
  /** open: play on past the scenario's endings until one nation / alliance is left (default for new matches) */
  endMode?: 'open' | 'classic';
}

export type CreateOptions = Partial<Pick<MatchConfig, 'scenario' | 'opponent' | 'hostSide' | 'speed' | 'personality' | 'host' | 'hostPlayer' | 'endMode'>>;

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

/** One player in a nation's crew. The same player may be on several screens. */
interface CrewMember {
  player: string;
  name: string;
  branch: Branch;
  leftAt?: number;
}

const SNAP_EVERY = 2; // ticks → 5 Hz snapshots
const PERSIST_MS = 10_000;
const ABANDON_MS = 24 * 3600_000; // delete a match a day after the last player leaves
const AI_TIMEOUT_MS = 45_000;
const MAX_EVENTS = 1500;
const SEAT_GRACE_MS = 120_000; // a dropped player's seat stays theirs this long

export class MatchRoom extends DurableObject<Env> {
  private cfg?: MatchConfig;
  private game?: Game;
  /** crews per nation (first member = whoever sat down first) */
  private crews: Partial<Record<Side, CrewMember[]>> = {};
  private readonly bootAt = Date.now();
  private lastJoin = new Map<string, number>();
  private conns = new Map<WebSocket, Live>();
  private timer?: ReturnType<typeof setInterval>;
  private tickN = 0;
  private lastPersist = 0;
  private knownOut = 0;
  private listeners = new Set<(g: Game) => void>();
  private opponents: AiOpponent[] = [];
  private plans = new Map<string, { side: Side; plan: PlanProposal }>();
  private jobs = new Map<string, { resolve: (r: LlmResult) => void; reject: (e: Error) => void; ws: WebSocket; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.cfg = await ctx.storage.get<MatchConfig>('cfg');
      this.crews = (await ctx.storage.get<MatchRoom['crews']>('crews')) ?? migrateSeats(await ctx.storage.get('seats'));
      if (!this.cfg) return;
      this.cfg.phase ??= 'running';
      this.cfg.endMode ??= 'classic';
      const saved = await ctx.storage.get<string>('state');
      this.game = saved ? Game.deserialize(saved) : new Game(this.cfg.seed, undefined, this.cfg.scenario, this.cfg.endMode);
      this.knownOut = this.game.s.out?.length ?? 0;
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

  /** Create the match (in its lobby). Returns null if this code is already taken. */
  async init(code: string, opts: CreateOptions, origin: string): Promise<MatchInfo | null> {
    if (this.cfg) return null;
    this.cfg = {
      code, scenario: opts.scenario ?? '1983',
      opponent: opts.opponent ?? 'human',
      hostSide: opts.hostSide ?? 'USA',
      hostPlayer: opts.hostPlayer,
      speed: Math.min(60, Math.max(1, opts.speed ?? 10)),
      seed: Math.floor(Math.random() * 1e9),
      personality: Math.min(1, Math.max(0, opts.personality ?? 0.5)),
      host: cleanCallsign(opts.host) ?? randomCallsign(),
      created: Date.now(),
      origin,
      phase: 'lobby',
      endMode: opts.endMode ?? 'open',
    };
    this.newGame();
    await this.saveCfg();
    await this.ctx.storage.setAlarm(Date.now() + ABANDON_MS);
    return this.info();
  }

  /** Public lobby info (no fog-sensitive data). */
  async status(): Promise<null | { match: MatchInfo; phase: string; seats: Partial<Record<Side, string>>; players: number; spectators: number; t: number; over: boolean }> {
    if (!this.cfg || !this.game) return null;
    const live = [...this.conns.values()].filter((c) => c.authed);
    return {
      match: this.info(),
      phase: this.cfg.phase ?? 'running',
      seats: Object.fromEntries(Object.entries(this.crews).map(([k, v]) => [k, (v ?? []).map((m) => m.name).join(', ')])),
      players: live.filter((c) => c.role !== 'SPECTATOR').length,
      spectators: live.filter((c) => c.role === 'SPECTATOR').length,
      t: this.game.s.t,
      over: !!this.game.s.over,
    };
  }

  private info(): MatchInfo {
    const c = this.cfg!;
    return { code: c.code, scenario: this.game?.sc.name ?? c.scenario, opponent: c.opponent === 'byok' ? 'your AI key' : c.opponent, created: c.created, host: c.host };
  }

  /** (Re)build the game from the config: lobby matches stay paused until START. */
  private newGame() {
    const c = this.cfg!;
    this.game = new Game(c.seed, undefined, c.scenario, c.endMode ?? 'open');
    if (!this.game.faction(c.hostSide)?.playable) c.hostSide = this.game.sc.defaultSides[0];
    this.game.s.speed = c.speed;
    this.game.s.paused = c.phase === 'lobby';
    this.knownOut = 0;
    this.setupAi();
  }

  private async saveCfg() {
    await this.ctx.storage.put('cfg', this.cfg);
    await this.ctx.storage.put('crews', this.crews);
    await this.persist();
  }

  private get factions(): Side[] {
    return this.game?.factions ?? ['USA', 'USSR'];
  }

  /** The host's main adversary: the scenario's default pairing, else the first hostile faction. */
  private mainEnemy(): Side {
    const g = this.game!;
    const host = this.cfg!.hostSide;
    const [a, b] = g.sc.defaultSides;
    const paired = host === a ? b : host === b ? a : undefined;
    if (paired && g.hostile(host, paired)) return paired;
    return g.hostilesOf(host)[0] ?? enemyOf(host);
  }

  /** A side reserved for the AI: only in two-player scenarios against an AI. */
  private aiSide(): Side | null {
    if (!this.cfg || this.factions.length > 2 || this.cfg.opponent === 'human') return null;
    return this.mainEnemy();
  }

  private online(player: string) {
    return [...this.conns.values()].some((o) => o.authed && o.player === player);
  }

  /** online now, or dropped less than SEAT_GRACE_MS ago */
  private present(m: CrewMember) {
    return this.online(m.player) || Date.now() - Math.max(m.leftAt ?? 0, this.bootAt) < SEAT_GRACE_MS;
  }

  /** a human crew holds this nation */
  private held(side: Side): boolean {
    return (this.crews[side] ?? []).some((m) => this.present(m));
  }

  /** Is the AI playing this side right now? */
  private aiPlays(side: Side): boolean {
    if (this.game?.isOut(side)) return false;
    if (this.factions.length <= 2) return side === this.aiSide();
    return !this.held(side);
  }

  /** seat order offered to newcomers: the host's side, then its adversaries, then everyone else */
  private seatPreference(): Side[] {
    const host = this.cfg!.hostSide;
    const g = this.game!;
    const order = [host, this.mainEnemy(), ...g.hostilesOf(host), ...this.factions];
    return [...new Set(order)].filter((f) => g.faction(f)?.playable !== false && !g.isOut(f));
  }

  private crewOf(player: string): { side: Side; member: CrewMember } | null {
    for (const f of this.factions) {
      const m = (this.crews[f] ?? []).find((x) => x.player === player);
      if (m) return { side: f, member: m };
    }
    return null;
  }

  private isHost(c: Live) {
    if (this.cfg!.hostPlayer) return c.player === this.cfg!.hostPlayer;
    return (this.crews[this.cfg!.hostSide] ?? [])[0]?.player === c.player;
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
    if (c?.authed && !this.online(c.player)) {
      const mine = this.crewOf(c.player);
      if (mine) { mine.member.leftAt = Date.now(); this.ctx.storage.put('crews', this.crews); }
    }
    if (c?.authed) this.sendRoom();
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
        c.role = this.autoSeat(c, m.role ?? this.defaultRole(c));
        c.authed = true;
        c.eventIdx = Math.max(0, game.s.events.length - 200);
        this.saveConn(ws, c);
        this.welcome(ws, c);
        if (c.role !== 'SPECTATOR' && m.role && m.role !== c.role && m.role !== 'SPECTATOR') this.send(ws, { t: 'result', ok: false, msg: `${m.role} IS TAKEN — YOU HAVE ${c.role}` });
        // announce people, not screens: extra tabs and reconnects of the same player stay quiet
        const already = [...this.conns.entries()].some(([w, o]) => w !== ws && o.authed && o.player === c.player);
        if (!already && Date.now() - (this.lastJoin.get(c.player) ?? 0) > 300_000) {
          game.emit({ kind: 'info', text: `${c.name} JOINED${c.role === 'SPECTATOR' ? ' AS SPECTATOR' : ` — ${c.role} ${BRANCH_LABEL[this.crewOf(c.player)?.member.branch ?? 'commander']}`}` });
        }
        this.lastJoin.set(c.player, Date.now());
        this.sendRoom();
        this.updateLoop();
        return;
      }
      case 'seat':
        return this.changeSeat(ws, c, m.role, m.branch ?? 'commander');
      case 'config': {
        if (!this.isHost(c)) return this.send(ws, { t: 'result', ok: false, msg: 'ONLY THE HOST CHANGES THE MATCH SETTINGS' });
        if (this.cfg!.phase !== 'lobby') return this.send(ws, { t: 'result', ok: false, msg: 'SETTINGS ARE LOCKED ONCE THE MATCH HAS STARTED' });
        const cfg = this.cfg!;
        const scenarioChanged = !!m.scenario && m.scenario !== cfg.scenario && !!SCENARIOS[m.scenario];
        if (scenarioChanged) cfg.scenario = m.scenario!;
        if (m.speed) cfg.speed = m.speed;
        if (m.personality !== undefined) cfg.personality = m.personality;
        if (m.opponent) cfg.opponent = m.opponent;
        if (m.endMode) cfg.endMode = m.endMode;
        if (scenarioChanged || m.endMode || m.opponent) {
          const old = this.crews;
          this.newGame();
          // keep everyone on the same nation if it exists in the new scenario
          this.crews = {};
          for (const f of this.factions) if (old[f]?.length && this.game!.faction(f)?.playable && f !== this.aiSide()) this.crews[f] = old[f];
          for (const [sock, cc] of this.conns) {
            if (!cc.authed) continue;
            const mine = this.crewOf(cc.player);
            cc.role = mine ? mine.side : this.autoSeat(cc, this.defaultRole(cc));
            cc.eventIdx = 0;
            this.saveConn(sock, cc);
            this.welcome(sock, cc);
          }
        } else {
          game.s.speed = cfg.speed;
          this.setupAi();
        }
        await this.saveCfg();
        this.sendRoom();
        return;
      }
      case 'start': {
        if (!this.isHost(c)) return this.send(ws, { t: 'result', ok: false, msg: 'ONLY THE HOST STARTS THE MATCH' });
        if (this.cfg!.phase !== 'lobby') return this.send(ws, { t: 'result', ok: true, msg: 'ALREADY RUNNING' });
        this.cfg!.phase = 'running';
        game.s.paused = false;
        game.s.speed = this.cfg!.speed;
        game.emit({ kind: 'info', text: `${c.name} STARTED THE MATCH — THE CLOCK IS RUNNING` });
        await this.saveCfg();
        this.sendRoom();
        this.updateLoop();
        return;
      }
      case 'endmatch': {
        if (!this.isHost(c)) return this.send(ws, { t: 'result', ok: false, msg: 'ONLY THE HOST ENDS THE MATCH' });
        game.endMatch(`MATCH ENDED BY ${c.name}`);
        this.flush();
        await this.persist();
        this.sendRoom();
        this.updateLoop();
        return;
      }
      case 'cmd': {
        if (this.cfg!.phase === 'lobby' && m.cmd.op !== 'hold') return this.send(ws, { t: 'result', id: m.id, ok: false, msg: 'THE MATCH HAS NOT STARTED — WAITING FOR THE HOST' });
        if (c.role === 'SPECTATOR' && m.cmd.op !== 'speed' && m.cmd.op !== 'pause') {
          return this.send(ws, { t: 'result', id: m.id, ok: false, msg: 'SPECTATORS CANNOT ISSUE ORDERS' });
        }
        if (c.role === 'SPECTATOR' && !this.isHost(c)) return this.send(ws, { t: 'result', id: m.id, ok: false, msg: 'ONLY PLAYERS CONTROL THE CLOCK' });
        const side = (c.role === 'SPECTATOR' ? this.cfg!.hostSide : c.role) as Side;
        if (c.role !== 'SPECTATOR') {
          const deny = this.denied(c, side, m.cmd);
          if (deny) return this.send(ws, { t: 'result', id: m.id, ok: false, msg: deny });
        }
        const res = game.apply(side, m.cmd);
        if (res.ok) game.emit({ kind: 'info', visibleTo: [side], side, text: `[${c.name}] ${game.describe(m.cmd)} — ${res.msg}` });
        this.send(ws, { t: 'result', id: m.id, ok: res.ok, msg: res.msg });
        if (m.cmd.op === 'pause' || m.cmd.op === 'speed') this.updateLoop();
        if (m.cmd.op === 'resign' && res.ok) this.afterElimination();
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
          const deny = this.denied(c, entry.side, cmd);
          const r = deny ? { ok: false, msg: deny } : game.apply(entry.side, cmd);
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
        this.cfg!.seed = m.seed ?? Math.floor(Math.random() * 1e9);
        this.cfg!.phase = 'lobby';
        this.newGame();
        for (const [sock, cc] of this.conns) {
          if (!cc.authed) continue;
          const mine = this.crewOf(cc.player);
          cc.role = mine && !this.game!.isOut(mine.side) ? mine.side : this.autoSeat(cc, this.defaultRole(cc));
          cc.eventIdx = 0;
          this.saveConn(sock, cc);
          this.welcome(sock, cc);
        }
        await this.saveCfg();
        this.sendRoom();
        this.updateLoop();
        return this.send(ws, { t: 'result', ok: true, msg: 'NEW MATCH SET UP — BACK IN THE LOBBY' });
      }
      case 'save':
      case 'load':
        return this.send(ws, { t: 'result', ok: false, msg: 'ONLINE MATCHES SAVE AUTOMATICALLY' });
      case 'share':
        return this.send(ws, { t: 'share', info: { lan: true, host: new URL(this.cfg!.origin).host, port: 443, links: this.shareLinks(c.role) } });
      case 'ping':
        return this.send(ws, { t: 'pong' });
    }
  }

  private welcome(ws: WebSocket, c: Live) {
    const g = this.game!;
    this.send(ws, {
      t: 'welcome', role: c.role, world: g.staticWorld(), link: makeMatchLink(this.cfg!.origin, this.cfg!.code), match: this.info(), you: c.name,
      aiOpponent: this.cfg!.opponent === 'human' && this.factions.length <= 2 ? undefined : this.cfg!.opponent === 'byok' ? 'AI (host key)' : 'doctrine AI',
    });
    this.send(ws, { t: 'snap', snap: g.snapshot(c.role) });
  }

  private shareLinks(role: Role) {
    const origin = this.cfg!.origin;
    const code = this.cfg!.code;
    const side = role === 'SPECTATOR' ? this.cfg!.hostSide : role;
    const links = [
      { label: 'Invite a friend (they pick a seat in the lobby)', url: makeMatchLink(origin, code), kind: 'web' as const },
      { label: `Your side (${side}) on another screen or phone`, url: makeMatchLink(origin, code, side), kind: 'web' as const },
      { label: 'Spectator wall (TV / big screen)', url: `${makeMatchLink(origin, code, 'SPECTATOR')}&preset=wall`, kind: 'web' as const },
      { label: 'Terminal (any PC)', url: `npx coldlaunch --join ${makeMatchLink(origin, code, side)}`, kind: 'terminal' as const },
    ];
    return links;
  }

  // ------------------------------------------------------------------ seats and crews

  /**
   * Seat a client on connect. A player keeps the nation (and branch) they hold, on as many screens
   * as they like. A newcomer gets the requested nation if nobody holds it, else the next free one in
   * the host's preference order, else they watch. Sharing a nation with another player is an
   * explicit choice in the lobby (seat message with a branch).
   */
  private autoSeat(c: Live, want: Role): Role {
    const g = this.game!;
    const mine = this.crewOf(c.player);
    if (mine) {
      mine.member.leftAt = undefined;
      mine.member.name = c.name;
      if (g.isOut(mine.side)) return 'SPECTATOR';
      // spectators see every side; a seated player can't also watch as one (human matches)
      if (want === 'SPECTATOR' && this.cfg!.opponent !== 'human') return 'SPECTATOR';
      return mine.side;
    }
    if (want === 'SPECTATOR') return 'SPECTATOR';
    const free = (f: Side) => f !== this.aiSide() && !this.held(f) && g.faction(f)?.playable !== false && !g.isOut(f);
    if (!this.factions.includes(want) || !free(want)) {
      const alt = this.seatPreference().find(free);
      if (!alt) return 'SPECTATOR';
      want = alt;
    }
    this.join(want, c, 'commander');
    return want;
  }

  private defaultRole(c: Live): Role {
    const mine = this.crewOf(c.player);
    if (mine) return mine.side;
    return this.seatPreference().find((f) => f !== this.aiSide() && !this.held(f)) ?? 'SPECTATOR';
  }

  private join(side: Side, c: Live, branch: Branch) {
    this.leave(c.player);
    // drop members who left long ago, so their branch is free again
    const crew = (this.crews[side] ?? []).filter((m) => this.present(m));
    crew.push({ player: c.player, name: c.name, branch });
    this.crews[side] = crew;
    this.ctx.storage.put('crews', this.crews);
  }

  private leave(player: string) {
    for (const f of Object.keys(this.crews)) {
      const crew = this.crews[f]!.filter((m) => m.player !== player);
      if (crew.length) this.crews[f] = crew; else delete this.crews[f];
    }
  }

  /** Explicit seat change from the lobby (or, during play, taking over an AI nation / watching). */
  private changeSeat(ws: WebSocket, c: Live, role: Role, branch: Branch) {
    const g = this.game!;
    const running = this.cfg!.phase !== 'lobby';
    if (role === 'SPECTATOR') {
      if (running && this.cfg!.opponent === 'human' && this.crewOf(c.player) && !g.isOut(this.crewOf(c.player)!.side)) {
        return this.send(ws, { t: 'result', ok: false, msg: 'IN A MATCH BETWEEN PEOPLE YOU CANNOT WATCH WHILE YOUR NATION FIGHTS — RESIGN FIRST' });
      }
      this.leave(c.player);
    } else {
      if (!this.factions.includes(role) || g.faction(role)?.playable === false) return this.send(ws, { t: 'result', ok: false, msg: `NO NATION ${role}` });
      if (role === this.aiSide()) return this.send(ws, { t: 'result', ok: false, msg: `${role} IS PLAYED BY THE AI IN THIS MATCH` });
      if (g.isOut(role)) return this.send(ws, { t: 'result', ok: false, msg: `${role} IS OUT OF THE WAR` });
      const crew = (this.crews[role] ?? []).filter((m) => m.player !== c.player && this.present(m));
      const holder = crew.find((m) => m.branch === branch);
      if (holder) return this.send(ws, { t: 'result', ok: false, msg: `${BRANCH_LABEL[branch]} OF ${role} IS TAKEN BY ${holder.name}` });
      const mine = this.crewOf(c.player);
      if (running && mine && mine.side !== role && !g.isOut(mine.side)) return this.send(ws, { t: 'result', ok: false, msg: 'YOU CANNOT CHANGE NATION DURING THE MATCH' });
      this.join(role, c, branch);
    }
    // every screen of this player follows
    for (const [sock, cc] of this.conns) {
      if (!cc.authed || cc.player !== c.player) continue;
      cc.role = role;
      cc.eventIdx = Math.max(0, g.s.events.length - 200);
      this.saveConn(sock, cc);
      this.welcome(sock, cc);
    }
    this.sendRoom();
  }

  /** Branch that an order belongs to (who in the crew may give it). */
  private branchFor(side: Side, cmd: Command): Branch | null {
    const g = this.game!;
    const kindOf = (ref: string) => { const u = g.resolveOwn(side, ref); return typeof u === 'string' ? undefined : u; };
    switch (cmd.op) {
      case 'defcon': case 'hotline': case 'resign': return 'commander';
      case 'speed': case 'pause': case 'hold': return null;
      case 'launch': return kindOf(cmd.from)?.kind === 'ssbn' ? 'navy' : 'rocket';
      case 'scramble': case 'strike': return 'air';
      case 'cruise': return 'navy';
      case 'sortie': return kindOf(cmd.from)?.kind === 'carrier' ? 'navy' : 'air';
      case 'recall': case 'move': {
        const u = kindOf(cmd.unit);
        if (!u) return null;
        if (u.kind === 'carrier' || u.kind === 'ssbn' || u.kind === 'ssn') return 'navy';
        if (u.kind === 'flight') return g.unit(u.home ?? '')?.kind === 'carrier' ? 'navy' : 'air';
        return 'air';
      }
    }
    return null;
  }

  /** Why this crew member may not give this order (null = allowed). */
  private denied(c: Live, side: Side, cmd: Command): string | null {
    const br = this.branchFor(side, cmd);
    if (!br) return null;
    const crew = this.crews[side] ?? [];
    if (crew.length <= 1) return null;
    const me = crew.find((m) => m.player === c.player);
    if (!me) return null;
    if (me.branch === br) return null;
    const holder = crew.find((m) => m.player !== c.player && m.branch === br && this.present(m));
    if (me.branch === 'commander') return holder ? `${BRANCH_LABEL[br]} IS COMMANDED BY ${holder.name}` : null;
    if (br === 'commander') {
      const cmdr = crew.find((m) => m.branch === 'commander' && this.present(m));
      return cmdr ? `ONLY THE COMMANDER (${cmdr.name}) CAN DO THAT` : null;
    }
    // nobody holds that branch: the commander is responsible for it, otherwise anyone may act
    const cmdr = crew.find((m) => m.branch === 'commander' && this.present(m));
    return holder || cmdr ? `THAT IS ${BRANCH_LABEL[br]} BUSINESS — YOU COMMAND ${BRANCH_LABEL[me.branch]}` : null;
  }

  /** Players of nations that just dropped out become spectators. */
  private afterElimination() {
    const g = this.game!;
    const out = g.s.out ?? [];
    if (out.length === this.knownOut) return;
    this.knownOut = out.length;
    for (const [ws, cc] of this.conns) {
      if (!cc.authed || !out.includes(cc.role)) continue;
      const was = cc.role;
      cc.role = 'SPECTATOR';
      cc.eventIdx = Math.max(0, g.s.events.length - 200);
      this.saveConn(ws, cc);
      this.welcome(ws, cc);
      this.send(ws, { t: 'result', ok: false, msg: `${was} IS OUT OF THE WAR — YOU ARE NOW WATCHING THE OTHER NATIONS` });
    }
    this.sendRoom();
  }

  private saveConn(ws: WebSocket, c: Live) {
    const { eventIdx, ...a } = c;
    ws.serializeAttachment(a);
  }

  // ------------------------------------------------------------------ AI (doctrine here, LLM in the player's browser)

  private setupAi() {
    this.listeners.clear();
    this.opponents = [];
    if (!this.game) return;
    const g = this.game;
    // two-player scenarios: one AI for the reserved side; multi-faction: one per faction, active only
    // while no human crew holds that seat (a friend who joins takes over; if they leave for good the AI resumes)
    const sides = this.factions.length > 2 ? this.factions : this.aiSide() ? [this.aiSide()!] : [];
    for (const side of sides) {
      const host: AiHost = {
        game: g,
        submit: (s: Side, cmd: Command, source = 'ai') => {
          const res = this.game!.apply(s, cmd);
          if (res.ok && cmd.op !== 'hold') this.game!.emit({ kind: 'ai', visibleTo: [s], side: s, text: `[${source.toUpperCase()}] ${this.game!.describe(cmd)} — ${res.msg}` });
          return res;
        },
        onTick: (fn) => {
          const gated = (gg: Game) => { if (this.aiPlays(side)) fn(gg); };
          this.listeners.add(gated);
          return () => this.listeners.delete(gated);
        },
      };
      const byok = this.cfg!.opponent === 'byok' && side === this.mainEnemy();
      const provider: LlmProvider | 'rules' = byok ? this.relayProvider('opponent', side) : 'rules';
      const personality = this.factions.length > 2 && !g.hostile(this.cfg!.hostSide, side) ? 0.4 : this.cfg!.personality;
      const ai = new AiOpponent(host, side, provider, { personality, cadenceSec: 90 });
      ai.attach();
      this.opponents.push(ai);
    }
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

  /** Run the clock only while the match runs, someone is connected and it isn't paused/over; otherwise allow hibernation. */
  private updateLoop() {
    const g = this.game;
    const anyone = [...this.conns.values()].some((c) => c.authed);
    const live = !!g && this.cfg?.phase !== 'lobby' && anyone && !g.s.paused && !g.s.over;
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
    if ((g.s.out?.length ?? 0) !== this.knownOut) this.afterElimination();
    this.flush(this.tickN % SNAP_EVERY === 0);
    if (g.s.events.length > MAX_EVENTS) this.trimEvents();
    if (Date.now() - this.lastPersist > PERSIST_MS) this.persist();
    if (g.s.paused || g.s.over) { if (g.s.over) this.sendRoom(); this.updateLoop(); }
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

  // ------------------------------------------------------------------ room state and roster

  /** Send everyone the room (lobby / crews / settings) and the roster, each from their own point of view. */
  private sendRoom() {
    if (!this.cfg || !this.game) return;
    const g = this.game;
    const cfg = this.cfg;
    const list = [...this.conns.entries()].filter(([, c]) => c.authed);
    for (const [ws, me] of list) {
      const players: RosterEntry[] = list.map(([w, c]) => ({ name: c.name, role: c.role, kind: c.kind, ai: c.ai, you: w === ws || undefined }));
      for (const f of this.factions) {
        if (this.aiPlays(f)) players.push({ name: cfg.opponent === 'byok' && f === this.mainEnemy() ? 'AI (YOUR KEY)' : 'AI', role: f, kind: 'ai', ai: true });
      }
      this.send(ws, { t: 'roster', players });
      const state: LobbyState = {
        phase: g.s.over ? 'over' : cfg.phase === 'lobby' ? 'lobby' : 'running',
        host: cfg.host,
        youAreHost: this.isHost(me),
        options: { scenario: cfg.scenario, scenarioName: g.sc.name, speed: cfg.speed, personality: cfg.personality, opponent: cfg.opponent, endMode: cfg.endMode ?? 'open' },
        nations: g.sc.factions.map((f) => ({
          id: f.id, name: f.name, color: f.color, brief: f.brief, playable: f.playable,
          ai: this.aiPlays(f.id), reservedForAi: f.id === this.aiSide(), out: g.isOut(f.id),
          crew: (this.crews[f.id] ?? []).filter((m) => this.present(m)).map((m) => ({ name: m.name, branch: m.branch, online: this.online(m.player), you: m.player === me.player })),
        })),
        spectators: [...new Map(list.filter(([, c]) => c.role === 'SPECTATOR').map(([, c]) => [c.player, { name: c.name, you: c.player === me.player }])).values()],
        you: { role: me.role, branch: this.crewOf(me.player)?.member.branch },
      };
      this.send(ws, { t: 'lobby', state });
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

/** Matches from before crews stored one holder per nation. */
function migrateSeats(old: unknown): Partial<Record<Side, CrewMember[]>> {
  const out: Partial<Record<Side, CrewMember[]>> = {};
  if (!old || typeof old !== 'object') return out;
  for (const [f, v] of Object.entries(old as Record<string, { player: string; name: string; leftAt?: number }>)) {
    if (v?.player) out[f] = [{ player: v.player, name: v.name, branch: 'commander', leftAt: v.leftAt }];
  }
  return out;
}
