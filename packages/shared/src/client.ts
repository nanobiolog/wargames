// WebSocket game client shared by the terminal, the Electron GUI and the MCP server.
// Uses the global WebSocket (browsers, Electron, Node >= 22).
import {
  parseLink, type ClientMsg, type Command, type Focus, type PlanProposal, type ServerMsg,
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
  events: GameEvent[] = [];
  connected = false;
  private ws?: WebSocket;
  private seq = 0;
  private pending = new Map<string, (r: Result) => void>();
  private pendingAsk = new Map<string, (r: PlanProposal | Result) => void>();
  private ls = {
    snap: new Set<Listener<Snapshot>>(),
    events: new Set<Listener<GameEvent[]>>(),
    focus: new Set<Listener<{ focus: Focus; from: string }>>(),
    plan: new Set<Listener<PlanProposal | null>>(),
    status: new Set<Listener<string>>(),
    welcome: new Set<Listener<StaticWorld>>(),
  };
  private closedByUser = false;

  constructor(private kind: 'tui' | 'gui' | 'mcp' | 'other') {}

  on<K extends keyof GameClient['ls']>(ev: K, fn: GameClient['ls'][K] extends Set<infer L> ? L : never) {
    (this.ls[ev] as Set<unknown>).add(fn);
    return () => (this.ls[ev] as Set<unknown>).delete(fn);
  }

  private fire<K extends keyof GameClient['ls']>(ev: K, v: unknown) {
    for (const fn of this.ls[ev] as Set<Listener<unknown>>) fn(v);
  }

  connect(link: string, role?: Role): Promise<void> {
    const p = parseLink(link);
    if (!p) return Promise.reject(new Error(`invalid link: ${link}`));
    this.link = link;
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(`ws://${p.host}:${p.port}/`);
      this.ws = ws;
      ws.onopen = () => {
        this.raw({ t: 'hello', token: p.token, role: role ?? p.role, client: this.kind });
      };
      ws.onmessage = (ev) => {
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
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`cannot reach game server at ${p.host}:${p.port}`));
        }
      };
      ws.onclose = () => {
        this.connected = false;
        this.fire('status', 'disconnected');
        if (!this.closedByUser && settled) setTimeout(() => this.connect(link, role).catch(() => {}), 1500);
      };
    });
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
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
        if (!f && !a) this.fire('status', m.msg);
        break;
      }
      case 'plan': {
        const a = m.askId ? this.pendingAsk.get(m.askId) : undefined;
        if (a && m.askId) { this.pendingAsk.delete(m.askId); a(m.plan); }
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
    }
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

  focus(f: Focus) {
    this.raw({ t: 'focus', focus: f });
  }

  save(name: string) { this.raw({ t: 'save', name }); }
  load(name: string) { this.raw({ t: 'load', name }); }
  newGame(seed?: number) { this.raw({ t: 'newgame', seed }); }
}
