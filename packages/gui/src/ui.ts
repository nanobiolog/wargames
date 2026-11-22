// DOM overlays: toolbar, layer/CRT panels, info card, context menu, targeting, toasts, connect dialog.
import {
  KIND_LABEL, fmtLatLon, describeCommand, selectionDetails, distKm, stanceOf, type Command, type Contact, type GameClient, type GameEvent, type LatLon, type Unit,
} from '@coldlaunch/shared';
import type { FxSettings } from './gl.ts';
import { LAYER_LIST, type LayerKey, type Pick, type SceneState } from './scene.ts';

/** What a targeting click may hit: nuclear (ships, bases, cities), military (ships and bases), place (anywhere). */
export type TargetMode = 'nuclear' | 'military' | 'place';
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
  targeting: null | { label: string; accept: TargetMode; build: (target: string) => Command } = null;
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
    const btn = (label: string, fn: () => void, title = '', cls = '') => {
      const b = h('button', cls, label);
      b.title = title;
      b.onclick = (e) => { e.stopPropagation(); t.classList.remove('open'); fn(); };
      t.append(b);
      return b;
    };
    btn(`VIEW: ${PRESET_LABEL[this.host.getPreset()] ?? this.host.getPreset()}`, () => this.toggle('presets'), 'Choose what this window shows (1-9)');
    if (this.host.openLobby) btn('LOBBY', () => this.host.openLobby!(), 'Create or join online matches, invite friends');
    btn('SHARE', () => this.openShare(), 'QR codes for phones and other PCs');
    btn('CONSOLE', () => this.host.toggleConsole(), '` — type orders right here');
    btn('LAYERS', () => this.toggle('layers'), 'L');
    btn('CRT', () => this.toggle('crt'), 'C');
    btn('NEW WINDOW', () => this.newWindow(this.host.getPreset() === 'wall' ? 'world' : 'wall'), 'Open another display window', 'desk');
    btn('ALL MONITORS', () => void this.allMonitors(), 'One preset per connected monitor', 'desk');
    btn(this.sound ? 'SOUND ON' : 'SOUND OFF', () => { this.sound = !this.sound; this.refresh(); });
    btn('SETTINGS', () => this.host.openSettings(), 'Graphics, callsign, AI keys, invites', 'setbtn');
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

  /**
   * Right-click menu. On your own unit: everything that unit can do (launch, cruise missiles, jets,
   * drones, scramble, strike, move...). On an enemy ship, base or a city: the weapons of yours that
   * can reach it. Orders that need a target start targeting mode, where the click snaps to the ship,
   * base or city under the cursor.
   */
  contextMenu(x: number, y: number, pick: Pick | null, ll: LatLon) {
    const c = this.host.client;
    const role = this.host.st.role;
    const snap = c.snap;
    const items: { label: string; fn?: () => void; cls?: string }[] = [];
    const add = (label: string, fn: () => void, cls = '') => items.push({ label, fn, cls });
    const head = (label: string) => items.push({ label, cls: 'mhead' });
    const u = this.findUnit(pick?.id ?? null);
    const own = !!u && role !== 'SPECTATOR' && u.side === role && !('seenT' in u);
    const T = (label: string, accept: TargetMode, build: (t: string) => Command) => () => this.startTarget(label, accept, build);
    const mine = (snap?.units ?? []).filter((x) => x.side === role && x.status !== 'destroyed');
    if (u && own) {
      const x2 = u as Unit;
      head(`${u.name} · ${KIND_LABEL[u.kind]}`);
      if ((u.kind === 'silo' || u.kind === 'ssbn') && (x2.missiles ?? 0) > 0) {
        add('☢ LAUNCH 1 MISSILE →', T('NUCLEAR TARGET — LAUNCH 1', 'nuclear', (t) => ({ op: 'launch', from: u.id, target: t, count: 1 })), 'danger');
        add('☢ LAUNCH 4 →', T('NUCLEAR TARGET — LAUNCH 4', 'nuclear', (t) => ({ op: 'launch', from: u.id, target: t, count: 4 })), 'danger');
        add(`☢ LAUNCH ALL (${x2.missiles}) →`, T('NUCLEAR TARGET — LAUNCH ALL', 'nuclear', (t) => ({ op: 'launch', from: u.id, target: t, count: x2.missiles })), 'danger');
      }
      if ((x2.cruise ?? 0) > 0) {
        add(`CRUISE MISSILES ×4 → (${x2.cruise} aboard)`, T('CRUISE MISSILE TARGET — SHIP OR BASE', 'military', (t) => ({ op: 'cruise', from: u.id, target: t, count: 4 })));
        if ((x2.cruise ?? 0) > 4) add(`CRUISE MISSILES ×${Math.min(8, x2.cruise ?? 0)} →`, T('CRUISE MISSILE TARGET — SHIP OR BASE', 'military', (t) => ({ op: 'cruise', from: u.id, target: t, count: Math.min(8, x2.cruise ?? 0) })));
        if ((x2.cruise ?? 0) > 8) add(`CRUISE MISSILES — ALL ${x2.cruise} →`, T('CRUISE MISSILE TARGET — SHIP OR BASE', 'military', (t) => ({ op: 'cruise', from: u.id, target: t, count: x2.cruise })));
      }
      if ((u.kind === 'carrier' || u.kind === 'afb_int') && (x2.interceptors ?? 0) > 0) {
        head(`JETS (${x2.interceptors} ${u.kind === 'carrier' ? 'aboard' : 'on base'})`);
        add('RECON FLIGHT →', T('RECON — WHERE TO SEARCH', 'place', (t) => ({ op: 'sortie', from: u.id, mission: 'recon', to: t })));
        add(`COMBAT AIR PATROL OVER ${u.kind === 'carrier' ? 'THE GROUP' : 'THE BASE'}`, () => this.send({ op: 'sortie', from: u.id, mission: 'cap' }));
        add('COMBAT AIR PATROL AT →', T('CAP — WHERE TO PATROL', 'place', (t) => ({ op: 'sortie', from: u.id, mission: 'cap', to: t })));
        add(`JET STRIKE ×${Math.min(8, x2.interceptors ?? 0)} →`, T('JET STRIKE TARGET — SHIP OR BASE', 'military', (t) => ({ op: 'sortie', from: u.id, mission: 'strike', to: t, count: Math.min(8, x2.interceptors ?? 0) })));
        if ((x2.interceptors ?? 0) > 8) add(`JET STRIKE — ALL ${x2.interceptors} →`, T('JET STRIKE TARGET — SHIP OR BASE', 'military', (t) => ({ op: 'sortie', from: u.id, mission: 'strike', to: t, count: x2.interceptors })));
      }
      if ((x2.drones ?? 0) > 0) {
        head(`DRONES (${x2.drones})`);
        add('ISR DRONE →', T('DRONE — WHERE TO WATCH', 'place', (t) => ({ op: 'sortie', from: u.id, mission: 'drone', to: t })));
        add(`ATTACK SWARM ×${Math.min(12, x2.drones ?? 0)} →`, T('DRONE SWARM TARGET — SHIP OR BASE', 'military', (t) => ({ op: 'sortie', from: u.id, mission: 'swarm', to: t, count: Math.min(12, x2.drones ?? 0) })));
      }
      if (u.kind === 'airbase' && (x2.aircraft ?? 0) > 0) {
        head(`BOMBERS (${x2.aircraft} × ${u.cls})`);
        add('SCRAMBLE ALL', () => this.send({ op: 'scramble', base: u.id }));
        add('SCRAMBLE HALF', () => this.send({ op: 'scramble', base: u.id, count: Math.ceil((x2.aircraft ?? 2) / 2) }));
        add('SCRAMBLE TO ORBIT →', T('BOMBER ORBIT POINT', 'place', (t) => ({ op: 'scramble', base: u.id, to: t })));
      }
      if (u.kind === 'bomber') {
        add('☢ GO-CODE: STRIKE →', T('NUCLEAR TARGET — BOMBER STRIKE', 'nuclear', (t) => ({ op: 'strike', unit: u.id, target: t })), 'danger');
        add('NEW ORBIT →', T('NEW ORBIT POINT', 'place', (t) => ({ op: 'move', unit: u.id, to: t })));
        add('RECALL', () => this.send({ op: 'recall', unit: u.id }));
      }
      if (u.kind === 'flight') add('RECALL TO BASE', () => this.send({ op: 'recall', unit: u.id }));
      if (u.kind === 'carrier' || u.kind === 'ssbn' || u.kind === 'ssn') add('MOVE TO →', T('DESTINATION', 'place', (t) => ({ op: 'move', unit: u.id, to: t })));
    } else if (pick && role !== 'SPECTATOR' && (pick.kind === 'contact' || pick.kind === 'city') && pick.side !== role) {
      // attack this ship / base / city with whatever can reach it
      const tgt = { lat: pick.lat ?? ll.lat, lon: pick.lon ?? ll.lon };
      const isCity = pick.kind === 'city';
      const targetRef = isCity ? pick.name.replace(/ \(CITY\)$/, '') : pick.id;
      const near = (list: Unit[], max: number, n: number) => list.map((v) => ({ v, d: distKm(v, tgt) })).filter((x) => x.d <= max).sort((a, b) => a.d - b.d).slice(0, n);
      head(`ATTACK ${pick.name}`);
      if (!isCity && pick.ukind !== 'satellite') {
        for (const { v, d } of near(mine.filter((v) => (v.cruise ?? 0) > 0), 99999, 3).filter(({ v, d }) => d <= (v.cruiseRangeKm ?? 1500))) {
          add(`CRUISE ×${Math.min(4, v.cruise ?? 0)} FROM ${v.id.toUpperCase()} (${Math.round(d)} KM)`, () => this.send({ op: 'cruise', from: v.id, target: targetRef, count: Math.min(4, v.cruise ?? 0) }));
        }
        for (const { v, d } of near(mine.filter((v) => (v.kind === 'carrier' || v.kind === 'afb_int') && (v.interceptors ?? 0) >= 2), 1500, 3)) {
          add(`JET STRIKE FROM ${v.id.toUpperCase()} (${Math.round(d)} KM)`, () => this.send({ op: 'sortie', from: v.id, mission: 'strike', to: targetRef, count: Math.min(8, v.interceptors ?? 0) }));
        }
        for (const { v, d } of near(mine.filter((v) => (v.drones ?? 0) > 0), 2500, 2)) {
          add(`DRONE SWARM FROM ${v.id.toUpperCase()} (${Math.round(d)} KM)`, () => this.send({ op: 'sortie', from: v.id, mission: 'swarm', to: targetRef, count: Math.min(12, v.drones ?? 0) }));
        }
        const rec = near(mine.filter((v) => (v.kind === 'carrier' || v.kind === 'afb_int') && (v.interceptors ?? 0) >= 2), 1500, 1)[0];
        if (rec) add(`RECON FLIGHT FROM ${rec.v.id.toUpperCase()}`, () => this.send({ op: 'sortie', from: rec.v.id, mission: 'recon', to: `${tgt.lat.toFixed(2)},${tgt.lon.toFixed(2)}` }));
        const isr = near(mine.filter((v) => (v.drones ?? 0) > 0), 3000, 1)[0];
        if (isr) add(`ISR DRONE FROM ${isr.v.id.toUpperCase()}`, () => this.send({ op: 'sortie', from: isr.v.id, mission: 'drone', to: `${tgt.lat.toFixed(2)},${tgt.lon.toFixed(2)}` }));
      }
      for (const v of mine.filter((v) => v.kind === 'bomber' && (v.bombs ?? 0) > 0 && v.status !== 'enroute').slice(0, 3)) {
        add(`☢ BOMBER STRIKE: ${v.id.toUpperCase()}`, () => this.confirmSend({ op: 'strike', unit: v.id, target: targetRef }), 'danger');
      }
      for (const { v, d } of near(mine.filter((v) => (v.kind === 'silo' || v.kind === 'ssbn') && (v.missiles ?? 0) > 0), 99999, 6).filter(({ v, d }) => d <= (v.rangeKm ?? 12000)).slice(0, 3)) {
        add(`☢ LAUNCH 1 FROM ${v.id.toUpperCase()} (${Math.round(d)} KM)`, () => this.confirmSend({ op: 'launch', from: v.id, target: targetRef, count: 1 }), 'danger');
      }
      if (items.length === 1) items.push({ label: 'NOTHING OF YOURS CAN REACH IT', cls: 'mnote' });
    }
    head('MAP');
    if (u) add('SHOW IN TERMINAL', () => c.focus({ lat: u.lat, lon: u.lon, unit: u.id, label: u.name }));
    add(`FOCUS TERMINAL HERE (${fmtLatLon(ll)})`, () => c.focus({ lat: ll.lat, lon: ll.lon, zoom: 8, label: fmtLatLon(ll) }));
    if (role !== 'SPECTATOR') {
      head('READINESS');
      const cur = snap?.defcon[role] ?? 5;
      for (const lvl of [5, 4, 3, 2, 1]) add(`DEFCON ${lvl}${lvl === cur ? ' (NOW)' : ''}`, () => this.send({ op: 'defcon', level: lvl }));
    }
    add(snap?.paused ? 'RESUME' : 'PAUSE', () => this.send({ op: 'pause' }));
    this.menu.innerHTML = '';
    for (const it of items) {
      if (!it.fn) { this.menu.append(h('div', it.cls ?? 'mhead', it.label.replace(/</g, '&lt;'))); continue; }
      const b = h('button', it.cls ?? '', it.label.replace(/</g, '&lt;'));
      b.onclick = (e) => { e.stopPropagation(); this.menu.classList.add('hidden'); it.fn!(); };
      this.menu.append(b);
    }
    this.menu.classList.remove('hidden');
    const r = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
    this.menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;
  }

  private startTarget(label: string, accept: TargetMode, build: (t: string) => Command) {
    this.targeting = { label, accept, build };
    const hint = accept === 'nuclear' ? 'CLICK AN ENEMY SHIP, BASE OR CITY' : accept === 'military' ? 'CLICK AN ENEMY SHIP OR BASE' : 'CLICK THE MAP (SNAPS TO NEARBY SHIPS, BASES, CITIES)';
    this.banner.textContent = `${label} — ${hint} · ESC TO CANCEL`;
    this.banner.classList.remove('hidden');
  }

  /** What a click would target in the current targeting mode (snaps to the nearest fitting pick). */
  targetFor(picks: Pick[] | undefined, sx: number, sy: number, radius: number): Pick | null {
    const tg = this.targeting;
    if (!tg || !picks) return null;
    const role = this.host.st.role;
    const ok = (k: Pick) => {
      if (k.kind === 'missile') return false;
      if (tg.accept === 'place') return true;
      if (k.kind === 'own') return false;
      if (k.side === role) return false;
      // your own and your allies' forces and cities are never offered as targets
      if (k.side && stanceOf(this.host.st.world, role, k.side) === 'allied') return false;
      if (k.kind === 'city') return tg.accept === 'nuclear' && k.side !== 'OTHER';
      return k.ukind !== 'satellite';
    };
    let best: Pick | null = null, bd = radius * radius;
    for (const k of picks) {
      if (!ok(k)) continue;
      const d = (k.x - sx) ** 2 + (k.y - sy) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  /** Finish targeting with what the click snapped to. Returns false (and stays in targeting) if nothing valid was hit. */
  completeTarget(pick: Pick | null, ll: LatLon | null): boolean {
    const tg = this.targeting;
    if (!tg) return true;
    let t: string | null = null;
    if (pick) t = pick.kind === 'city' ? pick.name.replace(/ \(CITY\)$/, '') : pick.id;
    else if (tg.accept === 'place' && ll) t = `${ll.lat.toFixed(2)},${ll.lon.toFixed(2)}`;
    if (!t) {
      this.toast(tg.accept === 'nuclear' ? 'NO TARGET THERE — CLICK AN ENEMY SHIP, BASE OR CITY' : 'NO TARGET THERE — CLICK AN ENEMY SHIP OR BASE', 'bad');
      return false;
    }
    this.targeting = null;
    this.host.st.targetHover = null;
    this.banner.classList.add('hidden');
    const cmd = tg.build(t);
    if (cmd.op === 'launch' || cmd.op === 'strike') this.confirmSend(cmd);
    else this.send(cmd);
    return true;
  }

  /** Nuclear orders always ask first. */
  private confirmSend(cmd: Command) {
    if (!confirm(`${describeCommand(cmd)}\n\nThis is a nuclear order and cannot be recalled once missiles fly. Confirm?`)) return;
    this.send(cmd);
  }

  cancel() {
    this.targeting = null;
    this.host.st.targetHover = null;
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
