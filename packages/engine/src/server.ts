import { WebSocketServer, type WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join, normalize, extname } from 'node:path';
import {
  ClientMsgSchema, makeLink, type Command, type PlanProposal, type Role, type ServerMsg, type Side,
} from '@coldlaunch/shared';
import { Game, TICK_SEC } from './game.ts';

export interface Advisor {
  (side: Side, text: string, game: Game): Promise<PlanProposal | { error: string }>;
}

interface Client {
  ws: WebSocket;
  role: Role;
  kind: string;
  eventIdx: number;
  authed: boolean;
}

export interface ServerOptions {
  port: number;
  host?: string;
  token?: string;
  game?: Game;
  playerSide?: Side;
  advisor?: Advisor;
  savesDir?: string;
  aiSides?: Side[];
  aiLabel?: string;
  /** directory with the built web wall display (packages/gui/dist); served over HTTP */
  staticDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};

export class GameServer {
  game: Game;
  readonly token: string;
  readonly port: number;
  readonly host: string;
  readonly playerSide: Side;
  private wss?: WebSocketServer;
  private http?: Server;
  staticDir?: string;
  private clients = new Set<Client>();
  private timer?: NodeJS.Timeout;
  private tickN = 0;
  private plans = new Map<string, { side: Side; plan: PlanProposal }>();
  private listeners = new Set<(g: Game) => void>();
  private savesDir: string;
  advisor?: Advisor;
  aiSides: Side[];
  aiLabel?: string;

  constructor(opts: ServerOptions) {
    this.port = opts.port;
    this.host = opts.host ?? '127.0.0.1';
    this.token = opts.token ?? randomBytes(6).toString('hex');
    this.game = opts.game ?? new Game();
    this.playerSide = opts.playerSide ?? 'USA';
    this.advisor = opts.advisor;
    this.aiSides = opts.aiSides ?? [];
    this.aiLabel = opts.aiLabel;
    this.savesDir = opts.savesDir ?? join(homedir(), '.coldlaunch', 'saves');
    this.staticDir = opts.staticDir;
  }

  /** Browser URL for the wall display (served by this server). */
  /** Host name other machines should use (set to the LAN IP when listening on 0.0.0.0). */
  publicHost?: string;

  webLink(role?: Role, preset?: string, forLan = false) {
    const host = forLan && this.publicHost ? this.publicHost : this.host === '0.0.0.0' ? '127.0.0.1' : this.host;
    const q = new URLSearchParams({ token: this.token });
    if (role) q.set('role', role);
    if (preset) q.set('preset', preset);
    return `http://${host}:${this.port}/?${q}`;
  }

  link(role?: Role, forLan = false) {
    const host = forLan && this.publicHost ? this.publicHost : this.host === '0.0.0.0' ? '127.0.0.1' : this.host;
    return makeLink(host, this.port, this.token, role);
  }

  async start() {
    this.http = createServer((req, res) => {
      const dir = this.staticDir;
      if (!dir || !existsSync(dir)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('wall display not built — run: npm run gui:build');
      }
      const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const file = normalize(join(dir, path === '/' ? 'index.html' : path));
      if (!file.startsWith(normalize(dir)) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      createReadStream(file).pipe(res);
    });
    this.wss = new WebSocketServer({ server: this.http, maxPayload: 64 * 1024 });
    this.wss.on('connection', (ws) => this.onConnect(ws));
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(this.port, this.host, () => resolve());
    });
    this.timer = setInterval(() => this.loop(), TICK_SEC * 1000);
  }

  stop() {
    clearInterval(this.timer);
    for (const c of this.clients) c.ws.close();
    this.wss?.close();
    this.http?.close();
  }

  /** Called every tick (AI drivers subscribe here). */
  onTick(fn: (g: Game) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Submit a command on behalf of a side (used by in-process AI). */
  submit(side: Side, cmd: Command, source = 'ai') {
    const res = this.game.apply(side, cmd);
    if (res.ok && cmd.op !== 'hold') {
      this.game.emit({ kind: 'ai', visibleTo: [side], side, text: `[${source.toUpperCase()}] ${this.game.describe(cmd)} — ${res.msg}` });
    }
    return res;
  }

  private loop() {
    this.game.step();
    this.tickN++;
    for (const fn of this.listeners) {
      try { fn(this.game); } catch (e) { console.error(e); }
    }
    const sendSnap = this.tickN % 2 === 0; // 5 Hz
    for (const c of this.clients) {
      if (!c.authed) continue;
      const evs = this.game.eventsFor(c.role, c.eventIdx);
      c.eventIdx = this.game.s.events.length;
      if (evs.length) this.send(c, { t: 'events', events: evs });
      if (sendSnap) this.send(c, { t: 'snap', snap: this.game.snapshot(c.role) });
    }
  }

  private send(c: Client, msg: ServerMsg) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private broadcast(role: Role | 'ALL', msg: ServerMsg, except?: Client) {
    for (const c of this.clients) {
      if (!c.authed || c === except) continue;
      if (role === 'ALL' || c.role === role || c.role === 'SPECTATOR') this.send(c, msg);
    }
  }

  private onConnect(ws: WebSocket) {
    const c: Client = { ws, role: 'SPECTATOR', kind: 'other', eventIdx: 0, authed: false };
    this.clients.add(c);
    ws.on('close', () => this.clients.delete(c));
    ws.on('message', (data) => {
      let raw: unknown;
      try { raw = JSON.parse(String(data)); } catch { return this.send(c, { t: 'error', msg: 'bad json' }); }
      const parsed = ClientMsgSchema.safeParse(raw);
      if (!parsed.success) return this.send(c, { t: 'error', msg: `bad message: ${parsed.error.issues[0]?.message}` });
      const m = parsed.data;
      if (!c.authed && m.t !== 'hello') return this.send(c, { t: 'error', msg: 'hello first' });
      this.handle(c, m).catch((e) => this.send(c, { t: 'error', msg: String(e?.message ?? e) }));
    });
  }

  private async handle(c: Client, m: ReturnType<typeof ClientMsgSchema.parse>) {
    switch (m.t) {
      case 'hello': {
        if (m.token !== this.token) {
          this.send(c, { t: 'error', msg: 'invalid session token' });
          c.ws.close();
          return;
        }
        c.authed = true;
        c.kind = m.client;
        c.role = m.role ?? this.playerSide;
        // new clients get the recent event backlog
        c.eventIdx = Math.max(0, this.game.s.events.length - 200);
        this.send(c, { t: 'welcome', role: c.role, world: this.game.staticWorld(), link: this.link(), aiOpponent: this.aiLabel });
        this.send(c, { t: 'snap', snap: this.game.snapshot(c.role) });
        return;
      }
      case 'cmd': {
        if (c.role === 'SPECTATOR' && m.cmd.op !== 'speed' && m.cmd.op !== 'pause') {
          return this.send(c, { t: 'result', id: m.id, ok: false, msg: 'SPECTATORS CANNOT ISSUE ORDERS' });
        }
        const side = (c.role === 'SPECTATOR' ? this.playerSide : c.role) as Side;
        const res = this.game.apply(side, m.cmd);
        if (res.ok && c.kind !== 'tui') {
          this.game.emit({ kind: 'info', visibleTo: [side], side, text: `[${c.kind.toUpperCase()}] ${this.game.describe(m.cmd)} — ${res.msg}` });
        }
        return this.send(c, { t: 'result', id: m.id, ok: res.ok, msg: res.msg });
      }
      case 'focus':
        return this.broadcast(c.role, { t: 'focus', focus: m.focus, from: c.kind }, c);
      case 'ask': {
        if (c.role === 'SPECTATOR') return this.send(c, { t: 'result', id: m.id, ok: false, msg: 'SPECTATOR' });
        if (!this.advisor) return this.send(c, { t: 'result', id: m.id, ok: false, msg: 'NO AI ADVISOR CONFIGURED — SET GEMINI_API_KEY OR ANTHROPIC_API_KEY' });
        const side = c.role as Side;
        const out = await this.advisor(side, m.text, this.game);
        if ('error' in out) return this.send(c, { t: 'result', id: m.id, ok: false, msg: out.error });
        this.plans.set(out.id, { side, plan: out });
        this.send(c, { t: 'plan', plan: out, askId: m.id });
        this.broadcast(side, { t: 'planPreview', plan: out }, c);
        return;
      }
      case 'plan': {
        const entry = this.plans.get(m.id);
        this.plans.delete(m.id);
        this.broadcast(c.role, { t: 'planPreview', plan: null });
        if (!entry || !m.cmds) return this.send(c, { t: 'result', id: m.id, ok: true, msg: 'PLAN DISCARDED' });
        const msgs: string[] = [];
        let ok = true;
        for (const cmd of m.cmds) {
          const r = this.game.apply(entry.side, cmd);
          ok &&= r.ok;
          msgs.push(`${r.ok ? '✓' : '✗'} ${this.game.describe(cmd)}: ${r.msg}`);
        }
        return this.send(c, { t: 'result', id: m.id, ok, msg: msgs.join('\n') });
      }
      case 'save': {
        mkdirSync(this.savesDir, { recursive: true });
        writeFileSync(join(this.savesDir, `${m.name}.json`), this.game.serialize());
        return this.send(c, { t: 'result', ok: true, msg: `SAVED ${m.name}` });
      }
      case 'load': {
        const f = join(this.savesDir, `${m.name}.json`);
        if (!existsSync(f)) return this.send(c, { t: 'result', ok: false, msg: `NO SAVE NAMED ${m.name}` });
        this.game = Game.deserialize(readFileSync(f, 'utf8'));
        this.resetClients();
        return this.send(c, { t: 'result', ok: true, msg: `LOADED ${m.name}` });
      }
      case 'newgame': {
        this.game = new Game(m.seed);
        this.resetClients();
        return this.send(c, { t: 'result', ok: true, msg: 'NEW SCENARIO STARTED' });
      }
      case 'ping':
        return this.send(c, { t: 'pong' });
    }
  }

  private resetClients() {
    for (const c of this.clients) {
      if (!c.authed) continue;
      c.eventIdx = 0;
      this.send(c, { t: 'welcome', role: c.role, world: this.game.staticWorld(), link: this.link(), aiOpponent: this.aiLabel });
    }
  }
}
