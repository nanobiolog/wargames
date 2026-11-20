import {
  GameClient, parseCommandLine, describeCommand, GAME_COMMAND_HELP, DEFCON_NAMES, KIND_LABEL, PALETTE,
  distKm, fmtLatLon, ballisticPos, normLon, SPEED_STEPS,
  type GameEvent, type Side, type Unit, type Contact, type PlanProposal, type Snapshot, type Command, type Focus,
} from '@coldlaunch/shared';
import { loadPlaces } from '@coldlaunch/data';
import { Screen, hex, dim, type RGB } from './screen.ts';
import { MapView, LAYER_NAMES, type LayerName } from './mapview.ts';

const COL = {
  frame: hex('#1d4f8f'),
  title: hex('#7fd0ff'),
  text: hex(PALETTE.text),
  dim: dim(hex(PALETTE.text), 0.55),
  red: hex(PALETTE.counter),
  yellow: hex(PALETTE.warn),
  green: hex(PALETTE.ok),
  magenta: hex(PALETTE.reticle),
  white: [235, 245, 255] as RGB,
  orange: hex('#ff9a3c'),
  usa: hex(PALETTE.usa),
  ussr: hex(PALETTE.ussr),
  cyan: hex('#5fe3ff'),
  purple: hex('#c08cff'),
  hotline: hex('#7dffb0'),
};

const EVENT_COLOR: Record<GameEvent['kind'], RGB> = {
  info: COL.text, warn: COL.yellow, alert: COL.red, launch: COL.red, detect: COL.yellow, impact: COL.white,
  intercept: COL.cyan, destroyed: COL.orange, defcon: COL.magenta, hotline: COL.hotline, ai: COL.purple, end: COL.white,
};

const DEFCON_COLOR: Record<number, RGB> = { 5: COL.green, 4: hex('#5fd7ff'), 3: COL.yellow, 2: COL.orange, 1: COL.red };

const LOCAL_HELP: [string, string][] = [
  ['zoom <place|in|out|N>', 'zoom map (mouse wheel / + - also work)'],
  ['goto <place>', 'center map on a place, unit or lat,lon'],
  ['world | polar | flat', 'reset view / north-polar / flat projection'],
  ['layer <name> [on|off]', `toggle: ${LAYER_NAMES.join(' ')}`],
  ['select <unit> | track <unit>', 'select / follow a unit (click also selects)'],
  ['list [kind|enemy]', 'list your units (silo airbase bomber ssbn ssn carrier ...)'],
  ['ask <anything>', 'natural-language orders via your AI advisor'],
  ['focus', 'fly the GUI wall display to the current view'],
  ['gui | web [preset]', 'open the wall display (Electron / browser tab, e.g. web conus)'],
  ['link | keys', 'show session link / how to add AI API keys'],
  ['save <name> | load <name> | new', 'save / load / restart'],
  ['mouse on|off, bell on|off, sync on|off', 'terminal options'],
  ['quit', 'exit'],
];

export interface TuiOptions {
  openGui?: () => void;
  openWeb?: (preset?: string) => void;
  onQuit?: () => void;
}

interface LogLine {
  text: string;
  color: RGB;
  bold?: boolean;
}

export class TuiApp {
  private scr = new Screen();
  private map = new MapView();
  private input = '';
  private cursor = 0;
  private history: string[] = [];
  private histIdx = -1;
  private log: LogLine[] = [];
  private logScroll = 0;
  private selected: string | null = null;
  private tracking: string | null = null;
  private plan: PlanProposal | null = null;
  private busy = '';
  private dirty = true;
  private timer?: NodeJS.Timeout;
  private mouseOn = true;
  private bell = true;
  private sync = true;
  private drag: { x: number; y: number } | null = null;
  private mapRect = { x: 0, y: 1, w: 80, h: 20 };
  private places = loadPlaces();
  private lastSnapT = -1;

  constructor(private client: GameClient, private opts: TuiOptions = {}) {}

  start() {
    this.scr.enter();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => this.onKey(String(d)));
    process.stdout.on('resize', () => {
      this.scr.resize();
      this.scr.invalidate();
      this.dirty = true;
    });
    this.client.on('snap', (s: Snapshot) => {
      if (s.t !== this.lastSnapT) this.dirty = true;
      this.lastSnapT = s.t;
      if (this.tracking) {
        const u = this.findUnit(this.tracking);
        if (u) { this.map.lat = u.lat; this.map.lon = u.lon; }
      }
    });
    this.client.on('events', (evs: GameEvent[]) => {
      for (const e of evs) this.pushEvent(e);
      this.dirty = true;
    });
    this.client.on('welcome', () => {
      this.log = [];
      for (const e of this.client.events) this.pushEvent(e);
      this.sys(`CONNECTED AS ${this.client.role}${this.client.aiOpponent ? ` — OPPONENT: ${this.client.aiOpponent}` : ''}`, COL.green);
      this.dirty = true;
    });
    this.client.on('status', (s: string) => {
      this.sys(s.toUpperCase(), s.startsWith('ERROR') || s === 'disconnected' ? COL.red : COL.dim);
    });
    this.client.on('focus', ({ focus, from }: { focus: Focus; from: string }) => {
      if (!this.sync) return;
      if (focus.unit) this.selected = focus.unit;
      this.map.centerOn(focus.lat, focus.lon, focus.zoom ? Math.max(1, focus.zoom) : undefined);
      this.sys(`VIEW SYNCED FROM ${from.toUpperCase()}${focus.label ? `: ${focus.label}` : ''}`, COL.dim);
      this.dirty = true;
    });
    for (const e of this.client.events) this.pushEvent(e);
    if (this.client.role) this.sys(`CONNECTED AS ${this.client.role}. TYPE "help" FOR ORDERS.`, COL.green);
    this.timer = setInterval(() => this.frame(), 66);
  }

  stop() {
    clearInterval(this.timer);
    this.scr.leave();
    process.stdin.setRawMode?.(false);
  }

  // ------------------------------------------------------------------ log helpers

  private clock(t: number) {
    const start = this.client.snap?.startEpoch ?? Date.UTC(1983, 10, 8, 21);
    return new Date(start + t * 1000).toISOString().slice(11, 19);
  }

  private pushEvent(e: GameEvent) {
    const bold = e.kind === 'alert' || e.kind === 'impact' || e.kind === 'end' || e.kind === 'launch';
    this.log.push({ text: `${this.clock(e.t)} ${e.text}`, color: EVENT_COLOR[e.kind] ?? COL.text, bold });
    if (this.log.length > 2000) this.log.splice(0, 500);
    if (this.bell && (e.kind === 'alert' || e.kind === 'impact') && e.text.includes('DETECT')) process.stdout.write('\x07');
  }

  private sys(text: string, color: RGB = COL.dim) {
    for (const line of text.split('\n')) this.log.push({ text: `         ${line}`, color });
    this.logScroll = 0;
    this.dirty = true;
  }

  // ------------------------------------------------------------------ data helpers

  private side(): Side | 'SPECTATOR' {
    return (this.client.role ?? 'USA') as Side | 'SPECTATOR';
  }

  private allUnits(): (Unit | Contact)[] {
    const s = this.client.snap;
    return s ? [...s.units, ...s.contacts] : [];
  }

  private findUnit(id: string): Unit | Contact | undefined {
    const r = id.toLowerCase();
    const all = this.allUnits();
    return all.find((u) => u.id === r) ?? all.find((u) => u.id.includes(r) || u.name.toLowerCase().includes(r));
  }

  private findPlace(q: string): { lat: number; lon: number; name: string } | null {
    const r = q.trim().toLowerCase();
    const ll = r.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (ll) return { lat: +ll[1], lon: +ll[2], name: q };
    const u = this.findUnit(r);
    if (u) return { lat: u.lat, lon: u.lon, name: u.name };
    const w = this.client.world;
    const city = w?.cities.find((c) => c.name.toLowerCase() === r) ?? w?.cities.find((c) => c.name.toLowerCase().startsWith(r));
    if (city) return { lat: city.lat, lon: city.lon, name: city.name };
    const sea = w?.seaAreas.find((a) => a.name.toLowerCase().includes(r));
    if (sea) return { lat: sea.lat, lon: sea.lon, name: sea.name };
    const p = this.places.find((x) => x[0].toLowerCase() === r) ?? this.places.find((x) => x[0].toLowerCase().startsWith(r));
    if (p) return { lat: p[1], lon: p[2], name: p[0].toUpperCase() };
    return null;
  }

  private sendFocus(label?: string) {
    if (!this.sync) return;
    this.client.focus({ lat: this.map.lat, lon: this.map.lon, zoom: this.map.zoom, label, unit: this.selected ?? undefined });
  }

  // ------------------------------------------------------------------ input

  private onKey(data: string) {
    this.dirty = true;
    // mouse (SGR)
    const mouseRe = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let mm: RegExpExecArray | null;
    let handledMouse = false;
    while ((mm = mouseRe.exec(data))) {
      handledMouse = true;
      this.onMouse(+mm[1], +mm[2] - 1, +mm[3] - 1, mm[4] === 'M');
    }
    if (handledMouse) return;

    const keys: Record<string, () => void> = {
      '\x1b[A': () => (this.input ? this.histNav(1) : this.map.panCells(0, -Math.ceil(this.mapRect.h / 6))),
      '\x1b[B': () => (this.input ? this.histNav(-1) : this.map.panCells(0, Math.ceil(this.mapRect.h / 6))),
      '\x1b[C': () => (this.input ? (this.cursor = Math.min(this.input.length, this.cursor + 1)) : this.map.panCells(Math.ceil(this.mapRect.w / 8), 0)),
      '\x1b[D': () => (this.input ? (this.cursor = Math.max(0, this.cursor - 1)) : this.map.panCells(-Math.ceil(this.mapRect.w / 8), 0)),
      '\x1b[5~': () => (this.logScroll += 5),
      '\x1b[6~': () => (this.logScroll = Math.max(0, this.logScroll - 5)),
      '\x1b[H': () => (this.cursor = 0),
      '\x1b[F': () => (this.cursor = this.input.length),
      '\x1b': () => { this.input = ''; this.cursor = 0; this.tracking = null; },
    };
    if (keys[data]) return void keys[data]();
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (ch === '\x03') return this.quit();
      if (ch === '\r' || ch === '\n') { this.submit(); continue; }
      if (ch === '\x7f' || ch === '\b') {
        if (this.cursor > 0) { this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor); this.cursor--; }
        continue;
      }
      if (ch === '\t') { this.complete(); continue; }
      if (ch === '\x01') { this.cursor = 0; continue; }
      if (ch === '\x05') { this.cursor = this.input.length; continue; }
      if (ch === '\x15') { this.input = ''; this.cursor = 0; continue; }
      if (ch === '\x0c') { this.scr.invalidate(); continue; }
      if (ch === '\x17') {
        const left = this.input.slice(0, this.cursor).replace(/\S+\s*$/, '');
        this.input = left + this.input.slice(this.cursor);
        this.cursor = left.length;
        continue;
      }
      if (code < 32 || ch === '\x1b') continue;
      if (!this.input && !this.plan) {
        if (ch === '+' || ch === '=') { this.map.zoomBy(1.6); continue; }
        if (ch === '-' || ch === '_') { this.map.zoomBy(1 / 1.6); continue; }
        if (ch === ' ') { void this.client.cmd({ op: 'pause' }); continue; }
        if (ch === ']' || ch === '[') { this.stepSpeed(ch === ']' ? 1 : -1); continue; }
      }
      this.input = this.input.slice(0, this.cursor) + ch + this.input.slice(this.cursor);
      this.cursor++;
    }
  }

  private stepSpeed(dir: number) {
    const cur = this.client.snap?.speed ?? 10;
    let i = SPEED_STEPS.findIndex((s) => s >= cur);
    if (i < 0) i = SPEED_STEPS.length - 1;
    const next = SPEED_STEPS[Math.max(0, Math.min(SPEED_STEPS.length - 1, i + dir))];
    void this.client.cmd({ op: 'speed', value: next });
  }

  private onMouse(b: number, x: number, y: number, press: boolean) {
    const r = this.mapRect;
    const inMap = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    const mx = x - r.x, my = y - r.y;
    if (b === 64 && inMap) return this.map.zoomBy(1.4, { x: mx, y: my });
    if (b === 65 && inMap) return this.map.zoomBy(1 / 1.4, { x: mx, y: my });
    if (b === 0 && press && inMap) {
      const hit = this.map.hitTest(mx, my);
      if (hit) {
        this.selected = hit;
        this.tracking = null;
        const u = this.findUnit(hit);
        if (u) {
          this.sys(`SELECTED ${u.id.toUpperCase()} — ${u.name}`, COL.magenta);
          if (this.sync) this.client.focus({ lat: u.lat, lon: u.lon, unit: u.id, label: u.name });
        }
        this.drag = null;
      } else {
        this.drag = { x, y };
      }
      return;
    }
    if (b === 32 && this.drag) {
      const dx = x - this.drag.x, dy = y - this.drag.y;
      this.map.panCells(-dx, -dy);
      this.drag = { x, y };
      return;
    }
    if (!press) this.drag = null;
  }

  private histNav(dir: number) {
    if (!this.history.length) return;
    this.histIdx = Math.max(-1, Math.min(this.history.length - 1, this.histIdx + dir));
    this.input = this.histIdx < 0 ? '' : this.history[this.history.length - 1 - this.histIdx];
    this.cursor = this.input.length;
  }

  private complete() {
    const before = this.input.slice(0, this.cursor);
    const m = before.match(/(\S*)$/);
    const word = (m?.[1] ?? '').toLowerCase();
    const isFirst = !before.trim().includes(' ');
    const verbs = ['launch', 'scramble', 'strike', 'recall', 'move', 'defcon', 'hotline', 'speed', 'pause', 'resume', 'zoom', 'goto', 'world', 'polar', 'flat', 'layer', 'select', 'track', 'list', 'ask', 'focus', 'gui', 'web', 'keys', 'link', 'save', 'load', 'new', 'help', 'quit', 'info', 'mouse', 'bell', 'sync', 'clear'];
    let cands: string[];
    if (isFirst) cands = verbs;
    else if (/^layer\s/i.test(before)) cands = [...LAYER_NAMES];
    else {
      cands = [
        ...this.allUnits().map((u) => u.id),
        ...(this.client.world?.cities.map((c) => c.name.toLowerCase()) ?? []),
        ...(this.client.world?.seaAreas.map((a) => a.name.toLowerCase()) ?? []),
        'at', 'to',
      ];
    }
    const hits = [...new Set(cands.filter((c) => c.startsWith(word)))];
    if (!hits.length) return;
    if (hits.length === 1) {
      const add = hits[0].slice(word.length) + ' ';
      this.input = before + add + this.input.slice(this.cursor);
      this.cursor += add.length;
      return;
    }
    let pre = hits[0];
    for (const h of hits) while (!h.startsWith(pre)) pre = pre.slice(0, -1);
    if (pre.length > word.length) {
      const add = pre.slice(word.length);
      this.input = before + add + this.input.slice(this.cursor);
      this.cursor += add.length;
    } else {
      this.sys(hits.slice(0, 24).join('  ') + (hits.length > 24 ? ` … (+${hits.length - 24})` : ''), COL.dim);
    }
  }

  private submit() {
    const line = this.input.trim();
    this.input = '';
    this.cursor = 0;
    this.histIdx = -1;
    this.logScroll = 0;
    if (this.plan) return this.answerPlan(line);
    if (!line) return;
    if (this.history[this.history.length - 1] !== line) this.history.push(line);
    this.log.push({ text: `       > ${line}`, color: COL.white, bold: true });
    void this.exec(line);
  }

  private async answerPlan(line: string) {
    const plan = this.plan!;
    this.plan = null;
    if (/^y(es)?$/i.test(line)) {
      const r = await this.client.confirmPlan(plan.id, plan.cmds);
      this.sys(r.msg, r.ok ? COL.green : COL.red);
    } else {
      await this.client.confirmPlan(plan.id, null);
      this.sys('PLAN DISCARDED', COL.dim);
    }
  }

  private async exec(line: string) {
    const parsed = parseCommandLine(line);
    if (parsed.kind === 'error') return this.sys(parsed.msg, COL.red);
    if (parsed.kind === 'cmd') return this.runCmd(parsed.cmd);
    const [verb, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    const v = verb.toLowerCase();
    switch (v) {
      case 'help':
      case '?': {
        this.sys('── ORDERS ─────────────────────────────', COL.title);
        for (const [a, b] of GAME_COMMAND_HELP) this.sys(`${a.padEnd(36)} ${b}`, COL.text);
        this.sys('── CONSOLE ────────────────────────────', COL.title);
        for (const [a, b] of LOCAL_HELP) this.sys(`${a.padEnd(36)} ${b}`, COL.text);
        this.sys('KEYS: arrows pan (empty line) · +/- zoom · [ ] time · space pause · PgUp/PgDn log · Tab complete · Esc clear', COL.dim);
        this.sys('ANYTHING ELSE IS SENT TO YOUR AI ADVISOR, e.g. "move the midway group into the sea of japan"', COL.dim);
        return;
      }
      case 'zoom': {
        if (!arg || arg === 'in') return this.map.zoomBy(2);
        if (arg === 'out') return this.map.zoomBy(0.5);
        if (/^\d+(\.\d+)?$/.test(arg)) { this.map.zoom = Math.max(0.6, +arg); return this.sendFocus(); }
        const p = this.findPlace(arg);
        if (!p) return this.sys(`UNKNOWN PLACE "${arg}"`, COL.red);
        this.map.centerOn(p.lat, p.lon, Math.max(this.map.zoom, 24));
        this.sendFocus(p.name);
        return this.sys(`ZOOM ${p.name} ${fmtLatLon(p)}`, COL.dim);
      }
      case 'goto':
      case 'center': {
        const p = this.findPlace(arg);
        if (!p) return this.sys(`UNKNOWN PLACE "${arg}"`, COL.red);
        this.map.centerOn(p.lat, p.lon);
        this.sendFocus(p.name);
        return;
      }
      case 'world':
        this.map.proj = 'equirect';
        this.map.centerOn(30, -20, 1);
        return this.sendFocus('WORLD');
      case 'polar':
        this.map.proj = 'polar';
        this.map.centerOn(90, 0, 1);
        return this.sys('NORTH POLAR AZIMUTHAL PROJECTION', COL.dim);
      case 'flat':
        this.map.proj = 'equirect';
        this.map.lat = Math.min(this.map.lat, 70);
        return;
      case 'layer':
      case 'layers': {
        const [name, state] = rest;
        if (!name) {
          return this.sys(LAYER_NAMES.map((l) => `${this.map.layers[l] ? '■' : '□'} ${l}`).join('  '), COL.text);
        }
        if (!(LAYER_NAMES as readonly string[]).includes(name)) return this.sys(`UNKNOWN LAYER ${name}`, COL.red);
        const l = name as LayerName;
        this.map.layers[l] = state ? state === 'on' : !this.map.layers[l];
        return this.sys(`LAYER ${l.toUpperCase()} ${this.map.layers[l] ? 'ON' : 'OFF'}`, COL.dim);
      }
      case 'select':
      case 'track':
      case 'info': {
        const u = arg ? this.findUnit(arg) : this.selected ? this.findUnit(this.selected) : undefined;
        if (!u) return this.sys(arg ? `UNKNOWN UNIT ${arg}` : 'NOTHING SELECTED', COL.red);
        this.selected = u.id;
        this.tracking = v === 'track' ? u.id : null;
        this.map.centerOn(u.lat, u.lon, Math.max(this.map.zoom, 6));
        if (this.sync) this.client.focus({ lat: u.lat, lon: u.lon, zoom: Math.max(this.map.zoom, 6), unit: u.id, label: u.name });
        return this.sys(this.describeUnit(u).join('\n'), COL.magenta);
      }
      case 'list': {
        const s = this.client.snap;
        if (!s) return;
        const enemy = arg === 'enemy' || arg === 'contacts';
        const pool: (Unit | Contact)[] = enemy ? s.contacts : s.units;
        const list = pool.filter((u) => (enemy || !arg || u.kind === arg || KIND_LABEL[u.kind].toLowerCase().includes(arg)) && !(u.kind === 'bomber' && u.status === 'destroyed'));
        if (!list.length) return this.sys('NONE', COL.dim);
        for (const u of list.slice(0, 80)) this.sys(this.unitLine(u), u.status === 'destroyed' ? COL.dim : COL.text);
        if (list.length > 80) this.sys(`… ${list.length - 80} more`, COL.dim);
        return;
      }
      case 'focus':
        this.client.focus({ lat: this.map.lat, lon: this.map.lon, zoom: this.map.zoom, unit: this.selected ?? undefined, label: 'TERMINAL VIEW' });
        return this.sys('GUI FOCUSED ON TERMINAL VIEW', COL.dim);
      case 'gui':
        if (this.opts.openGui) { this.opts.openGui(); return this.sys('OPENING WALL DISPLAY…', COL.dim); }
        return this.sys(`OPEN THE WALL DISPLAY WITH: npm run gui -- ${this.client.link}`, COL.text);
      case 'web':
      case 'browser':
        if (this.opts.openWeb) { this.opts.openWeb(arg || undefined); return this.sys(`OPENING BROWSER TAB${arg ? ` (${arg.toUpperCase()})` : ''}…`, COL.dim); }
        return this.sys('BROWSER MODE NOT AVAILABLE IN THIS SESSION', COL.red);
      case 'keys':
      case 'setup':
        this.sys('AI API KEYS — quit (or open another terminal) and run:  npm run setup', COL.text);
        this.sys('It asks for GEMINI and/or ANTHROPIC keys (hidden input) and saves them to ~/.coldlaunch/config.json.', COL.dim);
        this.sys('Then restart with e.g.  npm start -- --opponent gemini   or   npm start -- --opponent claude', COL.dim);
        return;
      case 'link':
        return this.sys(`SESSION LINK: ${this.client.link}`, COL.green);
      case 'save':
        if (!/^[\w-]{1,40}$/.test(arg)) return this.sys('usage: save <name>', COL.red);
        return this.client.save(arg);
      case 'load':
        if (!/^[\w-]{1,40}$/.test(arg)) return this.sys('usage: load <name>', COL.red);
        return this.client.load(arg);
      case 'new':
        return this.client.newGame();
      case 'mouse':
        this.mouseOn = arg !== 'off';
        this.scr.mouse(this.mouseOn);
        return this.sys(`MOUSE ${this.mouseOn ? 'ON' : 'OFF (terminal text selection enabled)'}`, COL.dim);
      case 'bell':
        this.bell = arg !== 'off';
        return this.sys(`BELL ${this.bell ? 'ON' : 'OFF'}`, COL.dim);
      case 'sync':
        this.sync = arg !== 'off';
        return this.sys(`GUI SYNC ${this.sync ? 'ON' : 'OFF'}`, COL.dim);
      case 'clear':
        this.log = [];
        return;
      case 'quit':
      case 'exit':
        return this.quit();
      case 'ask':
        return this.askAdvisor(arg);
      default:
        return this.askAdvisor(line);
    }
  }

  private async runCmd(cmd: Command) {
    const r = await this.client.cmd(cmd);
    this.sys(r.msg, r.ok ? COL.green : COL.red);
    if (r.ok && cmd.op === 'launch') this.sys('MISSILES COMMITTED. THERE IS NO RECALL.', COL.red);
  }

  private async askAdvisor(text: string) {
    if (!text) return;
    this.busy = 'ADVISOR THINKING';
    const r = await this.client.ask(text);
    this.busy = '';
    if ('cmds' in r) {
      if (!r.cmds.length) return this.sys(`ADVISOR: ${r.summary}`, COL.purple);
      this.plan = r;
      this.sys(`ADVISOR: ${r.summary}`, COL.purple);
      r.cmds.forEach((c, i) => this.sys(`  ${i + 1}. ${describeCommand(c)}`, COL.purple));
      this.sys('EXECUTE THIS PLAN? [y/N]', COL.yellow);
    } else {
      this.sys(r.msg, r.ok ? COL.text : COL.red);
    }
    this.dirty = true;
  }

  private quit() {
    this.stop();
    this.opts.onQuit?.();
    process.exit(0);
  }

  // ------------------------------------------------------------------ text helpers

  private unitLine(u: Unit | Contact): string {
    const parts = [u.id.padEnd(20), (u.status ?? '').toUpperCase().padEnd(10), u.cls.padEnd(22)];
    const x = u as Unit;
    if (x.missiles !== undefined) parts.push(`MSL ${x.missiles}${x.missilesMax ? '/' + x.missilesMax : ''}`);
    if (x.aircraft !== undefined) parts.push(`A/C ${x.aircraft}`);
    if (x.fuel !== undefined) parts.push(`FUEL ${Math.round(x.fuel * 100)}%`);
    if (x.interceptors !== undefined) parts.push(`INT ${x.interceptors}`);
    parts.push(fmtLatLon(u));
    return parts.join(' ');
  }

  private describeUnit(u: Unit | Contact): string[] {
    const x = u as Unit;
    const out = [`${u.name} [${u.id.toUpperCase()}]`, `${KIND_LABEL[u.kind]} · ${u.cls} · ${u.side} · ${u.status.toUpperCase()} · ${fmtLatLon(u)}`];
    if (x.missiles !== undefined) out.push(`MISSILES ${x.missiles}${x.missilesMax ? '/' + x.missilesMax : ''} × ${x.warheads ?? 1} RV × ${x.yieldKt} KT · RANGE ${x.rangeKm} KM`);
    if (x.aircraft !== undefined) out.push(`AIRCRAFT ${x.aircraft} × ${x.bombs ?? 0} WEAPONS × ${x.yieldKt} KT${x.tankers !== undefined ? ` · TANKERS ${x.tankers}` : ''}`);
    if (x.fuel !== undefined) out.push(`FUEL ${Math.round(x.fuel * 100)}%${x.target ? ` · TARGET ${x.target}` : ''}`);
    if (x.dest) out.push(`DESTINATION ${fmtLatLon(x.dest)} · ${Math.round(distKm(u, x.dest))} KM`);
    if (x.interceptors !== undefined) out.push(`INTERCEPTORS ${x.interceptors} · RADIUS ${x.defenceKm} KM`);
    if (x.radarKm) out.push(`RADAR RANGE ${x.radarKm} KM`);
    if ('seenT' in u) out.push(`LAST SEEN ${this.clock((u as Contact).seenT)}`);
    return out;
  }

  // ------------------------------------------------------------------ rendering

  private frame() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      this.render();
    } catch (e) {
      this.sys(`render error: ${(e as Error).message}`, COL.red);
    }
  }

  private render() {
    const scr = this.scr;
    scr.clear();
    const W = scr.w, H = scr.h;
    const snap = this.client.snap;
    const wide = W >= 110;
    const sideW = wide ? Math.min(38, Math.floor(W * 0.26)) : 0;
    const logH = H >= 40 ? 10 : H >= 28 ? 7 : 4;
    const mapW = W - sideW;
    const mapH = H - 1 - logH - 1;
    this.mapRect = { x: 0, y: 1, w: mapW, h: mapH };

    this.renderStatus(snap);
    this.map.setSize(mapW, mapH);
    this.map.render(scr, 0, 1, { snap, world: this.client.world, side: this.side(), selected: this.selected });
    this.renderMapOverlay(snap);
    if (wide) this.renderSidebar(mapW, 1, sideW, mapH, snap);
    this.renderLog(0, 1 + mapH, W, logH);
    this.renderInput(H - 1, W);
    scr.flush();
  }

  private renderStatus(snap?: Snapshot) {
    const scr = this.scr;
    scr.fill(0, 0, scr.w, 1, [4, 14, 32]);
    const bg: RGB = [4, 14, 32];
    let x = 1;
    const seg = (s: string, c: RGB, bold = false) => { scr.put(x, 0, s, c, bg, bold); x += s.length + 2; };
    seg('STRATCOM // COLD LAUNCH', COL.title, true);
    const role = this.side();
    seg(role, role === 'USSR' ? COL.ussr : role === 'USA' ? COL.usa : COL.text, true);
    if (snap) {
      const own = role === 'SPECTATOR' ? Math.min(snap.defcon.USA, snap.defcon.USSR) : snap.defcon[role];
      seg(`DEFCON ${own}`, DEFCON_COLOR[own], true);
      seg(`${new Date(snap.startEpoch + snap.t * 1000).toISOString().slice(0, 19).replace('T', ' ')}Z`, COL.text);
      seg(snap.paused ? 'PAUSED' : `x${snap.speed}`, snap.paused ? COL.yellow : COL.dim, snap.paused);
      seg(`TENSION ${String(snap.tension).padStart(3, '0')}`, snap.tension > 70 ? COL.red : snap.tension > 40 ? COL.yellow : COL.green);
      if (snap.threat.inbound) seg(`INBOUND ${snap.threat.inbound}`, COL.red, true);
      if (snap.over) seg(`■ ${snap.over.reason}`, COL.white, true);
    } else {
      seg(this.client.connected ? 'SYNCING…' : 'NO CARRIER', COL.yellow);
    }
    if (this.busy) seg(`◌ ${this.busy}`, COL.purple);
  }

  private renderMapOverlay(snap?: Snapshot) {
    const r = this.mapRect;
    const span = this.map.spanDeg();
    const center = `${fmtLatLon({ lat: this.map.lat, lon: normLon(this.map.lon) })}  ${this.map.proj === 'polar' ? 'POLAR' : 'EQR'}  SPAN ${span >= 10 ? Math.round(span) : span.toFixed(1)}°  LOD${this.map.lodInUse}${this.tracking ? `  TRACK ${this.tracking.toUpperCase()}` : ''}`;
    this.scr.put(r.x + 1, r.y + r.h - 1, center, COL.dim);
    if (snap?.over) {
      const msg = ` SIMULATION COMPLETE — ${snap.over.reason} `;
      this.scr.put(r.x + Math.max(0, Math.floor((r.w - msg.length) / 2)), r.y + Math.floor(r.h / 2), msg, [0, 0, 0], COL.white, true);
    }
  }

  private renderSidebar(x: number, y: number, w: number, h: number, snap?: Snapshot) {
    const scr = this.scr;
    scr.box(x, y, w, h, COL.frame, 'STATUS BOARD', COL.title);
    let row = y + 1;
    const line = (s: string, c: RGB = COL.text, bold = false) => {
      if (row >= y + h - 1) return;
      scr.put(x + 2, row++, s.slice(0, w - 4), c, [0, 0, 0], bold);
    };
    if (!snap) return line('AWAITING DATA LINK…', COL.yellow);
    const role = this.side();
    const sides: Side[] = role === 'USSR' ? ['USSR', 'USA'] : ['USA', 'USSR'];
    for (const s of sides) {
      const lvl = snap.defcon[s];
      const est = role !== 'SPECTATOR' && s !== role ? ' (EST)' : '';
      line(`${s.padEnd(5)} DEFCON ${lvl} ${DEFCON_NAMES[lvl]}${est}`, DEFCON_COLOR[lvl], true);
    }
    row++;
    const counter = (label: string, v: number | string, c: RGB = COL.red) => line(`${label.padEnd(16)}${String(v).padStart(w - 22, ' ')}`, c, true);
    counter('INBOUND TRACKS', snap.threat.inbound, snap.threat.inbound ? COL.red : COL.dim);
    counter('DETONATIONS', snap.threat.impacts, snap.threat.impacts ? COL.red : COL.dim);
    counter('BOMBER CONTACTS', snap.threat.bombers, snap.threat.bombers ? COL.yellow : COL.dim);
    counter('SUB CONTACTS', snap.threat.subs, snap.threat.subs ? COL.yellow : COL.dim);
    counter('TENSION', snap.tension, snap.tension > 70 ? COL.red : snap.tension > 40 ? COL.yellow : COL.green);
    row++;
    if (role !== 'SPECTATOR') {
      const own = snap.units;
      const sum = (k: Unit['kind'], f: (u: Unit) => number) => own.filter((u) => u.kind === k && u.status !== 'destroyed').reduce((a, u) => a + f(u), 0);
      line('── FORCES ──', COL.title);
      line(`ICBM  ${sum('silo', (u) => u.missiles ?? 0)} MSL / ${sum('silo', (u) => (u.missiles ?? 0) * (u.warheads ?? 1))} RV`);
      line(`SLBM  ${sum('ssbn', (u) => u.missiles ?? 0)} MSL / ${sum('ssbn', (u) => (u.missiles ?? 0) * (u.warheads ?? 1))} RV`);
      line(`BMR   ${sum('airbase', (u) => u.aircraft ?? 0)} GND / ${sum('bomber', (u) => u.aircraft ?? 0)} AIR`);
      row++;
    }
    line('── CASUALTIES ──', COL.title);
    for (const s of sides) {
      const sc = snap.score[s];
      const pct = (sc.killed / sc.popStart) * 100;
      line(`${s.padEnd(5)} ${fmtK(sc.killed).padStart(8)}  ${pct.toFixed(1)}%`, sc.killed > 0 ? COL.red : COL.dim);
    }
    const ai = Object.entries(snap.ai);
    if (ai.length) {
      row++;
      line('── AI ──', COL.title);
      for (const [s, a] of ai) {
        if (!a) continue;
        line(`${s} ${a.provider}:${a.model}`.slice(0, w - 4), COL.purple);
        line(`${a.thinking ? '◌ THINKING' : '· IDLE'}  ${a.calls} CALLS  $${a.costUsd.toFixed(3)}`, a.lastError ? COL.red : COL.dim);
        if (a.lastError) line(a.lastError.slice(0, w - 4), COL.red);
      }
    }
    const sel = this.selected ? this.findUnit(this.selected) : undefined;
    if (sel) {
      row++;
      line('── SELECTED ──', COL.magenta);
      for (const l of this.describeUnit(sel)) {
        for (let i = 0; i < l.length; i += w - 4) line(l.slice(i, i + w - 4), COL.magenta);
      }
    }
    // inbound list
    const inbound = snap.missiles.filter((m) => m.side !== role && m.type !== 'ABM').sort((a, b) => a.impactT - b.impactT);
    if (inbound.length && row < y + h - 3) {
      row++;
      line('── INBOUND ──', COL.red);
      for (const m of inbound.slice(0, y + h - 2 - row)) {
        const eta = Math.max(0, m.impactT - snap.t);
        line(`${m.type} ${m.confirmed ? '' : '?'}${m.target.slice(0, w - 20).padEnd(w - 20)} ${Math.floor(eta / 60)}:${String(Math.floor(eta % 60)).padStart(2, '0')}`, COL.red);
      }
    }
    void ballisticPos;
  }

  private renderLog(x: number, y: number, w: number, h: number) {
    const scr = this.scr;
    scr.put(x, y, '─'.repeat(w), COL.frame);
    scr.put(x + 2, y, ' EVENT LOG ', COL.title, [0, 0, 0], true);
    if (this.logScroll) scr.put(x + 14, y, ` ↑${this.logScroll} `, COL.yellow);
    const lines: LogLine[] = [];
    for (const l of this.log) {
      for (let i = 0; i < l.text.length; i += w - 2) lines.push({ ...l, text: l.text.slice(i, i + w - 2) });
      if (!l.text.length) lines.push(l);
    }
    const maxScroll = Math.max(0, lines.length - (h - 1));
    this.logScroll = Math.min(this.logScroll, maxScroll);
    const end = lines.length - this.logScroll;
    const start = Math.max(0, end - (h - 1));
    let row = y + 1;
    for (let i = start; i < end; i++) {
      scr.put(x + 1, row++, lines[i].text, lines[i].color, [0, 0, 0], lines[i].bold);
    }
  }

  private renderInput(y: number, w: number) {
    const scr = this.scr;
    const prompt = this.plan ? 'EXECUTE? [y/N] ' : `${this.side() === 'USSR' ? 'СТАВКА' : 'NCA'}> `;
    const color = this.plan ? COL.yellow : COL.green;
    scr.fill(0, y, w, 1, [0, 0, 0]);
    scr.put(0, y, prompt, color, [0, 0, 0], true);
    const avail = w - prompt.length - 1;
    const off = Math.max(0, this.cursor - avail);
    scr.put(prompt.length, y, this.input.slice(off, off + avail), COL.white);
    scr.cursor = { x: prompt.length + this.cursor - off, y };
    if (!this.input && !this.plan) scr.put(prompt.length, y, 'type orders or "help" · natural language goes to the AI advisor', dim(COL.text, 0.35));
  }
}

function fmtK(k: number) {
  return k >= 1000 ? `${(k / 1000).toFixed(2)}M` : `${Math.round(k)}K`;
}
