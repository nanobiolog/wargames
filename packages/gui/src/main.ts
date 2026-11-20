import { GameClient, makeLink, parseLink, type Focus, type GameEvent, type LatLon, type PlanProposal, type Role, type Snapshot } from '@coldlaunch/shared';
import { Renderer, DynBatch, type FxSettings } from './gl.ts';
import { GeoStore, bucketize } from './geo.ts';
import { buildWorld, LAYER_LIST, type LayerKey, type SceneState } from './scene.ts';
import { drawPanel, layoutFor, panelAt, zoomPanel, panPanel, flyTo, nearestPick, PRESET_NAMES, type Panel, type WallCtx } from './wall.ts';
import { Ui } from './ui.ts';

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
let preset = params.get('preset') ?? store.get('preset', 'wall');
if (!PRESET_NAMES.includes(preset)) preset = 'wall';
let panels: Panel[] = [];
let maximized: string | null = null;
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
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  st.dpr = dpr;
  const W = Math.floor(window.innerWidth * dpr), H = Math.floor(window.innerHeight * dpr);
  r.resize(W, H);
  const keep = new Map(panels.map((p) => [p.id, p]));
  panels = layoutFor(preset, W / H).map((p) => {
    const old = keep.get(p.id);
    return old ? { ...p, view: old.view, title: old.focus ? old.title : p.title } : p;
  });
  for (const p of panels) {
    const rect = maximized === p.id && p.kind !== 'strip' ? { x: 0.006, y: 0.006, w: 0.988, h: 1 - 0.055 - 0.024 } : p.rect;
    p.px = { x: Math.round(rect.x * W), y: Math.round(rect.y * H), w: Math.round(rect.w * W), h: Math.round(rect.h * H) };
  }
}

function setPreset(name: string) {
  preset = name;
  maximized = null;
  panels = [];
  store.set('preset', name);
  relayout();
  ui.refresh();
}

// ------------------------------------------------------------------ connection

function resolveLink(): string | null {
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
    await client.connect(link, (params.get('role') as Role) ?? undefined);
    store.set('link', link);
    (window as any).wallHost?.setLink(link);
    ctx.connected = true;
    ui.hideConnect();
  } catch (e) {
    ui.showConnect(`${(e as Error).message}`);
  }
}

client.on('welcome', () => {
  st.role = (client.role ?? 'USA') as SceneState['role'];
  events.length = 0;
  st.trails.clear();
  ui.refresh();
});
client.on('snap', (s: Snapshot) => {
  snapAt = performance.now();
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
  for (const e of evs) ui.onEvent(e);
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
});

// ------------------------------------------------------------------ frame loop

function frame(now: number) {
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
  const link = resolveLink();
  if (link) await connect(link);
  else ui.showConnect('Paste the session link printed in your terminal.');
}
boot();
