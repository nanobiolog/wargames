// In-display command console: the same orders, help and type-ahead as the terminal, inside any display tab.
import {
  parseCommandLine, describeCommand, helpLines, suggest, fmtLatLon, KIND_LABEL, selectionDetails, ballisticPos, intelReport,
  type GameClient, type GameEvent, type PlanProposal, type Unit, type Contact, type Suggestion,
} from '@coldlaunch/shared';
import type { SceneState, LayerKey } from './scene.ts';
import { LAYER_LIST } from './scene.ts';
import { PRESET_NAMES } from './wall.ts';

export interface ConsoleHost {
  client: GameClient;
  st: SceneState;
  places(): [string, number, number, number, string][];
  flyTo(lat: number, lon: number, zoom?: number, label?: string): void;
  zoomBy(f: number): void;
  world(): void;
  setPreset(p: string): void;
  newWindow(p: string): void;
  saveLayers(): void;
  webLinks(): [string, string][];
  onSelect(): void;
  share(): void;
}

const h = (tag: string, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const EV_CLASS: Record<string, string> = {
  alert: 'c-red', launch: 'c-red', impact: 'c-white', warn: 'c-yellow', detect: 'c-yellow', destroyed: 'c-orange',
  defcon: 'c-magenta', hotline: 'c-green', ai: 'c-purple', end: 'c-white', intercept: 'c-cyan', info: 'c-dim',
};

export class Console {
  el: HTMLElement;
  private logEl: HTMLElement;
  private hintEl: HTMLElement;
  private chipsEl: HTMLElement;
  private input: HTMLInputElement;
  private ghostEl: HTMLElement;
  private history: string[] = [];
  private hIdx = -1;
  private plan: PlanProposal | null = null;
  private placeNames: string[] | null = null;
  showEvents = true;

  constructor(root: HTMLElement, private host: ConsoleHost) {
    this.el = h('div', 'console hidden');
    const bar = h('div', 'cbar');
    bar.append(h('span', '', 'COMMAND CONSOLE — type help · ` toggles'));
    const evBtn = h('button', 'small', 'EVENTS ✓');
    evBtn.onclick = () => { this.showEvents = !this.showEvents; evBtn.textContent = this.showEvents ? 'EVENTS ✓' : 'EVENTS'; };
    const close = h('button', 'small', '×');
    close.onclick = () => this.toggle(false);
    bar.append(evBtn, close);
    this.logEl = h('div', 'clog');
    this.hintEl = h('div', 'chint');
    this.chipsEl = h('div', 'cchips');
    const line = h('div', 'cline');
    const prompt = h('span', 'cprompt', 'NCA>');
    const wrap = h('div', 'cinwrap');
    this.ghostEl = h('div', 'cghost');
    this.input = h('input', 'cin') as HTMLInputElement;
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    wrap.append(this.ghostEl, this.input);
    line.append(prompt, wrap);
    this.el.append(bar, this.logEl, this.hintEl, this.chipsEl, line);
    root.append(this.el);
    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('click', () => this.refresh());
    this.print('Same orders as the terminal. Grey text is a suggestion — Tab or → accepts. Type help, or plain English for your advisor.', 'c-dim');
    // a different session (another match, a restart): start the log afresh
    let session = '';
    host.client.on('welcome', () => {
      const id = `${host.client.match?.code ?? host.client.link ?? ''}`;
      if (session && id !== session) this.logEl.textContent = '';
      session = id;
    });
  }

  get open() {
    return !this.el.classList.contains('hidden');
  }

  toggle(force?: boolean) {
    const show = force ?? !this.open;
    this.el.classList.toggle('hidden', !show);
    if (show) {
      setTimeout(() => this.input.focus(), 0);
      this.refresh();
    }
  }

  private lastIdleRefresh = 0;
  /** Keep next-order suggestions current while the line is empty (called on every snapshot). */
  onSnapshot() {
    if (!this.open || this.input.value || performance.now() - this.lastIdleRefresh < 1000) return;
    this.lastIdleRefresh = performance.now();
    this.refresh();
  }

  setRole(role: string) {
    (this.el.querySelector('.cprompt') as HTMLElement).textContent = role === 'USSR' ? 'СТАВКА>' : role === 'SPECTATOR' ? 'OBS>' : 'NCA>';
  }

  onEvent(e: GameEvent) {
    if (!this.showEvents) return;
    const t = this.host.client.snap ? new Date(this.host.client.snap.startEpoch + e.t * 1000).toISOString().slice(11, 19) : '';
    this.print(`${t} ${e.text}`, EV_CLASS[e.kind] ?? 'c-dim');
  }

  print(text: string, cls = '') {
    for (const l of text.split('\n')) this.logEl.append(h('div', cls, l));
    while (this.logEl.childElementCount > 500) this.logEl.firstChild!.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private suggestion(): Suggestion {
    const v = this.input.value;
    if (this.plan) return { ghost: '', candidates: ['y', 'n'], hint: 'advisor plan waiting — y executes it, anything else discards it' };
    if ((this.input.selectionStart ?? v.length) < v.length) return { ghost: '', candidates: [], hint: '' };
    this.placeNames ??= this.host.places().filter((p) => p[3] <= 6).map((p) => p[0].toLowerCase());
    const c = this.host.client;
    return suggest(v, {
      snap: c.snap, world: c.world, role: (c.role ?? 'USA') as never, where: 'gui',
      places: this.placeNames, layers: LAYER_LIST.map(([k]) => k), presets: PRESET_NAMES,
    });
  }

  refresh() {
    const s = this.suggestion();
    const v = this.input.value;
    this.ghostEl.textContent = '';
    if (s.ghost) {
      const pre = h('span', 'cghost-pre', v);
      const g = h('span', 'cghost-txt', s.ghost + (v ? '' : '   ← Tab'));
      this.ghostEl.append(pre, g);
    }
    this.hintEl.textContent = s.hint;
    this.chipsEl.textContent = '';
    for (const c of s.candidates.slice(0, 10)) {
      const b = h('button', 'chip', c);
      b.onclick = () => this.acceptCandidate(c);
      this.chipsEl.append(b);
    }
  }

  private acceptCandidate(c: string) {
    if (!this.input.value.trim()) this.input.value = c;
    else this.input.value = this.input.value.replace(/(\S*)$/, (w) => (c.startsWith(w.toLowerCase()) || c.includes(w.toLowerCase()) ? c : w + c)) + ' ';
    this.input.focus();
    this.refresh();
  }

  private onKey(e: KeyboardEvent) {
    const v = this.input.value;
    if (e.key === 'Enter') {
      e.preventDefault();
      this.submit();
    } else if (e.key === 'Tab' || (e.key === 'ArrowRight' && (this.input.selectionStart ?? 0) >= v.length)) {
      const s = this.suggestion();
      if (s.ghost) {
        e.preventDefault();
        this.input.value = v + s.ghost;
        this.refresh();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (s.candidates.length > 1) this.print(s.candidates.join('  '), 'c-dim');
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!this.history.length) return;
      this.hIdx = Math.max(-1, Math.min(this.history.length - 1, this.hIdx + (e.key === 'ArrowUp' ? 1 : -1)));
      this.input.value = this.hIdx < 0 ? '' : this.history[this.history.length - 1 - this.hIdx];
      this.refresh();
    } else if (e.key === 'Escape') {
      if (v) { this.input.value = ''; this.refresh(); } else this.toggle(false);
    } else if (e.key === '`' && !v) {
      e.preventDefault();
      this.toggle(false);
    }
    e.stopPropagation();
  }

  private submit() {
    const line = this.input.value.trim();
    this.input.value = '';
    this.hIdx = -1;
    if (this.plan) return void this.answerPlan(line);
    this.refresh();
    if (!line) return;
    if (this.history[this.history.length - 1] !== line) this.history.push(line);
    this.print(`> ${line}`, 'c-input');
    void this.exec(line);
  }

  private async answerPlan(line: string) {
    const plan = this.plan!;
    this.plan = null;
    const r = await this.host.client.confirmPlan(plan.id, /^y(es)?$/i.test(line) ? plan.cmds : null);
    this.print(r.msg, r.ok ? 'c-green' : 'c-red');
    this.refresh();
  }

  private units(): (Unit | Contact)[] {
    const s = this.host.client.snap;
    return s ? [...s.units, ...s.contacts] : [];
  }

  private findPlace(q: string): { lat: number; lon: number; name: string; id?: string } | null {
    const r = q.trim().toLowerCase();
    const ll = r.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (ll) return { lat: +ll[1], lon: +ll[2], name: q };
    // exact matches win (unit id, city, sea area), then partial ones
    const w = this.host.client.world;
    const byId = this.units().find((x) => x.id === r);
    if (byId) return { lat: byId.lat, lon: byId.lon, name: byId.name, id: byId.id };
    const cityX = w?.cities.find((c) => c.name.toLowerCase() === r);
    if (cityX) return { lat: cityX.lat, lon: cityX.lon, name: cityX.name };
    const seaX = w?.seaAreas.find((a) => a.name.toLowerCase() === r);
    if (seaX) return { lat: seaX.lat, lon: seaX.lon, name: seaX.name };
    const u = this.units().find((x) => x.name.toLowerCase() === r) ?? this.units().find((x) => x.name.toLowerCase().includes(r));
    if (u) return { lat: u.lat, lon: u.lon, name: u.name, id: u.id };
    const city = w?.cities.find((c) => c.name.toLowerCase().startsWith(r));
    if (city) return { lat: city.lat, lon: city.lon, name: city.name };
    const sea = w?.seaAreas.find((a) => a.name.toLowerCase().includes(r));
    if (sea) return { lat: sea.lat, lon: sea.lon, name: sea.name };
    const p = this.host.places().find((x) => x[0].toLowerCase() === r) ?? this.host.places().find((x) => x[0].toLowerCase().startsWith(r));
    if (p) return { lat: p[1], lon: p[2], name: p[0].toUpperCase() };
    return null;
  }

  private async exec(line: string) {
    const c = this.host.client;
    const parsed = parseCommandLine(line);
    if (parsed.kind === 'error') return this.print(parsed.msg, 'c-red');
    if (parsed.kind === 'cmd') {
      const r = await c.cmd(parsed.cmd);
      this.print(r.msg, r.ok ? 'c-green' : 'c-red');
      return this.refresh();
    }
    const [verbRaw, ...rest] = line.split(/\s+/);
    const verb = verbRaw.toLowerCase();
    const arg = rest.join(' ');
    switch (verb) {
      case 'help':
      case '?':
        for (const l of helpLines('gui', arg || undefined)) this.print(l, l.startsWith('──') ? 'c-title' : '');
        if (!arg) this.print('Display keys: wheel zoom · drag pan · double-click maximise · right-click orders · ` console · L layers · 1-9 views', 'c-dim');
        return;
      case 'zoom': {
        if (!arg || arg === 'in') return this.host.zoomBy(2);
        if (arg === 'out') return this.host.zoomBy(0.5);
        const p = this.findPlace(arg);
        if (!p) return this.print(`unknown place "${arg}"`, 'c-red');
        this.host.flyTo(p.lat, p.lon, /^\d+(\.\d+)?$/.test(arg) ? +arg : 30, p.name);
        return this.print(`zoom ${p.name} ${fmtLatLon(p)}`, 'c-dim');
      }
      case 'goto':
      case 'center': {
        const p = this.findPlace(arg);
        if (!p) return this.print(`unknown place "${arg}"`, 'c-red');
        return this.host.flyTo(p.lat, p.lon, undefined, p.name);
      }
      case 'world':
        return this.host.world();
      case 'view':
      case 'preset':
        if (!PRESET_NAMES.includes(arg)) return this.print(`views: ${PRESET_NAMES.join(', ')}`, 'c-dim');
        return this.host.setPreset(arg);
      case 'layer':
      case 'layers': {
        const [name, state] = rest;
        const L = this.host.st.layers;
        if (!name) return this.print(LAYER_LIST.map(([k]) => `${L[k] ? '■' : '□'} ${k}`).join('  '));
        if (!(name in L)) return this.print(`unknown layer ${name}`, 'c-red');
        L[name as LayerKey] = state ? state === 'on' : !L[name as LayerKey];
        this.host.saveLayers();
        return this.print(`layer ${name} ${L[name as LayerKey] ? 'on' : 'off'}`, 'c-dim');
      }
      case 'info':
      case 'select': {
        const m = c.snap?.missiles.find((x) => x.id === (arg || this.host.st.selected || '').toLowerCase());
        if (m && c.snap) {
          this.host.st.selected = m.id;
          this.host.onSelect();
          const pos = ballisticPos(m.from, m.to, m.launchT, m.impactT, m.apexKm, c.snap.t).p;
          this.host.flyTo(pos.lat, pos.lon, undefined, `${m.type} → ${m.target}`);
          const d = selectionDetails(m.id, c.snap);
          if (d) for (const l of d.lines) this.print(`${l.label.padEnd(11)} ${l.value}`, 'c-magenta');
          return;
        }
        if (!arg && this.host.st.selected && c.snap) {
          const d = selectionDetails(this.host.st.selected, c.snap);
          if (d) { this.print(d.title, 'c-magenta'); for (const l of d.lines) this.print(`${l.label.padEnd(11)} ${l.value}`, 'c-magenta'); return; }
        }
        const p = this.findPlace(arg);
        if (!p?.id) return this.print(`unknown unit ${arg}`, 'c-red');
        this.host.st.selected = p.id;
        this.host.onSelect();
        c.focus({ lat: p.lat, lon: p.lon, unit: p.id, label: p.name });
        const d = c.snap ? selectionDetails(p.id, c.snap) : null;
        if (d) for (const l of d.lines) this.print(`${l.label.padEnd(11)} ${l.value}`, 'c-magenta');
        return this.host.flyTo(p.lat, p.lon, undefined, p.name);
      }
      case 'intel': {
        if (!c.snap) return;
        for (const l of intelReport(c.snap)) this.print(l, l.startsWith(' ') ? '' : 'c-magenta');
        return;
      }
      case 'list': {
        const s = c.snap;
        if (!s) return;
        const enemy = arg === 'enemy' || arg === 'contacts';
        const pool: (Unit | Contact)[] = enemy ? s.contacts : s.units;
        const list = pool.filter((u) => (enemy || !arg || u.kind === arg) && !(u.kind === 'bomber' && u.status === 'destroyed'));
        for (const u of list.slice(0, 80)) {
          const x = u as Unit;
          const extra = x.missiles !== undefined ? ` msl ${x.missiles}` : x.aircraft !== undefined ? ` a/c ${x.aircraft}` : '';
          this.print(`${u.id.padEnd(20)} ${u.status.toUpperCase().padEnd(10)} ${KIND_LABEL[u.kind]}${extra}`, u.status === 'destroyed' ? 'c-dim' : '');
        }
        return list.length ? undefined : this.print('none', 'c-dim');
      }
      case 'share':
      case 'qr':
        this.print('opening the share panel (QR codes)…', 'c-dim');
        return this.host.share();
      case 'link':
        for (const [label, url] of this.host.webLinks()) this.print(`${label.padEnd(20)} ${url}`, 'c-green');
        return this.print('Share only with machines you trust — the token lets anyone join.', 'c-dim');
      case 'web':
      case 'browser':
        return this.host.newWindow(arg && PRESET_NAMES.includes(arg) ? arg : 'world');
      case 'save':
      case 'load':
        if (!/^[\w-]{1,40}$/.test(arg)) return this.print(`usage: ${verb} <name>`, 'c-red');
        return verb === 'save' ? c.save(arg) : c.load(arg);
      case 'new':
        return c.newGame();
      case 'clear':
        this.logEl.textContent = '';
        return;
      case 'sync':
        return this.print('the display always follows terminal focus; use "sync off" in the terminal to stop it', 'c-dim');
      case 'ask':
        return this.ask(arg);
      default:
        return this.ask(line);
    }
  }

  private async ask(text: string) {
    if (!text) return;
    this.print('advisor thinking…', 'c-purple');
    const r = await this.host.client.ask(text);
    if ('cmds' in r) {
      this.print(`ADVISOR: ${r.summary}`, 'c-purple');
      if (!r.cmds.length) return;
      r.cmds.forEach((cmd, i) => this.print(`  ${i + 1}. ${describeCommand(cmd)}`, 'c-purple'));
      this.print('EXECUTE THIS PLAN? y / N', 'c-yellow');
      this.plan = r;
    } else this.print(r.msg, r.ok ? '' : 'c-red');
    this.refresh();
  }
}
