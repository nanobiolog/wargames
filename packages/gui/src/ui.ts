// DOM overlays: toolbar, layer/CRT panels, info card, context menu, targeting, toasts, connect dialog.
import {
  KIND_LABEL, fmtLatLon, describeCommand, selectionDetails, type Command, type Contact, type GameClient, type GameEvent, type LatLon, type Unit,
} from '@coldlaunch/shared';
import type { FxSettings } from './gl.ts';
import { LAYER_LIST, type LayerKey, type SceneState } from './scene.ts';
import { PRESET_NAMES } from './wall.ts';
import QRCode from 'qrcode';

interface UiHost {
  client: GameClient;
  st: SceneState;
  fx: FxSettings;
  getPreset(): string;
  setPreset(p: string): void;
  saveLayers(): void;
  saveFx(): void;
  connect(link: string): void;
  currentLink(): string | null;
  toggleConsole(): void;
  openSettings(): void;
  openLobby?(): void;
  /** online share sheet; returns false when not in an online match */
  onlineShare?(): boolean;
}

declare global {
  interface Window {
    wallHost?: { newWindow(preset: string): Promise<void>; setLink(l: string): Promise<void>; allDisplays?(): Promise<number> };
  }
}

const PRESET_LABEL: Record<string, string> = {
  wall: 'War-room wall', world: 'World', conus: 'Continental US', europe: 'Europe', eurasia: 'USSR / Eurasia', alaska: 'Alaska sector',
  pacific: 'Pacific', atlantic: 'North Atlantic', polar: 'North polar', missiles: 'Ballistic missile status', stats: 'Force status & stats', log: 'Comms log',
};

const h = (tag: string, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export class Ui {
  targeting: null | { label: string; build: (target: string) => Command } = null;
  private toolbar: HTMLElement;
  private panels: Record<string, HTMLElement> = {};
  private info: HTMLElement;
  private tip: HTMLElement;
  private menu: HTMLElement;
  private banner: HTMLElement;
  private toasts: HTMLElement;
  private connectBox: HTMLElement;
  private audio: AudioContext | null = null;
  private sound = false;
  private hideTimer = 0;

  constructor(private root: HTMLElement, private host: UiHost) {
    this.toolbar = h('div', 'toolbar');
    root.append(this.toolbar);
    this.info = h('div', 'info hidden');
    this.tip = h('div', 'tip hidden');
    this.menu = h('div', 'menu hidden');
    this.banner = h('div', 'banner hidden');
    this.toasts = h('div', 'toasts');
    this.connectBox = h('div', 'connect hidden');
    root.append(this.info, this.tip, this.menu, this.banner, this.toasts, this.connectBox);
    for (const k of ['layers', 'crt', 'help', 'presets', 'share']) {
      this.panels[k] = h('div', `panel hidden panel-${k}`);
      root.append(this.panels[k]);
    }
    document.addEventListener('click', (e) => {
      if (!this.menu.contains(e.target as Node)) this.menu.classList.add('hidden');
    });
    this.refresh();
  }

  refresh() {
    const t = this.toolbar;
    t.innerHTML = '';
    const btn = (label: string, fn: () => void, title = '') => {
      const b = h('button', '', label);
      b.title = title;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      t.append(b);
      return b;
    };
    btn(`VIEW: ${PRESET_LABEL[this.host.getPreset()] ?? this.host.getPreset()}`, () => this.toggle('presets'), 'Choose what this window shows (1-9)');
    if (this.host.openLobby) btn('LOBBY', () => this.host.openLobby!(), 'Create or join online matches, invite friends');
    btn('SHARE', () => this.openShare(), 'QR codes for phones and other PCs');
    btn('CONSOLE', () => this.host.toggleConsole(), '` — type orders right here');
    btn('LAYERS', () => this.toggle('layers'), 'L');
    btn('CRT', () => this.toggle('crt'), 'C');
    btn('NEW WINDOW', () => this.newWindow(this.host.getPreset() === 'wall' ? 'world' : 'wall'), 'Open another display window');
    btn('ALL MONITORS', () => void this.allMonitors(), 'One preset per connected monitor');
    btn(this.sound ? 'SOUND ON' : 'SOUND OFF', () => { this.sound = !this.sound; this.refresh(); });
    btn('SETTINGS', () => this.host.openSettings(), 'Graphics, callsign, AI keys');
    btn('?', () => this.toggle('help'));
    this.buildLayers();
    this.buildCrt();
    this.buildHelp();
    this.buildPresets();
  }

  pointer(x: number, y: number) {
    this.toolbar.classList.remove('faded');
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.toolbar.classList.add('faded'), 3500);
    void x; void y;
  }

  toggle(name: string) {
    for (const [k, p] of Object.entries(this.panels)) {
      if (k === name) p.classList.toggle('hidden');
      else p.classList.add('hidden');
    }
  }

  private buildLayers() {
    const p = this.panels.layers;
    p.innerHTML = '<div class="ph">MAP LAYERS</div>';
    for (const [k, label] of LAYER_LIST) {
      const row = h('label', k === 'navy' ? 'row sep' : 'row');
      const cb = h('input') as HTMLInputElement;
      cb.type = 'checkbox';
      cb.checked = this.host.st.layers[k];
      cb.onchange = () => { this.host.st.layers[k as LayerKey] = cb.checked; this.host.saveLayers(); };
      row.append(cb, document.createTextNode(' ' + label));
      p.append(row);
    }
  }

  private buildCrt() {
    const p = this.panels.crt;
    p.innerHTML = '<div class="ph">CRT / PHOSPHOR</div>';
    const sl = (label: string, key: keyof FxSettings, min: number, max: number, step: number) => {
      const row = h('label', 'row');
      const r = h('input') as HTMLInputElement;
      r.type = 'range'; r.min = String(min); r.max = String(max); r.step = String(step); r.value = String(this.host.fx[key]);
      r.oninput = () => { this.host.fx[key] = +r.value; this.host.saveFx(); };
      row.append(document.createTextNode(label + ' '), r);
      p.append(row);
    };
    sl('Bloom', 'bloom', 0, 3, 0.05);
    sl('Persistence', 'persistence', 0, 0.97, 0.01);
    sl('Scanlines', 'scanlines', 0, 1, 0.05);
    sl('Exposure', 'exposure', 0.4, 4, 0.05);
  }

  private buildHelp() {
    this.panels.help.innerHTML = `<div class="ph">WALL DISPLAY</div>
      <p>Mouse wheel: zoom the panel under the cursor · drag: pan · double-click: maximise panel · Esc: restore</p>
      <p>Click a unit to select it (your terminal follows). Right-click for orders. Space: pause · R: reset views · L: layers · C: CRT</p>
      <p><b>\`</b> opens the built-in command console — the same orders as the terminal, with type-ahead (Tab / → accepts).</p>
      <p>Keys 1-9 / 0 switch this window's view: ${PRESET_NAMES.map((p, i) => `${(i + 1) % 10}=${PRESET_LABEL[p]}`).join(', ')}</p>
      <p>The terminal console stays the primary command line — type <b>help</b> there.</p>`;
  }

  private buildPresets() {
    const p = this.panels.presets;
    p.innerHTML = '<div class="ph">THIS WINDOW SHOWS</div>';
    PRESET_NAMES.forEach((name, i) => {
      const b = h('button', name === this.host.getPreset() ? 'active' : '', `${(i + 1) % 10} · ${PRESET_LABEL[name]}`);
      b.onclick = () => { this.host.setPreset(name); this.toggle(''); };
      const o = h('button', 'small', '↗');
      o.title = 'open in a new window';
      o.onclick = () => this.newWindow(name);
      const row = h('div', 'prow');
      row.append(b, o);
      p.append(row);
    });
  }

  /** Share panel: switch on LAN sharing and show QR codes for phones / other PCs. */
  async openShare(enable = false) {
    if (this.host.onlineShare?.()) { this.toggle(''); return; }
    const p = this.panels.share;
    this.toggle('share');
    if (p.classList.contains('hidden')) return;
    p.innerHTML = '<div class="ph">SHARE WITH PHONES &amp; OTHER PCS</div><p class="dim">contacting game server…</p>';
    const r = await this.host.client.share(enable);
    if (!('links' in r)) { p.innerHTML += `<p class="bad">${r.msg}</p>`; return; }
    p.innerHTML = '<div class="ph">SHARE WITH PHONES &amp; OTHER PCS</div>';
    if (!r.lan) {
      const note = h('p', '', 'Sharing is off: right now only this computer can open the game. Turn it on to let phones, tablets and other PCs on the same Wi-Fi join.');
      const b = h('button', 'big', 'TURN ON LAN SHARING');
      b.onclick = () => { this.toggle(''); void this.openShare(true); };
      p.append(note, b, h('p', 'dim', 'Only the machine running the game can turn this on. Anyone with a link can join, so use trusted networks.'));
      return;
    }
    const web = r.links.filter((l) => l.kind === 'web');
    const big = h('div', 'qr');
    const caption = h('div', 'qrcap');
    const show = async (i: number) => {
      big.innerHTML = await QRCode.toString(web[i].url, { type: 'svg', margin: 2, errorCorrectionLevel: 'L', color: { dark: '#000000', light: '#ffffff' } });
      caption.textContent = web[i].label;
      tabs.querySelectorAll('button').forEach((b, k) => b.classList.toggle('active', k === i));
    };
    const tabs = h('div', 'qrtabs');
    web.forEach((l, i) => {
      const b = h('button', '', l.label.replace(/ \(.*\)$/, '').replace('Second player — ', 'P2 ').replace('Phone: ', ''));
      b.title = l.label;
      b.onclick = () => void show(i);
      tabs.append(b);
    });
    p.append(tabs, big, caption, h('p', 'dim', `Scan with the phone camera (same Wi-Fi as ${r.host}). Phone links open the map with a touch console.`));
    for (const l of r.links) {
      const row = h('div', 'linkrow');
      const code = h('code', '', l.url);
      const copy = h('button', 'small', 'COPY');
      copy.onclick = () => void navigator.clipboard?.writeText(l.url).then(() => this.toast('COPIED', 'ok'), () => this.toast('copy not allowed here — select the text', 'bad'));
      row.append(h('div', 'll', l.label), code, copy);
      p.append(row);
    }
    await show(0);
  }

  newWindow(preset: string) {
    if (window.wallHost) return void window.wallHost.newWindow(preset);
    const q = new URLSearchParams(location.search);
    q.set('preset', preset);
    window.open(`${location.pathname}?${q.toString()}`, `_blank`, 'popup,width=1400,height=900');
  }

  /** Open one window per monitor, each with a different preset. */
  async allMonitors() {
    const order = ['wall', 'conus', 'missiles', 'stats', 'world', 'europe', 'eurasia', 'polar'];
    if (window.wallHost?.allDisplays) {
      const n = await window.wallHost.allDisplays();
      return this.toast(`OPENED ${n} DISPLAY WINDOW(S)`);
    }
    const anyWin = window as any;
    if (anyWin.getScreenDetails) {
      try {
        const det = await anyWin.getScreenDetails();
        det.screens.forEach((s: any, i: number) => {
          if (s === det.currentScreen) return;
          const q = new URLSearchParams(location.search);
          q.set('preset', order[i % order.length]);
          window.open(`${location.pathname}?${q}`, `wall${i}`, `left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}`);
        });
        return this.toast('WINDOWS PLACED — PRESS F11 ON EACH FOR FULLSCREEN');
      } catch { /* permission denied → fall through */ }
    }
    for (const p of ['conus', 'missiles', 'stats']) this.newWindow(p);
    this.toast('DRAG EACH WINDOW TO A MONITOR');
  }

  tooltip(text: string | null, x: number, y: number) {
    if (!text) return this.tip.classList.add('hidden');
    this.tip.textContent = text;
    this.tip.style.left = `${x + 14}px`;
    this.tip.style.top = `${y + 10}px`;
    this.tip.classList.remove('hidden');
  }

  private findUnit(id: string | null): Unit | Contact | undefined {
    if (!id) return undefined;
    const s = this.host.client.snap;
    return s?.units.find((u) => u.id === id) ?? s?.contacts.find((u) => u.id === id);
  }

  updateInfo() {
    const id = this.host.st.selected;
    const snap = this.host.client.snap;
    const d = id && snap ? selectionDetails(id, snap) : null;
    if (!d) {
      if (id && snap && !snap.missiles.some((m) => m.id === id) && id.startsWith('m')) this.host.st.selected = null; // missile has landed
      return this.info.classList.add('hidden');
    }
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    this.info.innerHTML = `<div class="ih">${esc(d.title)}</div>` + d.lines
      .map((l) => `<div class="irow ${l.tone ?? ''}"><span class="ik">${l.label}</span><span class="iv">${esc(l.value)}</span></div>`).join('');
    this.info.classList.remove('hidden');
  }

  contextMenu(x: number, y: number, unitId: string | null, ll: LatLon) {
    const c = this.host.client;
    const items: [string, () => void][] = [];
    const u = this.findUnit(unitId);
    const own = u && (this.host.st.role === 'SPECTATOR' || u.side === this.host.st.role) && !('seenT' in u);
    const target = (label: string, build: (t: string) => Command) => () => this.startTarget(label, build);
    if (u && own) {
      const x2 = u as Unit;
      if ((u.kind === 'silo' || u.kind === 'ssbn') && (x2.missiles ?? 0) > 0) {
        items.push([`LAUNCH 1 FROM ${u.id.toUpperCase()} →`, target('SELECT TARGET — LAUNCH 1', (t) => ({ op: 'launch', from: u.id, target: t, count: 1 }))]);
        items.push([`LAUNCH 4 →`, target('SELECT TARGET — LAUNCH 4', (t) => ({ op: 'launch', from: u.id, target: t, count: 4 }))]);
        items.push([`LAUNCH ALL (${x2.missiles}) →`, target('SELECT TARGET — LAUNCH ALL', (t) => ({ op: 'launch', from: u.id, target: t, count: x2.missiles }))]);
      }
      if (u.kind === 'airbase' && (x2.aircraft ?? 0) > 0) {
        items.push(['SCRAMBLE ALL', () => this.send({ op: 'scramble', base: u.id })]);
        items.push(['SCRAMBLE HALF', () => this.send({ op: 'scramble', base: u.id, count: Math.ceil((x2.aircraft ?? 2) / 2) })]);
        items.push(['SCRAMBLE TO ORBIT →', target('SELECT ORBIT POINT', (t) => ({ op: 'scramble', base: u.id, to: t }))]);
      }
      if (u.kind === 'bomber') {
        items.push(['GO-CODE: STRIKE →', target('SELECT TARGET — BOMBER STRIKE', (t) => ({ op: 'strike', unit: u.id, target: t }))]);
        items.push(['NEW ORBIT →', target('SELECT ORBIT POINT', (t) => ({ op: 'move', unit: u.id, to: t }))]);
        items.push(['RECALL', () => this.send({ op: 'recall', unit: u.id })]);
      }
      if (u.kind === 'carrier' || u.kind === 'ssbn' || u.kind === 'ssn') items.push(['MOVE TO →', target('SELECT DESTINATION', (t) => ({ op: 'move', unit: u.id, to: t }))]);
    }
    if (u) items.push(['SHOW IN TERMINAL', () => c.focus({ lat: u.lat, lon: u.lon, unit: u.id, label: u.name })]);
    items.push([`FOCUS TERMINAL HERE (${fmtLatLon(ll)})`, () => c.focus({ lat: ll.lat, lon: ll.lon, zoom: 8, label: fmtLatLon(ll) })]);
    if (this.host.st.role !== 'SPECTATOR') {
      for (const lvl of [5, 4, 3, 2, 1]) items.push([`DEFCON ${lvl}`, () => this.send({ op: 'defcon', level: lvl })]);
    }
    items.push([c.snap?.paused ? 'RESUME' : 'PAUSE', () => this.send({ op: 'pause' })]);
    this.menu.innerHTML = '';
    for (const [label, fn] of items) {
      const b = h('button', label.startsWith('LAUNCH') ? 'danger' : '', label);
      b.onclick = (e) => { e.stopPropagation(); this.menu.classList.add('hidden'); fn(); };
      this.menu.append(b);
    }
    this.menu.style.left = `${Math.min(x, window.innerWidth - 260)}px`;
    this.menu.style.top = `${Math.min(y, window.innerHeight - items.length * 26 - 10)}px`;
    this.menu.classList.remove('hidden');
  }

  private startTarget(label: string, build: (t: string) => Command) {
    this.targeting = { label, build };
    this.banner.textContent = `${label} — CLICK THE MAP · ESC TO CANCEL`;
    this.banner.classList.remove('hidden');
  }

  completeTarget(unitId: string | null, ll: LatLon | null) {
    const tg = this.targeting;
    if (!tg) return;
    this.targeting = null;
    this.banner.classList.add('hidden');
    const t = unitId ?? (ll ? `${ll.lat.toFixed(2)},${ll.lon.toFixed(2)}` : null);
    if (!t) return;
    const cmd = tg.build(t);
    if (cmd.op === 'launch' && !confirm(`${describeCommand(cmd)}\n\nMissiles cannot be recalled. Confirm launch order?`)) return;
    this.send(cmd);
  }

  cancel() {
    this.targeting = null;
    this.banner.classList.add('hidden');
    this.menu.classList.add('hidden');
    this.toggle('');
  }

  private async send(cmd: Command) {
    const r = await this.host.client.cmd(cmd);
    this.toast(r.msg, r.ok ? 'ok' : 'bad');
  }

  toast(msg: string, cls = '') {
    const t = h('div', `toast ${cls}`, msg.replace(/</g, '&lt;'));
    this.toasts.append(t);
    setTimeout(() => t.classList.add('gone'), 4500);
    setTimeout(() => t.remove(), 5200);
  }

  onEvent(e: GameEvent) {
    if (e.kind === 'hotline') this.toast(`HOTLINE — ${e.text}`, 'hot');
    if (e.kind === 'end') this.toast(e.text, 'end');
    if (!this.sound) return;
    if (e.kind === 'alert' || e.kind === 'impact' || e.kind === 'launch') this.beep(e.kind === 'impact' ? 90 : e.kind === 'alert' ? 880 : 440, e.kind === 'impact' ? 0.6 : 0.18);
  }

  private beep(freq: number, dur: number) {
    this.audio ??= new AudioContext();
    const a = this.audio, o = a.createOscillator(), g = a.createGain();
    o.type = freq < 200 ? 'sawtooth' : 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.06, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + dur);
  }

  showConnect(msg: string) {
    this.connectBox.innerHTML = `<div class="ph">LINK TO GAME SESSION</div><p>${msg.replace(/</g, '&lt;')}</p>`;
    const inp = h('input') as HTMLInputElement;
    inp.placeholder = 'coldlaunch://127.0.0.1:7700/s/…';
    inp.value = this.host.currentLink() ?? '';
    const b = h('button', '', 'CONNECT');
    b.onclick = () => this.host.connect(inp.value.trim());
    inp.onkeydown = (e) => { if (e.key === 'Enter') this.host.connect(inp.value.trim()); };
    this.connectBox.append(inp, b);
    this.connectBox.classList.remove('hidden');
  }

  hideConnect() {
    this.connectBox.classList.add('hidden');
  }
}
