import { GameClient, makeLink, makeMatchLink, normalizeCode, parseLink, type Focus, type GameEvent, type LatLon, type PlanProposal, type Role, type Snapshot } from '@coldlaunch/shared';
import { Renderer, DynBatch, type FxSettings } from './gl.ts';
import { GeoStore, bucketize } from './geo.ts';
import { buildWorld, LAYER_LIST, type LayerKey, type SceneState } from './scene.ts';
import { MOTION, drawPanel, layoutFor, phoneLayout, panelAt, zoomPanel, panPanel, flyTo, nearestPick, PRESET_NAMES, type Panel, type WallCtx, type PhoneMode } from './wall.ts';
import { PhoneHud } from './phone.ts';
import { Ui } from './ui.ts';
import { Console } from './console.ts';
import { Online, DEFAULT_SETTINGS, type Settings } from './online.ts';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const r = new Renderer(canvas);
const geo = new GeoStore(r);
const client = new GameClient('gui');

const store = {
  get<T>(k: string, d: T): T {
    try { const v = localStorage.getItem(`cl:${k}`); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
  },
  set(k: string, v: unknown) {
    try { localStorage.setItem(`cl:${k}`, JSON.stringify(v)); } catch { /* ignore */ }
  },
};

const defaultLayers = Object.fromEntries(LAYER_LIST.map(([k]) => [k, !['admin1', 'radar', 'airdef'].includes(k)])) as Record<LayerKey, boolean>;
const st: SceneState = {
  role: 'USA', tNow: 0, selected: null, hover: null, plan: null, dpr: 1,
  layers: { ...defaultLayers, ...store.get('layers', {}) },
  trails: new Map(), places: [],
};
const fx: FxSettings = { bloom: 0.55, persistence: 0.8, scanlines: 0.3, exposure: 1.05, ...store.get('fx2', {}) };
const smallTouch = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;
const settings: Settings = { ...DEFAULT_SETTINGS, ...(smallTouch ? { fpsCap: 30, dprCap: 2 } : {}), ...store.get<Partial<Settings>>('settings', {}) };
const fxPersistence = fx.persistence;
function applySettings() {
  MOTION.flyMs = settings.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 900;
  if (settings.reduceMotion) fx.persistence = 0;
  else if (fx.persistence === 0) fx.persistence = fxPersistence || 0.8;
  relayout();
}
let preset = params.get('preset') ?? (smallTouch ? 'phone' : store.get('preset', 'wall'));
let phoneMode: PhoneMode = store.get('phoneMode', 'split');
if (!PRESET_NAMES.includes(preset)) preset = 'wall';
let panels: Panel[] = [];
let maximized: string | null = null;
let hud: PhoneHud | null = null;
let snapAt = 0;
const events: GameEvent[] = [];
const grids = makeGrids();
const ctx: WallCtx = { r, geo, grids, st, world: new DynBatch(), events, scratch: new DynBatch(), connected: false };

function makeGrids() {
  const mk = (step: number) => {
    const lines: number[][] = [];
    for (let lon = -180; lon < 180; lon += step) { const l: number[] = []; const top = step >= 30 || lon % 30 === 0 ? 84 : 76; for (let lat = -80; lat <= top; lat += Math.min(step, 2)) l.push(lon, lat); lines.push(l); }
    for (let lat = -80; lat <= 85; lat += step) { const l: number[] = []; for (let lon = -180; lon <= 180; lon += Math.min(step, 2)) l.push(lon, lat); lines.push(l); }
    const b = bucketize(lines);
    return r.uploadGeo(b.segs, b.starts, b.counts);
  };
  return { g30: mk(30), g10: mk(10), g5: mk(5), g1: mk(1) };
}

// ------------------------------------------------------------------ layout

function relayout() {
  const dpr = Math.min(settings.dprCap, window.devicePixelRatio || 1);
  st.dpr = dpr;
  const W = Math.floor(window.innerWidth * dpr), H = Math.floor(window.innerHeight * dpr);
  r.resize(W, H);
  const keep = new Map(panels.map((p) => [p.id, p]));
  const isPhone = preset === 'phone';
  document.body.classList.toggle('phone', isPhone);
  for (const m of ['split', 'map', 'console']) document.body.classList.toggle(`phone-${m}`, isPhone && phoneMode === m);
  document.body.classList.toggle('landscape', W > H * 1.1);
  const hudPx = isPhone ? (hud ? hud.height() : 48) : 0;
  document.body.style.setProperty('--hud-h', `${hudPx}px`);
  const headerFrac = (hudPx * dpr) / H;
  panels = (isPhone ? phoneLayout(W / H, phoneMode, headerFrac) : layoutFor(preset, W / H)).map((p) => {
    const old = keep.get(p.id);
    return old ? { ...p, view: old.view, title: old.focus ? old.title : p.title } : p;
  });
  for (const p of panels) {
    const rect = maximized === p.id && p.kind !== 'strip' ? { x: 0.006, y: 0.006, w: 0.988, h: 1 - 0.055 - 0.024 } : p.rect;
    p.px = { x: Math.round(rect.x * W), y: Math.round(rect.y * H), w: Math.round(rect.w * W), h: Math.round(rect.h * H) };
  }
}

function setPhoneMode(m: PhoneMode) {
  phoneMode = m;
  store.set('phoneMode', m);
  relayout();
  if (m !== 'map') konsole.toggle(true);
}

function setPreset(name: string) {
  preset = name;
  if (name === 'phone') setTimeout(() => konsole.toggle(true), 0);
  maximized = null;
  panels = [];
  store.set('preset', name);
  relayout();
  ui.refresh();
}

// ------------------------------------------------------------------ connection

function resolveLink(): string | null {
  const m = normalizeCode(params.get('m') ?? '');
  if (m && location.protocol.startsWith('http')) return makeMatchLink(location.origin, m, (params.get('role') as Role) ?? undefined);
  const l = params.get('link');
  if (l && parseLink(l)) return l;
  const token = params.get('token');
  if (token && location.protocol.startsWith('http')) {
    return makeLink(location.hostname, Number(location.port || 80), token, (params.get('role') as Role) ?? undefined);
  }
  return store.get<string | null>('link', null);
}

async function connect(link: string) {
  try {
    // the link carries the role; the page's original ?role= must not override a later invite link
    await client.connect(link);
    store.set('link', link);
    (window as any).wallHost?.setLink(link);
    ctx.connected = true;
    ui.hideConnect();
  } catch (e) {
    if (online.available) online.showLobby(`Could not join: ${(e as Error).message}`);
    else ui.showConnect(`${(e as Error).message}`);
  }
}

client.on('welcome', () => {
  st.role = (client.role ?? 'USA') as SceneState['role'];
  konsole.setRole(st.role);
  events.length = 0;
  st.trails.clear();
  ui.refresh();
});
client.on('snap', (s: Snapshot) => {
  snapAt = performance.now();
  hud?.update(s);
  konsole.onSnapshot();
  // client-side movement history for tracks
  for (const u of [...s.units, ...s.contacts]) {
    if (u.kind !== 'bomber' && u.kind !== 'carrier' && u.kind !== 'ssbn' && u.kind !== 'ssn') continue;
    if (u.status === 'destroyed') continue;
    const tr = st.trails.get(u.id) ?? [];
    const last = tr[tr.length - 1];
    if (!last || Math.abs(last.lat - u.lat) + Math.abs(last.lon - u.lon) > 0.25) {
      tr.push({ lat: u.lat, lon: u.lon });
      if (tr.length > 300) tr.shift();
      st.trails.set(u.id, tr);
    }
  }
  ui.updateInfo();
});
client.on('events', (evs: GameEvent[]) => {
  events.push(...evs);
  if (events.length > 400) events.splice(0, events.length - 400);
  for (const e of evs) { ui.onEvent(e); konsole.onEvent(e); }
});
client.on('focus', ({ focus }: { focus: Focus }) => applyFocus(focus));
client.on('plan', (p: PlanProposal | null) => (st.plan = p));
client.on('status', (s: string) => {
  if (s === 'disconnected') ctx.connected = false;
  if (s === 'connected') ctx.connected = true;
  if (s !== 'connected' && s !== 'disconnected') ui.toast(s);
});

function applyFocus(f: Focus) {
  if (f.unit) st.selected = f.unit;
  const target = panels.find((p) => p.focus) ?? panels.find((p) => p.kind === 'map');
  if (!target) return;
  const zoom = target.focus && preset === 'wall' ? Math.max(f.zoom ?? 0, 30) : f.zoom ?? Math.max(target.view?.zoom ?? 1, 4);
  flyTo(target, f.lat, f.lon, zoom, target.focus && f.label ? f.label : undefined);
  ui.updateInfo();
}

// ------------------------------------------------------------------ input

let drag: { p: Panel; x: number; y: number; moved: boolean } | null = null;

function devXY(e: MouseEvent): [number, number] {
  return [e.clientX * st.dpr, e.clientY * st.dpr];
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [x, y] = devXY(e);
  const p = panelAt(panels, x, y);
  if (!p || p.kind !== 'map') return;
  const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
  zoomPanel(p, f, x - p.px!.x, y - p.px!.y);
}, { passive: false });

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const [x, y] = devXY(e);
  const p = panelAt(panels, x, y);
  if (p) drag = { p, x, y, moved: false };
});
window.addEventListener('mousemove', (e) => {
  const [x, y] = devXY(e);
  ui.pointer(e.clientX, e.clientY);
  if (drag && drag.p.kind === 'map') {
    const dx = x - drag.x, dy = y - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    if (drag.moved) panPanel(drag.p, dx, dy);
    drag.x = x;
    drag.y = y;
    return;
  }
  const p = panelAt(panels, x, y);
  const hit = p && p.kind === 'map' ? nearestPick(p, x - p.px!.x, y - p.px!.y, 12 * st.dpr) : null;
  st.hover = hit?.id ?? null;
  ui.tooltip(hit ? hit.name : null, e.clientX, e.clientY);
});
window.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.moved || d.p.kind !== 'map') return;
  const [x, y] = devXY(e);
  const lx = x - d.p.px!.x, ly = y - d.p.px!.y;
  const hit = nearestPick(d.p, lx, ly, 12 * st.dpr);
  const ll = d.p.xf ? fromXf(d.p, lx, ly) : null;
  if (ui.targeting) {
    ui.completeTarget(hit?.id ?? null, ll);
    return;
  }
  st.selected = hit?.id ?? null;
  if (hit) {
    const u = [...(client.snap?.units ?? []), ...(client.snap?.contacts ?? [])].find((q) => q.id === hit.id);
    if (u) client.focus({ lat: u.lat, lon: u.lon, unit: u.id, label: u.name });
  }
  ui.updateInfo();
});
canvas.addEventListener('dblclick', (e) => {
  const [x, y] = devXY(e);
  const p = panelAt(panels, x, y);
  if (!p || p.kind === 'strip') return;
  maximized = maximized === p.id ? null : p.id;
  relayout();
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const [x, y] = devXY(e);
  const p = panelAt(panels, x, y);
  if (!p || p.kind !== 'map') return;
  const hit = nearestPick(p, x - p.px!.x, y - p.px!.y, 14 * st.dpr);
  const ll = fromXf(p, x - p.px!.x, y - p.px!.y);
  ui.contextMenu(e.clientX, e.clientY, hit?.id ?? null, ll);
});

import { fromScreen } from './proj.ts';
function fromXf(p: Panel, x: number, y: number): LatLon {
  return fromScreen(p.xf!, x, y);
}

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'Escape') { ui.cancel(); maximized = null; relayout(); }
  else if (e.key === '`') { e.preventDefault(); konsole.toggle(); }
  else if (e.key === 'l' || e.key === 'L') ui.toggle('layers');
  else if (e.key === 'c' || e.key === 'C') ui.toggle('crt');
  else if (e.key === 'r' || e.key === 'R') { for (const p of panels) if (p.home) p.view = { ...p.home }; }
  else if (e.key === ' ') void client.cmd({ op: 'pause' });
  else if (e.key === '?' || e.key === 'h') ui.toggle('help');
  else if (/^[1-9]$/.test(e.key)) setPreset(PRESET_NAMES[+e.key - 1] ?? 'wall');
  else if (e.key === '0') setPreset(PRESET_NAMES[9] ?? 'wall');
});
window.addEventListener('resize', relayout);

// ------------------------------------------------------------------ UI

const ui = new Ui(document.getElementById('ui')!, {
  client, st, fx,
  getPreset: () => preset,
  setPreset,
  saveLayers: () => store.set('layers', st.layers),
  saveFx: () => store.set('fx2', fx),
  connect: (link) => void connect(link),
  currentLink: () => client.link ?? null,
  toggleConsole: () => konsole.toggle(),
  openSettings: () => online.openSettings(),
  onlineShare: () => online.openShare(),
  openLobby: () => (online.available ? online.showLobby() : ui.showConnect('Paste the session link printed in your terminal.')),
});

const online = new Online(document.getElementById('ui')!, {
  client, store, fx, settings, applySettings,
  connect: (link) => connect(link),
  toast: (m, cls) => ui.toast(m, cls),
  showLocalConnect: (m) => ui.showConnect(m),
});

function mainMap(): Panel | undefined {
  return panels.find((p) => p.focus) ?? panels.find((p) => p.kind === 'map');
}

function webLinks(): [string, string][] {
  const p = client.link ? parseLink(client.link) : null;
  const base = location.protocol.startsWith('http') ? location.origin : p ? `http://${p.host}:${p.port}` : '';
  const token = params.get('token') ?? p?.token;
  if (!base || !token) return [];
  const enemy = st.role === 'USA' ? 'USSR' : 'USA';
  return [
    ['you (this side)', `${base}/?token=${token}&role=${st.role}`],
    ['spectator wall', `${base}/?token=${token}&role=SPECTATOR&preset=wall`],
    [`other side (${enemy})`, `${base}/?token=${token}&role=${enemy}`],
    ['missile board', `${base}/?token=${token}&role=${st.role}&preset=missiles`],
    ['terminal (other PC)', `npm start -- --join ${client.link ?? ''}`],
  ];
}

const konsole = new Console(document.getElementById('ui')!, {
  client, st,
  places: () => geo.places,
  flyTo: (lat, lon, zoom, label) => { const p = mainMap(); if (p) flyTo(p, lat, lon, zoom ?? p.view?.zoom, p.focus ? label : undefined); },
  zoomBy: (f) => { const p = mainMap(); if (p?.xf) zoomPanel(p, f, p.xf.w / 2, p.xf.h / 2); },
  world: () => { const p = mainMap(); if (p) flyTo(p, 18, 10, 1, p.focus ? 'GLOBAL SITUATION' : undefined); },
  setPreset,
  newWindow: (p) => ui.newWindow(p),
  saveLayers: () => store.set('layers', st.layers),
  webLinks,
  onSelect: () => ui.updateInfo(),
  share: () => void ui.openShare(true),
});
if (params.get('console') === '1' || preset === 'phone') konsole.toggle(true);
hud = new PhoneHud(document.getElementById('ui')!, {
  client, getMode: () => phoneMode, setMode: setPhoneMode,
  menu: () => { document.querySelector('.toolbar')?.classList.toggle('open'); },
  share: () => void ui.openShare(),
  onResize: () => { if (preset === 'phone') relayout(); },
});
relayout();

// ------------------------------------------------------------------ touch: pan, pinch, tap, long-press
let touch: { p: Panel; x: number; y: number; d: number; moved: boolean; t0: number; timer?: number } | null = null;
const tpos = (t: Touch): [number, number] => [t.clientX * st.dpr, t.clientY * st.dpr];
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const [x, y] = tpos(e.touches[0]);
  const p = panelAt(panels, x, y);
  if (!p || p.kind !== 'map') return;
  const d = e.touches.length > 1 ? Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) : 0;
  if (touch?.timer) clearTimeout(touch.timer);
  touch = { p, x, y, d, moved: e.touches.length > 1, t0: performance.now() };
  if (e.touches.length === 1) {
    const t0 = e.touches[0];
    touch.timer = window.setTimeout(() => {
      if (!touch || touch.moved) return;
      const hit = nearestPick(p, x - p.px!.x, y - p.px!.y, 24 * st.dpr);
      ui.contextMenu(t0.clientX, t0.clientY, hit?.id ?? null, fromXf(p, x - p.px!.x, y - p.px!.y));
      touch = null;
    }, 550);
  }
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!touch) return;
  const p = touch.p;
  if (e.touches.length > 1) {
    const a = e.touches[0], b = e.touches[1];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mx = ((a.clientX + b.clientX) / 2) * st.dpr - p.px!.x, my = ((a.clientY + b.clientY) / 2) * st.dpr - p.px!.y;
    if (touch.d > 0) zoomPanel(p, d / touch.d, mx, my);
    touch.d = d;
    touch.moved = true;
    return;
  }
  const [x, y] = tpos(e.touches[0]);
  if (Math.abs(x - touch.x) + Math.abs(y - touch.y) > 6 * st.dpr) touch.moved = true;
  if (touch.moved) panPanel(p, x - touch.x, y - touch.y);
  touch.x = x;
  touch.y = y;
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (!touch) return;
  if (touch.timer) clearTimeout(touch.timer);
  const t = touch;
  if (e.touches.length > 0) { touch.d = 0; return; }
  touch = null;
  if (t.moved || performance.now() - t.t0 > 500) return;
  const p = t.p;
  const lx = t.x - p.px!.x, ly = t.y - p.px!.y;
  const hit = nearestPick(p, lx, ly, 24 * st.dpr);
  if (ui.targeting) return ui.completeTarget(hit?.id ?? null, fromXf(p, lx, ly));
  st.selected = hit?.id ?? null;
  if (hit) {
    const u = [...(client.snap?.units ?? []), ...(client.snap?.contacts ?? [])].find((q) => q.id === hit.id);
    if (u) client.focus({ lat: u.lat, lon: u.lon, unit: u.id, label: u.name });
  }
  ui.updateInfo();
}, { passive: false });

// ------------------------------------------------------------------ frame loop

let lastFrame = 0;
function frame(now: number) {
  // frame-rate cap (Settings → Graphics): skip this vsync if we drew too recently
  if (settings.fpsCap && now - lastFrame < 1000 / settings.fpsCap - 2) { requestAnimationFrame(frame); return; }
  lastFrame = now;
  const s = client.snap;
  st.snap = s;
  st.world = client.world;
  st.places = geo.places;
  if (s) {
    const dt = s.paused || s.over ? 0 : ((now - snapAt) / 1000) * s.speed;
    st.tNow = s.t + Math.min(dt, s.speed * 0.6);
  }
  buildWorld(ctx.world, st);
  r.beginFrame();
  for (const p of panels) {
    if (maximized && p.id !== maximized && p.kind !== 'strip') continue;
    drawPanel(ctx, p, now);
  }
  r.endFrame(fx);
  requestAnimationFrame(frame);
}

async function boot() {
  relayout();
  await geo.init();
  requestAnimationFrame(frame);
  applySettings();
  const isOnline = await online.detect();
  const link = resolveLink();
  if (link && (isOnline || !parseLink(link)?.online)) await connect(link);
  else if (isOnline) online.showLobby();
  else ui.showConnect('Paste the session link printed in your terminal.');
}
boot();
