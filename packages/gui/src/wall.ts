// Wall layout: panels (maps, status boards, log), presets for single-monitor views, and input handling.
import {
  DEFCON_NAMES, fmtLatLon, describeCommand, type GameEvent, type Side, type Snapshot, type Unit,
} from '@coldlaunch/shared';
import { DynBatch, type Renderer, type GeoBuffer } from './gl.ts';
import { GeoStore, visibleRanges } from './geo.ts';
import { fromScreen, spanDeg, toScreen, xform, type View, type Xform } from './proj.ts';
import { COL, buildPanelLabels, screenText, type Pick, type SceneState } from './scene.ts';
import { textWidth } from './font.ts';

export type PanelKind = 'map' | 'log' | 'strip' | 'missiles' | 'stats';

export interface Panel {
  id: string;
  kind: PanelKind;
  title: string;
  rect: { x: number; y: number; w: number; h: number }; // fractions of the canvas
  px?: { x: number; y: number; w: number; h: number }; // device px (computed)
  view?: View;
  home?: View;
  focus?: boolean; // follows selection / focus events
  tween?: { from: View; to: View; t0: number; dur: number };
  picks?: Pick[];
  xf?: Xform;
}

const V = (lat: number, lon: number, zoom: number, proj: 'equirect' | 'polar' = 'equirect', polarLon0 = -95): View => ({ lat, lon, zoom, proj, polarLon0 });

export const MAP_PRESETS: Record<string, { title: string; view: View }> = {
  world: { title: 'GLOBAL SITUATION', view: V(18, 10, 1) },
  pacific: { title: 'PACIFIC THEATER', view: V(30, -175, 1.6) },
  polar: { title: 'NORTH POLAR — BALLISTIC CORRIDORS', view: V(90, 0, 1.15, 'polar') },
  conus: { title: 'NORAD — CONTINENTAL UNITED STATES', view: V(38.5, -97, 3.4) },
  alaska: { title: 'ALASKAN AIR DEFENSE ZONE', view: V(62, -152, 5) },
  eurasia: { title: 'SOVIET UNION — STRATEGIC FORCES', view: V(55, 78, 2.3) },
  europe: { title: 'EUROPEAN THEATER', view: V(53, 18, 5) },
  atlantic: { title: 'NORTH ATLANTIC — GIUK GAP', view: V(60, -20, 3.2) },
  grandforks: { title: 'GRAND FORKS AIR FORCE BASE', view: V(47.95, -97.4, 45) },
  loring: { title: 'LORING AIR FORCE BASE', view: V(46.95, -67.89, 32) },
};

export const PRESET_NAMES = ['wall', 'world', 'conus', 'europe', 'eurasia', 'alaska', 'pacific', 'atlantic', 'polar', 'missiles', 'stats', 'log', 'phone'];

export type PhoneMode = 'split' | 'map' | 'console';

/** Phone layout: one map under a DOM header, console docked below (portrait) or to the right (landscape). */
export function phoneLayout(aspect: number, mode: PhoneMode, headerFrac: number): Panel[] {
  if (mode === 'console') return [];
  const top = headerFrac + 0.004;
  let rect;
  if (aspect > 1.1) rect = { x: 0.004, y: top, w: mode === 'map' ? 0.992 : 0.56, h: 0.992 - top };
  else rect = { x: 0.01, y: top, w: 0.98, h: mode === 'map' ? 0.99 - top : 0.47 - top };
  return [mapPanel('main', aspect > 1.1 ? 'world' : 'polar', rect, true)];
}

const STRIP_H = 0.055;

function mapPanel(id: string, preset: string, rect: Panel['rect'], focus = false): Panel {
  const p = MAP_PRESETS[preset];
  return { id, kind: 'map', title: p.title, rect, view: { ...p.view }, home: { ...p.view }, focus };
}

/** Build the panel set for a preset at a given aspect ratio. */
export function layoutFor(preset: string, aspect: number): Panel[] {
  const m = 0.006;
  const strip: Panel = { id: 'strip', kind: 'strip', title: '', rect: { x: m, y: 1 - STRIP_H - m, w: 1 - 2 * m, h: STRIP_H } };
  const below = 1 - STRIP_H - 3 * m; // usable height above the strip
  switch (preset) {
    case 'wall': {
      const rows: Panel[] = [];
      const topH = below * 0.5 - m / 2, botY = m + topH + m, botH = below - topH - m;
      const top = aspect > 1.6 ? ['alaska', 'conus', 'polar', 'eurasia'] : aspect > 1.15 ? ['conus', 'polar', 'eurasia'] : ['conus', 'polar'];
      const tw = (1 - m * (top.length + 1)) / top.length;
      top.forEach((name, i) => rows.push(mapPanel(name, name, { x: m + i * (tw + m), y: m, w: tw, h: topH })));
      const bottom: [string, number][] = aspect > 1.6
        ? [['log', 0.17], ['grandforks', 0.2], ['loring', 0.2], ['world', 0.21], ['missiles', 0.22]]
        : aspect > 1.15 ? [['log', 0.25], ['grandforks', 0.25], ['world', 0.25], ['missiles', 0.25]] : [['log', 0.5], ['world', 0.5]];
      const total = bottom.reduce((a, [, w]) => a + w, 0);
      let x = m;
      bottom.forEach(([name, w]) => {
        const ww = (w / total) * (1 - m * (bottom.length + 1));
        const rect = { x, y: botY, w: ww, h: botH };
        if (name === 'log') rows.push({ id: 'log', kind: 'log', title: 'COMMUNICATIONS', rect });
        else if (name === 'missiles') rows.push({ id: 'missiles', kind: 'missiles', title: 'BALLISTIC MISSILE WARNING', rect });
        else rows.push(mapPanel(`inset-${name}`, name, rect, name === 'grandforks'));
        x += ww + m;
      });
      return [...rows, strip];
    }
    case 'missiles': {
      const w1 = aspect > 1.2 ? 0.6 : 1 - 2 * m;
      const panels: Panel[] = [mapPanel('polar', 'polar', { x: m, y: m, w: w1, h: aspect > 1.2 ? below : below * 0.55 })];
      panels.push(aspect > 1.2
        ? { id: 'missiles', kind: 'missiles', title: 'BALLISTIC MISSILE WARNING', rect: { x: 2 * m + w1, y: m, w: 1 - 3 * m - w1, h: below } }
        : { id: 'missiles', kind: 'missiles', title: 'BALLISTIC MISSILE WARNING', rect: { x: m, y: 2 * m + below * 0.55, w: 1 - 2 * m, h: below * 0.45 - m } });
      return [...panels, strip];
    }
    case 'stats': {
      const w1 = aspect > 1.2 ? 0.62 : 1 - 2 * m;
      return [
        { id: 'stats', kind: 'stats', title: 'FORCE STATUS & DAMAGE ASSESSMENT', rect: { x: m, y: m, w: w1, h: aspect > 1.2 ? below : below * 0.6 } },
        aspect > 1.2
          ? { id: 'log', kind: 'log', title: 'COMMUNICATIONS', rect: { x: 2 * m + w1, y: m, w: 1 - 3 * m - w1, h: below } }
          : { id: 'log', kind: 'log', title: 'COMMUNICATIONS', rect: { x: m, y: 2 * m + below * 0.6, w: 1 - 2 * m, h: below * 0.4 - m } },
        strip,
      ];
    }
    case 'log':
      return [{ id: 'log', kind: 'log', title: 'COMMUNICATIONS', rect: { x: m, y: m, w: 1 - 2 * m, h: below } }, strip];
    default: {
      const name = MAP_PRESETS[preset] ? preset : 'world';
      return [mapPanel('main', name, { x: m, y: m, w: 1 - 2 * m, h: below }, true), strip];
    }
  }
}

// ======================================================================== rendering

export interface WallCtx {
  r: Renderer;
  geo: GeoStore;
  grids: { g30: GeoBuffer; g10: GeoBuffer; g5: GeoBuffer; g1: GeoBuffer };
  st: SceneState;
  world: DynBatch;
  events: GameEvent[];
  scratch: DynBatch;
  connected: boolean;
}

const GEO_ORDER: [string, keyof typeof COL, number, number][] = [
  // layer, colour, width multiplier, min LOD
  ['admin1', 'admin1', 0.9, 1], ['roads', 'roads', 0.9, 2], ['rivers', 'rivers', 0.9, 1], ['lakes', 'lakes', 1, 2],
  ['urban', 'urban', 1, 2], ['states', 'states', 1, 1], ['borders', 'border', 1.1, 0], ['coast', 'coast', 1.35, 0],
];

export function drawPanel(ctx: WallCtx, p: Panel, now: number) {
  const { r, st } = ctx;
  const { x, y, w, h } = p.px!;
  r.panel(x, y, w, h);
  const dpr = st.dpr;
  const hud = ctx.scratch;
  if (p.kind === 'map' && p.view) {
    if (p.tween) {
      const k = Math.min(1, (now - p.tween.t0) / p.tween.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const a = p.tween.from, b = p.tween.to;
      let dl = b.lon - a.lon;
      if (dl > 180) dl -= 360;
      if (dl < -180) dl += 360;
      p.view = { ...b, lat: a.lat + (b.lat - a.lat) * e, lon: a.lon + dl * e, zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * e) };
      if (k >= 1) p.tween = undefined;
    }
    const xf = xform(p.view, w, h);
    p.xf = xf;
    const span = spanDeg(xf);
    const want: 0 | 1 | 2 = span > 140 ? 0 : span > 28 ? 1 : 2;
    const lod = ctx.geo.get(want);
    const L = st.layers as Record<string, boolean>;
    if (L.grid) {
      const g = span > 220 ? ctx.grids.g30 : span > 70 ? ctx.grids.g10 : span > 14 ? ctx.grids.g5 : ctx.grids.g1;
      r.drawGeo(g, visibleRanges(g, xf), xf, COL.grid, 1 * dpr);
    }
    if (lod) {
      for (const [name, col, wm, minLod] of GEO_ORDER) {
        if (!L[name] || want < minLod || !lod[name]) continue;
        const buf = lod[name];
        r.drawGeo(buf, visibleRanges(buf, xf), xf, COL[col], 1.2 * dpr * wm);
      }
    }
    const lift = 0.45 * (xf.ky / 111);
    r.drawDyn(ctx.world, xf, lift);
    p.picks = buildPanelLabels(hud, st, xf, p.focus ? p.title : null);
    r.drawDyn(hud, xf, lift);
    // frame + title
    hud.reset();
    frame(hud, w, h, dpr);
    const ts = Math.max(8, Math.min(16, w / 70)) * dpr / Math.max(1, dpr * 0.75);
    if (p.focus) screenText(hud, w / 2, ts * 1.6, p.title, ts * 1.25, COL.reticle, 1.4 * dpr, 0.5);
    else screenText(hud, 12 * dpr, h - ts * 1.3, p.title, ts, [0.85, 0.92, 1, 1], 1.3 * dpr);
    const scale = `${span >= 10 ? Math.round(span) : span.toFixed(1)}°  ${fmtLatLon(p.view)}`;
    screenText(hud, w - 10 * dpr, 10 * dpr, scale, 5 * dpr, COL.dim, 1 * dpr, 1);
    r.drawDyn(hud, xf);
    return;
  }
  hud.reset();
  const xf: Xform = { kind: 0, lon0: 0, cx: 0, cy: 0, kx: 1, ky: 1, w, h };
  p.xf = xf;
  if (p.kind === 'strip') drawStrip(hud, st, w, h, dpr, ctx.connected);
  else {
    frame(hud, w, h, dpr);
    if (p.kind === 'log') drawLog(hud, ctx.events, st, p.title, w, h, dpr);
    if (p.kind === 'missiles') drawMissileBoard(hud, st, p.title, w, h, dpr);
    if (p.kind === 'stats') drawStats(hud, st, p.title, w, h, dpr);
  }
  r.drawDyn(hud, xf);
}

function frame(b: DynBatch, w: number, h: number, dpr: number) {
  const c = [0.75, 0.85, 1, 0.85], lw = 2 * dpr, i = 1.5 * dpr;
  b.px(i, i, w - i, i, c, lw);
  b.px(w - i, i, w - i, h - i, c, lw);
  b.px(w - i, h - i, i, h - i, c, lw);
  b.px(i, h - i, i, i, c, lw);
}

const clock = (s: Snapshot | undefined, t: number) => new Date((s?.startEpoch ?? Date.UTC(1983, 10, 8, 21)) + t * 1000).toISOString().slice(11, 19);

const EV_COL: Record<string, number[]> = {
  info: COL.label, warn: COL.yellow, alert: COL.red, launch: COL.red, detect: COL.yellow, impact: COL.white, intercept: [0.4, 0.95, 1, 1],
  destroyed: [1, 0.6, 0.25, 1], defcon: COL.reticle, hotline: COL.green, ai: [0.75, 0.55, 1, 1], end: COL.white,
};

function wrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if ((line + ' ' + word).trim().length > maxChars) { if (line) out.push(line); line = word; }
    else line = (line + ' ' + word).trim();
  }
  if (line) out.push(line);
  return out;
}

function drawLog(b: DynBatch, events: GameEvent[], st: SceneState, title: string, w: number, h: number, dpr: number) {
  const size = Math.max(5 * dpr, Math.min(8 * dpr, w / 70));
  const lh = size * 1.75;
  screenText(b, 10 * dpr, 10 * dpr + size, title, size * 1.1, [0.85, 0.92, 1, 1], 1.3 * dpr);
  const maxChars = Math.floor((w - 20 * dpr) / (size));
  const lines: [string, number[]][] = [];
  for (const e of events.slice(-80)) {
    const ls = wrap(`${clock(st.snap, e.t)} ${e.text}`, maxChars);
    ls.forEach((l, i) => lines.push([i ? '         ' + l : l, EV_COL[e.kind] ?? COL.label]));
  }
  const maxLines = Math.floor((h - 30 * dpr - size * 2) / lh);
  const shown = lines.slice(-maxLines);
  let y = 20 * dpr + size * 2.5;
  for (const [l, c] of shown) {
    screenText(b, 10 * dpr, y, l, size, c, 1.1 * dpr);
    y += lh;
  }
}

function drawMissileBoard(b: DynBatch, st: SceneState, title: string, w: number, h: number, dpr: number) {
  const s = st.snap;
  const size = Math.max(5 * dpr, Math.min(8 * dpr, w / 62));
  let y = 10 * dpr + size;
  screenText(b, 10 * dpr, y, title, size * 1.1, COL.red, 1.4 * dpr);
  y += size * 2.6;
  if (!s) return;
  const ms = s.missiles.filter((m) => m.type !== 'ABM');
  const viewer = st.role;
  const inbound = ms.filter((m) => viewer === 'SPECTATOR' || m.side !== viewer);
  const outbound = ms.filter((m) => viewer !== 'SPECTATOR' && m.side === viewer);
  const counters: [string, number][] = [['INBOUND', inbound.length], ['CONFIRMED', inbound.filter((m) => m.confirmed).length], ['OUTBOUND', outbound.length], ['IMPACTS', s.threat.impacts]];
  const cw = (w - 20 * dpr) / counters.length;
  counters.forEach(([label, v], i) => {
    screenText(b, 10 * dpr + i * cw, y, label, size * 0.8, COL.dim, 1 * dpr);
    screenText(b, 10 * dpr + i * cw, y + size * 2.2, String(v).padStart(3, '0'), size * 2, v ? COL.red : [0.4, 0.1, 0.08, 1], 1.8 * dpr, 0, true);
  });
  y += size * 5.2;
  const rowH = size * 1.8;
  const cols = Math.floor((w - 20 * dpr) / size);
  screenText(b, 10 * dpr, y, 'TRK   TYPE SIDE  TARGET'.padEnd(Math.max(0, cols - 10)) + 'ETA', size * 0.85, COL.dim, 1 * dpr);
  y += rowH;
  const rows = [...inbound, ...outbound].sort((a, c) => a.impactT - c.impactT);
  const maxRows = Math.floor((h - y - 10 * dpr) / rowH);
  for (const m of rows.slice(0, maxRows)) {
    const eta = Math.max(0, m.impactT - st.tNow);
    const etaS = `${String(Math.floor(eta / 60)).padStart(2, '0')}:${String(Math.floor(eta % 60)).padStart(2, '0')}`;
    const mine = m.side === viewer;
    const head = `${m.id.toUpperCase().padEnd(6)}${m.type.padEnd(5)}${m.side.padEnd(6)}`;
    const tgt = m.target.slice(0, Math.max(6, cols - head.length - 8));
    const line = `${head}${tgt}`.padEnd(Math.max(0, cols - 7)) + etaS;
    const col = mine ? COL.mUSA : m.confirmed === false ? COL.yellow : COL.red;
    screenText(b, 10 * dpr, y, line, size * 0.85, col, 1.1 * dpr);
    y += rowH;
  }
  if (!rows.length) screenText(b, 10 * dpr, y, 'NO BALLISTIC TRACKS', size, [0.3, 0.6, 0.4, 1], 1.1 * dpr);
}

function bar(b: DynBatch, x: number, y: number, w: number, h: number, frac: number, col: number[], dpr: number) {
  b.px(x, y, x + w, y, dimC(col, 0.5), 1 * dpr);
  b.px(x, y + h, x + w, y + h, dimC(col, 0.5), 1 * dpr);
  const n = Math.max(0, Math.round((w * Math.max(0, Math.min(1, frac))) / (3 * dpr)));
  for (let i = 0; i < n; i++) b.px(x + i * 3 * dpr + dpr, y + 2 * dpr, x + i * 3 * dpr + dpr, y + h - 2 * dpr, col, 1.4 * dpr);
}
const dimC = (c: number[], f: number) => [c[0], c[1], c[2], (c[3] ?? 1) * f];

function drawStats(b: DynBatch, st: SceneState, title: string, w: number, h: number, dpr: number) {
  const s = st.snap;
  const size = Math.max(6 * dpr, Math.min(10 * dpr, w / 70));
  let y = 12 * dpr + size;
  screenText(b, 12 * dpr, y, title, size * 1.15, [0.85, 0.92, 1, 1], 1.4 * dpr);
  if (!s) return;
  y += size * 3;
  const sides: Side[] = ['USA', 'USSR'];
  const colW = (w - 36 * dpr) / 2;
  sides.forEach((side, i) => {
    const x0 = 12 * dpr + i * (colW + 12 * dpr);
    let yy = y;
    const col = side === 'USA' ? COL.usa : COL.ussr;
    const sc = s.score[side];
    const lvl = s.defcon[side];
    const est = st.role !== 'SPECTATOR' && side !== st.role;
    screenText(b, x0, yy, side + (est ? ' (INTEL ESTIMATE)' : ''), size * 1.2, col, 1.5 * dpr);
    yy += size * 2.4;
    screenText(b, x0, yy, `DEFCON ${lvl}  ${DEFCON_NAMES[lvl]}`, size, lvl <= 2 ? COL.red : lvl === 3 ? COL.yellow : COL.green, 1.3 * dpr);
    yy += size * 2.2;
    const rows: [string, string, number, number[]][] = [
      ['POPULATION LOSS', `${(sc.killed / 1000).toFixed(2)}M`, sc.killed / sc.popStart, COL.red],
      ['STRATEGIC FORCES', `${Math.max(0, sc.forcesStart - sc.forcesLost)} / ${sc.forcesStart} RV`, Math.max(0, sc.forcesStart - sc.forcesLost) / Math.max(1, sc.forcesStart), col],
      ['WARHEADS LAUNCHED', String(sc.warheadsLaunched), sc.warheadsLaunched / Math.max(1, sc.forcesStart), COL.yellow],
    ];
    for (const [label, val, frac, c] of rows) {
      screenText(b, x0, yy, label, size * 0.8, COL.dim, 1 * dpr);
      screenText(b, x0 + colW - 4 * dpr, yy, val, size * 0.9, c, 1.2 * dpr, 1);
      yy += size * 1.4;
      bar(b, x0, yy, colW - 4 * dpr, size * 1.1, frac, c, dpr);
      yy += size * 2.4;
    }
    // branch breakdown (own side exact, enemy from contacts)
    const own = st.role === 'SPECTATOR' || st.role === side;
    if (own) {
      const units = s.units.filter((u) => u.side === side && u.status !== 'destroyed');
      const sum = (k: Unit['kind'], f: (u: Unit) => number) => units.filter((u) => u.kind === k).reduce((a, u) => a + f(u), 0);
      const lines: [string, string][] = [
        ['ROCKET FORCES', `${sum('silo', (u) => u.missiles ?? 0)} ICBM / ${sum('silo', (u) => (u.missiles ?? 0) * (u.warheads ?? 1))} RV`],
        ['NAVY', `${units.filter((u) => u.kind === 'ssbn').length} SSBN · ${units.filter((u) => u.kind === 'ssn').length} SSN · ${units.filter((u) => u.kind === 'carrier').length} GROUPS`],
        ['SLBM', `${sum('ssbn', (u) => u.missiles ?? 0)} MSL / ${sum('ssbn', (u) => (u.missiles ?? 0) * (u.warheads ?? 1))} RV`],
        ['AIR FORCE', `${sum('airbase', (u) => u.aircraft ?? 0)} BMR GND · ${sum('bomber', (u) => u.aircraft ?? 0)} AIR · ${sum('afb_int', (u) => u.interceptors ?? 0)} INT`],
        ['GROUND C2 / RADAR', `${units.filter((u) => u.kind === 'command').length} CP · ${units.filter((u) => u.kind === 'radar').length} RADAR`],
      ];
      for (const [k, v] of lines) {
        screenText(b, x0, yy, k, size * 0.8, COL.dim, 1 * dpr);
        screenText(b, x0 + colW - 4 * dpr, yy, v, size * 0.8, col, 1.1 * dpr, 1);
        yy += size * 1.8;
      }
    } else {
      const known = s.contacts.filter((c) => c.status !== 'destroyed');
      const cnt = (k: string) => known.filter((c) => c.kind === k).length;
      const lines: [string, string][] = [
        ['KNOWN ICBM FIELDS', String(cnt('silo'))], ['BOMBER CONTACTS', String(cnt('bomber'))],
        ['NAVAL CONTACTS', `${cnt('carrier')} SURFACE · ${cnt('ssbn') + cnt('ssn')} SUB`], ['DESTROYED TARGETS', String(s.contacts.filter((c) => c.status === 'destroyed').length)],
      ];
      for (const [k, v] of lines) {
        screenText(b, x0, yy, k, size * 0.8, COL.dim, 1 * dpr);
        screenText(b, x0 + colW - 4 * dpr, yy, v, size * 0.8, col, 1.1 * dpr, 1);
        yy += size * 1.8;
      }
    }
    const ai = s.ai[side];
    if (ai) {
      yy += size;
      screenText(b, x0, yy, `AI ${ai.provider.toUpperCase()}:${ai.model.toUpperCase()}`, size * 0.8, [0.75, 0.55, 1, 1], 1.1 * dpr);
      yy += size * 1.6;
      screenText(b, x0, yy, `${ai.thinking ? 'THINKING' : 'IDLE'} · ${ai.calls} CALLS · $${ai.costUsd.toFixed(3)}`, size * 0.75, ai.lastError ? COL.red : COL.dim, 1 * dpr);
    }
  });
  if (s.over) screenText(b, w / 2, h - 20 * dpr, `SIMULATION COMPLETE — ${s.over.reason}`, size * 1.1, COL.white, 1.6 * dpr, 0.5);
}

function drawStrip(b: DynBatch, st: SceneState, w: number, h: number, dpr: number, connected: boolean) {
  const s = st.snap;
  // shrink to fit narrow windows (approx. 150 character cells across the strip)
  const fit = Math.min(1, w / (190 * 6 * dpr * 0.9));
  const lbl = Math.max(3.5 * dpr, h * 0.16 * fit), dig = Math.max(5 * dpr, h * 0.36 * fit);
  const yL = h * 0.25, yD = h * 0.68;
  let x = 8 * dpr;
  const item = (label: string, value: string, col: number[], seven = true, minW = 0) => {
    const ww = Math.max(textWidth(label, lbl), textWidth(value, dig), minW) + 14 * dpr * fit;
    screenText(b, x, yL, label, lbl, [0.6, 0.78, 1, 0.9], 1 * dpr);
    screenText(b, x, yD, value, dig, col, 1.6 * dpr, 0, seven);
    x += ww;
  };
  if (!s) {
    screenText(b, 10 * dpr, h / 2, connected ? 'SYNCHRONIZING…' : 'NO CARRIER — WAITING FOR GAME LINK', lbl * 1.6, COL.yellow, 1.3 * dpr);
    return;
  }
  const role = st.role;
  // DEFCON lamps: five hatched blocks, the current level lit
  const lampCols: Record<number, number[]> = { 5: [0.3, 0.9, 1, 1], 4: [0.3, 1, 0.5, 1], 3: [1, 0.85, 0.2, 1], 2: [1, 0.5, 0.15, 1], 1: [1, 0.15, 0.1, 1] };
  const sides: Side[] = role === 'USSR' ? ['USSR', 'USA'] : ['USA', 'USSR'];
  for (const side of sides) {
    screenText(b, x, yL, `${side} DEFCON${role !== 'SPECTATOR' && side !== role ? ' EST' : ''}`, lbl, side === 'USA' ? COL.usa : COL.ussr, 1 * dpr);
    const lw = 10 * dpr * fit, lh = h * 0.32;
    for (let lvl = 5; lvl >= 1; lvl--) {
      const lx = x + (5 - lvl) * (lw + 3 * dpr);
      const on = s.defcon[side] === lvl;
      const c = on ? [...lampCols[lvl].slice(0, 3), 1.6] : dimC(lampCols[lvl], 0.18);
      for (let k = 0; k < 4; k++) b.px(lx + k * 2.6 * dpr, h * 0.5, lx + k * 2.6 * dpr, h * 0.5 + lh, c, 1.6 * dpr);
    }
    x = Math.max(x + 5 * (lw + 3 * dpr) + 10 * dpr, x + textWidth(`${side} DEFCON EST`, lbl) + 10 * dpr);
  }
  const date = new Date(s.startEpoch + st.tNow * 1000);
  item('WAR CLOCK Z', date.toISOString().slice(11, 19).replace(/:/g, ' '), COL.red);
  item('TENSION', String(s.tension).padStart(3, '0'), s.tension > 70 ? COL.red : [1, 0.6, 0.2, 1]);
  item('INBOUND', String(s.threat.inbound).padStart(3, '0'), s.threat.inbound ? COL.red : [0.45, 0.1, 0.08, 1]);
  item('DETONATIONS', String(s.threat.impacts).padStart(4, '0'), COL.red);
  item('BMR CONTACTS', String(s.threat.bombers).padStart(2, '0'), COL.red);
  item('SUB CONTACTS', String(s.threat.subs).padStart(2, '0'), COL.red);
  const kill = (side: Side) => String(Math.round(s.score[side].killed)).padStart(6, '0');
  item('USA CASUALTIES K', kill('USA'), COL.red);
  item('USSR CASUALTIES K', kill('USSR'), COL.red);
  item('TIME RATE', s.paused ? '--' : String(s.speed).padStart(2, ' '), s.paused ? COL.yellow : [1, 0.6, 0.2, 1]);
  if (s.over && x < w - 200 * dpr) screenText(b, x, h / 2, s.over.reason, lbl * 1.4, COL.white, 1.4 * dpr);
  if (st.plan) screenText(b, w - 8 * dpr, yL, `ADVISOR PLAN: ${st.plan.cmds.map(describeCommand).join(' · ')}`.slice(0, 120), lbl, COL.plan, 1 * dpr, 1);
}

// ======================================================================== geometry helpers

export function panelAt(panels: Panel[], x: number, y: number): Panel | undefined {
  return panels.find((p) => p.px && x >= p.px.x && x < p.px.x + p.px.w && y >= p.px.y && y < p.px.y + p.px.h);
}

export function zoomPanel(p: Panel, f: number, sx: number, sy: number) {
  if (!p.view || !p.xf) return;
  const before = fromScreen(p.xf, sx, sy);
  p.view = { ...p.view, zoom: Math.max(0.7, Math.min(600, p.view.zoom * f)) };
  p.xf = xform(p.view, p.xf.w, p.xf.h);
  const moved = toScreen(p.xf, before.lat, before.lon);
  if (moved) panPanel(p, sx - moved[0], sy - moved[1]);
  p.tween = undefined;
}

export function panPanel(p: Panel, dx: number, dy: number) {
  if (!p.view || !p.xf) return;
  const c = fromScreen(p.xf, p.xf.w / 2 - dx, p.xf.h / 2 - dy);
  p.view = { ...p.view, lat: Math.max(-85, Math.min(89.9, c.lat)), lon: c.lon };
  p.tween = undefined;
}

/** Animation settings (Settings → reduce motion sets flyMs to ~0). */
export const MOTION = { flyMs: 900 };

export function flyTo(p: Panel, lat: number, lon: number, zoom?: number, title?: string) {
  if (!p.view) return;
  const to: View = { ...p.view, lat, lon, zoom: zoom ?? p.view.zoom };
  if (p.view.proj === 'polar' && lat < 20) to.proj = 'polar';
  p.tween = { from: { ...p.view }, to, t0: performance.now(), dur: Math.max(1, MOTION.flyMs) };
  if (title) p.title = title;
}

export function nearestPick(p: Panel, sx: number, sy: number, maxPx: number): Pick | null {
  let best: Pick | null = null, bd = maxPx * maxPx;
  for (const k of p.picks ?? []) {
    const d = (k.x - sx) ** 2 + (k.y - sy) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}
