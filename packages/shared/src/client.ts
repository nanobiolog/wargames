// WebSocket game client shared by the terminal, the Electron GUI and the MCP server.
// Uses the global WebSocket (browsers, Electron, Node >= 22).
import {
  parseLink, wsUrl, type AiJob, type LobbyState, type MatchInfo, type RosterEntry, type ClientMsg, type Command, type Focus, type PlanProposal, type ServerMsg, type ShareInfo,
} from './protocol.ts';
import type { GameEvent, Role, Snapshot, StaticWorld } from './types.ts';

type Listener<T> = (v: T) => void;

export interface Result {
  ok: boolean;
  msg: string;
}

export class GameClient {
  snap?: Snapshot;
  world?: StaticWorld;
  role?: Role;
  link?: string;
  aiOpponent?: string;
  match?: MatchInfo;
  roster: RosterEntry[] = [];
  /** online match room state (pre-game lobby, crews) */
  lobby?: LobbyState;
  events: GameEvent[] = [];
  /** identity sent in hello (online matches) */
  identity: { name?: string; player?: string; tag?: string; caps?: 'ai'[] } = {};
  connected = false;
  private ws?: WebSocket;
  private seq = 0;
  private pending = new Map<string, (r: Result) => void>();
  private pendingAsk = new Map<string, (r: PlanProposal | Result) => void>();
  private pendingShare: ((i: ShareInfo | Result) => void)[] = [];
  private ls = {
    snap: new Set<Listener<Snapshot>>(),
    events: new Set<Listener<GameEvent[]>>(),
    focus: new Set<Listener<{ focus: Focus; from: string }>>(),
    plan: new Set<Listener<PlanProposal | null>>(),
    status: new Set<Listener<string>>(),
    welcome: new Set<Listener<StaticWorld>>(),
    roster: new Set<Listener<RosterEntry[]>>(),
    lobby: new Set<Listener<LobbyState>>(),
    aiJob: new Set<Listener<AiJob>>(),
    chat: new Set<Listener<{ from: string; role: Role; text: string }>>(),
  };
  private closedByUser = false;
  private gen = 0;
  private retry?: ReturnType<typeof setTimeout>;

  constructor(private kind: 'tui' | 'gui' | 'mcp' | 'other') {}

  on<K extends keyof GameClient['ls']>(ev: K, fn: GameClient['ls'][K] extends Set<infer L> ? L : never) {
    (this.ls[ev] as Set<unknown>).add(fn);
    return () => (this.ls[ev] as Set<unknown>).delete(fn);
  }

  private fire<K extends keyof GameClient['ls']>(ev: K, v: unknown) {
    for (const fn of this.ls[ev] as Set<Listener<unknown>>) fn(v);
  }

  /**
   * Connect to a session. Only one socket is ever live: connecting again (e.g. accepting an invite
   * while already in a match) closes the previous socket, and events from stale sockets are ignored.
   * Before this, a second connect() left the old socket running, both fed snapshots into this client
   * and the display alternated between the two seats (USA ⇄ USSR / spectator flicker).
   */
  connect(link: string, role?: Role): Promise<void> {
    const p = parseLink(link);
    if (!p) return Promise.reject(new Error(`invalid link: ${link}`));
    this.detach();
    this.link = link;
    this.closedByUser = false;
    const gen = ++this.gen;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl(p));
      this.ws = ws;
      const live = () => gen === this.gen;
      ws.addEventListener('open', () => {
        if (live()) this.raw({ t: 'hello', token: p.token, role: role ?? p.role, client: this.kind, ...this.identity });
      });
      ws.addEventListener('message', (ev: MessageEvent) => {
        if (!live()) return;
        const msg = JSON.parse(String(ev.data)) as ServerMsg;
        if (msg.t === 'welcome' && !settled) {
          settled = true;
          resolve();
        }
        if (msg.t === 'error' && !settled) {
          settled = true;
          reject(new Error(msg.msg));
        }
        this.onMsg(msg);
      });
      ws.addEventListener('error', () => {
        if (live() && !settled) {
          settled = true;
          reject(new Error(`cannot reach game server at ${p.host}:${p.port}`));
        }
      });
      ws.addEventListener('close', () => {
        if (!live()) return;
        this.connected = false;
        this.fire('status', 'disconnected');
        if (this.closedByUser || !settled) return;
        // come back to the seat we actually hold, not the one first asked for
        const again = this.role ?? role;
        this.retry = setTimeout(() => { if (live()) this.connect(link, again).catch(() => {}); }, 1500 + Math.random() * 1500);
      });
    });
  }

  /** Drop the current socket without triggering a reconnect. */
  private detach() {
    clearTimeout(this.retry);
    this.gen++;
    const old = this.ws;
    this.ws = undefined;
    if (old && old.readyState <= 1) { try { old.close(); } catch { /* ignore */ } }
    this.connected = false;
  }

  close() {
    this.closedByUser = true;
    this.detach();
  }

  private raw(m: ClientMsg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  private onMsg(m: ServerMsg) {
    switch (m.t) {
      case 'welcome':
        this.connected = true;
        this.role = m.role;
        this.world = m.world;
        this.aiOpponent = m.aiOpponent;
        this.match = m.match;
        this.events = [];
        this.fire('welcome', m.world);
        this.fire('status', 'connected');
        break;
      case 'snap':
        this.snap = m.snap;
        this.fire('snap', m.snap);
        break;
      case 'events':
        this.events.push(...m.events);
        if (this.events.length > 1000) this.events.splice(0, this.events.length - 1000);
        this.fire('events', m.events);
        break;
      case 'result': {
        const f = m.id ? this.pending.get(m.id) : undefined;
        if (f && m.id) { this.pending.delete(m.id); f({ ok: m.ok, msg: m.msg }); }
        const a = m.id ? this.pendingAsk.get(m.id) : undefined;
        if (a && m.id) { this.pendingAsk.delete(m.id); a({ ok: m.ok, msg: m.msg }); }
        if (!f && !a && !m.ok && this.pendingShare.length) { this.pendingShare.shift()!({ ok: false, msg: m.msg }); break; }
        if (!f && !a) this.fire('status', m.msg);
        break;
      }
      case 'plan': {
        const a = m.askId ? this.pendingAsk.get(m.askId) : undefined;
        if (a && m.askId) { this.pendingAsk.delete(m.askId); a(m.plan); }
        break;
      }
      case 'share': {
        const f = this.pendingShare.shift();
        f?.(m.info);
        break;
      }
      case 'planPreview':
        this.fire('plan', m.plan);
        break;
      case 'focus':
        this.fire('focus', { focus: m.focus, from: m.from });
        break;
      case 'error':
        this.fire('status', `ERROR: ${m.msg}`);
        break;
      case 'roster':
        this.roster = m.players;
        this.fire('roster', m.players);
        break;
      case 'lobby':
        this.lobby = m.state;
        this.fire('lobby', m.state);
        break;
      case 'aiJob':
        this.fire('aiJob', m.job);
        break;
      case 'chat':
        this.fire('chat', { from: m.from, role: m.role, text: m.text });
        break;
    }
  }

  /** Return the result of an aiJob (online matches; the key never leaves this device). */
  aiResult(r: Extract<ClientMsg, { t: 'aiResult' }>) {
    this.raw(r);
  }

  chat(text: string) {
    this.raw({ t: 'chat', text });
  }

  /** Online match room: take a seat (nation + branch) or watch. */
  takeSeat(role: Role, branch?: 'commander' | 'navy' | 'air' | 'rocket') {
    this.raw({ t: 'seat', role, branch });
  }

  /** Host, before the start: change settings. */
  configure(opts: Omit<Extract<ClientMsg, { t: 'config' }>, 't'>) {
    this.raw({ t: 'config', ...opts });
  }

  /** Host: start the clock / end the match. */
  startMatch() { this.raw({ t: 'start' }); }
  endMatch() { this.raw({ t: 'endmatch' }); }

  /** Heartbeat (online matches keep their server awake only while the clock runs). */
  ping() {
    this.raw({ t: 'ping' });
  }

  cmd(cmd: Command): Promise<Result> {
    const id = `c${++this.seq}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.raw({ t: 'cmd', id, cmd });
      setTimeout(() => {
        if (this.pending.delete(id)) resolve({ ok: false, msg: 'TIMEOUT' });
      }, 10000);
    });
  }

  ask(text: string): Promise<PlanProposal | Result> {
    const id = `a${++this.seq}`;
    return new Promise((resolve) => {
      this.pendingAsk.set(id, resolve);
      this.raw({ t: 'ask', id, text });
      setTimeout(() => {
        if (this.pendingAsk.delete(id)) resolve({ ok: false, msg: 'ADVISOR TIMEOUT' });
      }, 90000);
    });
  }

  confirmPlan(id: string, cmds: Command[] | null): Promise<Result> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.raw({ t: 'plan', id, cmds });
    });
  }

  /** Get share links; enable=true opens the session to the LAN (host machine only). */
  share(enable = false): Promise<ShareInfo | Result> {
    return new Promise((resolve) => {
      this.pendingShare.push(resolve);
      this.raw({ t: 'share', enable });
      setTimeout(() => {
        const i = this.pendingShare.indexOf(resolve);
        if (i >= 0) { this.pendingShare.splice(i, 1); resolve({ ok: false, msg: 'TIMEOUT' }); }
      }, 8000);
    });
  }

  focus(f: Focus) {
    this.raw({ t: 'focus', focus: f });
  }

  save(name: string) { this.raw({ t: 'save', name }); }
  load(name: string) { this.raw({ t: 'load', name }); }
  newGame(seed?: number) { this.raw({ t: 'newgame', seed }); }
}
