// Builds the dynamic vector content (units, missiles, blasts, labels) for each frame.
import {
  ballisticPos, geoCircle, gcPath, softKillKm, distKm, type Contact, type Missile, type Snapshot, type StaticWorld,
  type Unit, type Side, type PlanProposal, type LatLon,
} from '@coldlaunch/shared';
import { DynBatch } from './gl.ts';
import { textSegments, textWidth } from './font.ts';
import { toScreen, spanDeg, type Xform } from './proj.ts';

export const COL = {
  coast: [0.25, 0.62, 1.0, 0.75], border: [0.2, 0.85, 0.45, 0.5], states: [0.2, 0.42, 0.9, 0.4], admin1: [0.16, 0.3, 0.75, 0.22],
  rivers: [0.2, 0.5, 0.95, 0.35], lakes: [0.22, 0.55, 1.0, 0.45], roads: [0.95, 0.6, 0.22, 0.28], urban: [1.0, 0.6, 0.2, 0.6],
  grid: [0.1, 0.22, 0.45, 0.22], usa: [0.55, 0.85, 1.0, 1.0], ussr: [1.0, 0.32, 0.28, 1.0], unknown: [1.0, 0.85, 0.25, 1.0],
  reticle: [1.0, 0.35, 0.85, 1.1], city: [1.0, 0.62, 0.25, 0.95], label: [0.62, 0.86, 1.0, 0.85], frame: [0.7, 0.82, 1.0, 0.9],
  red: [1.0, 0.18, 0.12, 1.3], white: [1, 1, 1, 1.2], dim: [0.4, 0.55, 0.75, 0.6], yellow: [1.0, 0.85, 0.2, 1.0], green: [0.35, 1.0, 0.5, 1.0],
  mUSA: [0.7, 0.95, 1.0, 1.0], mUSSR: [1.0, 0.45, 0.38, 1.0], plan: [1.0, 0.9, 0.3, 0.9],
};

export type LayerKey =
  | 'coast' | 'borders' | 'states' | 'admin1' | 'rivers' | 'lakes' | 'roads' | 'urban' | 'grid' | 'cities' | 'places'
  | 'units' | 'contacts' | 'missiles' | 'predicted' | 'tracks' | 'blasts' | 'radar' | 'airdef' | 'routes' | 'labels'
  | 'navy' | 'air' | 'rocket' | 'ground';

/** Service-branch filters: which unit kinds each branch layer controls. */
export const BRANCH_KINDS: Record<'navy' | 'air' | 'rocket' | 'ground', string[]> = {
  navy: ['carrier', 'ssbn', 'ssn', 'navalbase'],
  air: ['airbase', 'afb_int', 'bomber', 'flight', 'satellite'],
  rocket: ['silo', 'abm'],
  ground: ['command', 'radar'],
};
export function branchVisible(L: Record<string, boolean>, kind: string) {
  for (const [b, kinds] of Object.entries(BRANCH_KINDS)) if (kinds.includes(kind)) return L[b] !== false;
  return true;
}

export const LAYER_LIST: [LayerKey, string][] = [
  ['coast', 'Coastlines'], ['borders', 'Borders'], ['states', 'US states'], ['admin1', 'Provinces / oblasts'], ['rivers', 'Rivers'],
  ['lakes', 'Lakes'], ['roads', 'Roads'], ['urban', 'Urban areas'], ['grid', 'Graticule'], ['cities', 'Cities'], ['places', 'Towns'],
  ['units', 'Own forces'], ['contacts', 'Enemy contacts'], ['missiles', 'Missiles'], ['predicted', 'Predicted impacts'],
  ['tracks', 'Unit tracks'], ['blasts', 'Detonations'], ['radar', 'Radar coverage'], ['airdef', 'Air-defence rings'],
  ['routes', 'Routes / orders'], ['labels', 'Labels'],
  ['navy', '▸ Navy (fleets, subs, ports)'], ['air', '▸ Air force (bombers, interceptors)'],
  ['rocket', '▸ Strategic rocket forces (ICBM, ABM)'], ['ground', '▸ Ground C2 & radars'],
];

export interface SceneState {
  snap?: Snapshot;
  world?: StaticWorld;
  role: Side | 'SPECTATOR';
  tNow: number;
  selected: string | null;
  hover: string | null;
  plan: PlanProposal | null;
  layers: Record<LayerKey, boolean>;
  dpr: number;
  trails: Map<string, LatLon[]>;
  places: [string, number, number, number, string][];
}

type Pt = [number, number];
const circle = (r: number, cx = 0, cy = 0, n = 14): Pt[] => Array.from({ length: n + 1 }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, cy + Math.sin((i / n) * Math.PI * 2) * r] as Pt);
const star = (r: number, ri: number): Pt[] => Array.from({ length: 11 }, (_, i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? ri : r;
  return [Math.cos(a) * rr, Math.sin(a) * rr] as Pt;
});

/** Vector unit symbols (y down, ~[-2,2] units, scaled by `size`). Ships/subs face +x (bow right). */
const ICONS: Record<string, Pt[][]> = {
  // ICBM field: missile standing inside a launch-area triangle
  silo: [
    [[-1.2, 1], [0, -1.2], [1.2, 1], [-1.2, 1]],
    [[0, 0.75], [0, -0.35]], [[-0.18, -0.15], [0, -0.55], [0.18, -0.15]], [[-0.28, 0.75], [0, 0.45], [0.28, 0.75]],
  ],
  // bomber base: runway with a swept-wing bomber parked above it
  airbase: [
    [[-1.4, 0.8], [1.4, 0.8]], [[-1.4, 1.1], [1.4, 1.1]], [[-0.9, 0.95], [-0.5, 0.95]], [[0.5, 0.95], [0.9, 0.95]],
    [[0, -1.2], [0, 0.4]], [[-1.2, 0.05], [0, -0.5], [1.2, 0.05]], [[-0.45, 0.4], [0, 0.18], [0.45, 0.4]],
  ],
  // interceptor base: delta-wing fighter
  afb_int: [
    [[0, -1.3], [0.35, -0.2], [1, 0.75], [0.3, 0.55], [0, 1], [-0.3, 0.55], [-1, 0.75], [-0.35, -0.2], [0, -1.3]],
    [[0, -0.6], [0, 0.4]],
  ],
  // airborne bomber group (rotated to heading; nose = +x)
  // reconnaissance satellite: body with two solar panels
  satellite: [
    [[-0.35, -0.35], [0.35, -0.35], [0.35, 0.35], [-0.35, 0.35], [-0.35, -0.35]],
    [[-1.5, -0.25], [-0.55, -0.25], [-0.55, 0.25], [-1.5, 0.25], [-1.5, -0.25]], [[-0.55, 0], [-0.35, 0]],
    [[0.55, -0.25], [1.5, -0.25], [1.5, 0.25], [0.55, 0.25], [0.55, -0.25]], [[0.35, 0], [0.55, 0]],
  ],
  // air flight: a pair of small swept-wing jets (drawn pointing east, rotated to heading)
  flight: [
    [[-0.9, -0.55], [0.2, -0.55]], [[-0.35, -1.0], [0.0, -0.55], [-0.35, -0.1]], [[-0.85, -0.75], [-0.85, -0.35]],
    [[-0.5, 0.55], [0.6, 0.55]], [[0.05, 0.1], [0.4, 0.55], [0.05, 1.0]], [[-0.45, 0.35], [-0.45, 0.75]],
  ],
  bomber: [
    [[-1.3, 0], [1.4, 0]], [[1.4, 0], [1.6, 0]],
    [[0.35, -0.08], [-0.55, -1.4], [-0.85, -1.4], [-0.25, -0.08]], [[0.35, 0.08], [-0.55, 1.4], [-0.85, 1.4], [-0.25, 0.08]],
    [[-0.6, -0.75], [-0.35, -0.75]], [[-0.6, 0.75], [-0.35, 0.75]],
    [[-1.05, 0], [-1.45, -0.55]], [[-1.05, 0], [-1.45, 0.55]],
  ],
  // early-warning radar: dish on a mast
  radar: [
    [[-1.1, -1], [-0.7, -0.3], [0, 0], [0.7, -0.3], [1.1, -1]], [[0, 0], [0, -1]], [[-0.18, -1], [0.18, -1]],
    [[0, 0], [0, 1]], [[-0.8, 1], [0.8, 1]], [[-0.45, 1], [0, 0.45], [0.45, 1]],
  ],
  // ABM site: shield arc over an interceptor missile
  abm: [
    [[-1.2, 0.3], [-1, -0.6], [0, -1.25], [1, -0.6], [1.2, 0.3]],
    [[0, 1], [0, -0.55]], [[-0.18, -0.35], [0, -0.75], [0.18, -0.35]], [[-0.3, 1], [0, 0.7], [0.3, 1]],
  ],
  // national command post / hardened bunker
  command: [circle(1.25), star(0.95, 0.4)],
  // naval base: anchor
  navalbase: [
    circle(0.25, 0, -1.05, 8), [[0, -0.8], [0, 1]], [[-0.65, -0.45], [0.65, -0.45]],
    [[-1.1, 0.25], [-0.85, 0.7], [-0.4, 0.98], [0, 1], [0.4, 0.98], [0.85, 0.7], [1.1, 0.25]],
    [[-1.1, 0.25], [-1.25, 0.55]], [[-1.1, 0.25], [-0.8, 0.35]], [[1.1, 0.25], [1.25, 0.55]], [[1.1, 0.25], [0.8, 0.35]],
  ],
  // carrier battle group (top view): angled flight deck, island, two escorts
  carrier: [
    [[-1.7, -0.4], [1.3, -0.4], [1.8, 0], [1.3, 0.45], [-1.7, 0.45], [-1.7, -0.4]],
    [[-1.4, 0.3], [0.5, -0.4]], [[-1.2, 0], [1.4, 0]],
    [[0.25, 0.45], [0.25, 0.8], [0.75, 0.8], [0.75, 0.45]],
    [[2.4, -0.95], [2.65, -0.75], [2.4, -0.55], [2.15, -0.75], [2.4, -0.95]],
    [[-2.3, 0.85], [-2.05, 1.05], [-2.3, 1.25], [-2.55, 1.05], [-2.3, 0.85]],
  ],
  // ballistic-missile submarine (side view): long hull, sail, raised missile deck, rudder
  ssbn: [
    [[-1.8, 0.1], [-1.5, -0.25], [1.35, -0.25], [1.9, 0.05], [1.35, 0.38], [-1.5, 0.38], [-1.8, 0.1]],
    [[0.55, -0.25], [0.65, -0.8], [1.05, -0.8], [1.1, -0.25]], [[0.55, -0.6], [1.25, -0.6]],
    [[-1.1, -0.25], [-1.1, -0.48], [0.25, -0.48], [0.25, -0.25]], [[-0.65, -0.48], [-0.65, -0.25]], [[-0.2, -0.48], [-0.2, -0.25]],
    [[-1.8, 0.1], [-2.1, -0.35]], [[-1.8, 0.1], [-2.1, 0.55]],
  ],
  // attack submarine (side view): shorter hull, sail
  ssn: [
    [[-1.35, 0.1], [-1.05, -0.22], [0.95, -0.22], [1.45, 0.05], [0.95, 0.33], [-1.05, 0.33], [-1.35, 0.1]],
    [[0.3, -0.22], [0.4, -0.7], [0.75, -0.7], [0.8, -0.22]], [[0.3, -0.5], [0.95, -0.5]],
    [[-1.35, 0.1], [-1.6, -0.28]], [[-1.35, 0.1], [-1.6, 0.48]],
  ],
  // unidentified contact: diamond with a question mark
  unknown: [
    [[0, -1.2], [1.2, 0], [0, 1.2], [-1.2, 0], [0, -1.2]],
    [[-0.3, -0.35], [0, -0.6], [0.3, -0.4], [0, -0.05], [0, 0.2]], [[0, 0.45], [0, 0.55]],
  ],
  city: [circle(0.9, 0, 0, 10)],
};

/** Faction colours from the scenario (classic: USA blue, USSR red). Set on every welcome. */
const FACTION_COL = new Map<Side, number[]>();
export function setFactionColors(world: StaticWorld | undefined) {
  FACTION_COL.clear();
  for (const f of world?.factions ?? []) {
    const n = parseInt(f.color.replace('#', ''), 16);
    FACTION_COL.set(f.id, [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]);
  }
}
export const sideCol = (s: Side): number[] => FACTION_COL.get(s) ?? (s === 'USA' ? COL.usa : s === 'USSR' ? COL.ussr : COL.unknown);
/** lighter variant for missile tracks */
export const missileCol = (s: Side): number[] => { const c = sideCol(s); return [c[0] + (1 - c[0]) * 0.35, c[1] + (1 - c[1]) * 0.35, c[2] + (1 - c[2]) * 0.35, 1]; };
const dimC = (c: number[], f: number) => [c[0], c[1], c[2], (c[3] ?? 1) * f];

export function icon(b: DynBatch, lat: number, lon: number, kind: string, col: number[], size: number, w: number, rot = 0, mirror = false) {
  const shape = ICONS[kind] ?? ICONS.unknown;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const mx = mirror ? -1 : 1;
  for (const poly of shape) {
    for (let i = 1; i < poly.length; i++) {
      const [x1, y1] = [poly[i - 1][0] * mx, poly[i - 1][1]], [x2, y2] = [poly[i][0] * mx, poly[i][1]];
      b.seg(lon, lat, lon, lat, col, w, 0,
        (x1 * cs - y1 * sn) * size, (x1 * sn + y1 * cs) * size, (x2 * cs - y2 * sn) * size, (x2 * sn + y2 * cs) * size);
    }
  }
}

export function text(b: DynBatch, lat: number, lon: number, str: string, size: number, col: number[], w: number, dx = 0, dy = 0, align = 0) {
  const segs = textSegments(str, size, align);
  for (let i = 0; i < segs.length; i += 4) b.seg(lon, lat, lon, lat, col, w, 0, segs[i] + dx, segs[i + 1] + dy, segs[i + 2] + dx, segs[i + 3] + dy);
}

export function screenText(b: DynBatch, x: number, y: number, str: string, size: number, col: number[], w: number, align = 0, seven = false) {
  const segs = textSegments(str, size, align, seven);
  for (let i = 0; i < segs.length; i += 4) b.px(x + segs[i], y + segs[i + 1], x + segs[i + 2], y + segs[i + 3], col, w);
}

export function circlePx(b: DynBatch, lat: number, lon: number, r: number, col: number[], w: number, n = 40, flags = 0) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    b.seg(lon, lat, lon, lat, col, w, flags, Math.cos(a0) * r, Math.sin(a0) * r, Math.cos(a1) * r, Math.sin(a1) * r);
  }
}

function polyLL(b: DynBatch, pts: LatLon[], col: number[], w: number, flags = 0) {
  for (let i = 1; i < pts.length; i++) b.seg(pts[i - 1].lon, pts[i - 1].lat, pts[i].lon, pts[i].lat, col, w, flags);
}

/** World-space content shared by every panel. */
export function buildWorld(b: DynBatch, st: SceneState) {
  b.reset();
  const { snap, layers: L, dpr } = st;
  const lw = 1.4 * dpr;
  if (!snap) return;
  const t = st.tNow;

  // radar / air defence coverage
  for (const u of snap.units) {
    if (u.status === 'destroyed') continue;
    if (L.radar && u.radarKm) polyLL(b, geoCircle(u, u.radarKm, 90), dimC(sideCol(u.side), 0.25), lw, 2);
    // what a reconnaissance satellite sees right now
    if (L.radar && u.kind === 'satellite' && u.swathKm) polyLL(b, geoCircle(u, u.swathKm, 48), dimC(sideCol(u.side), 0.35), lw, 2);
    if (L.airdef && u.defenceKm && (u.kind === 'afb_int' || u.kind === 'carrier' || u.kind === 'abm')) polyLL(b, geoCircle(u, u.defenceKm, 60), dimC(sideCol(u.side), 0.3), lw);
  }

  // tracks (client-side history)
  if (L.tracks) {
    for (const [id, pts] of st.trails) {
      const u = snap.units.find((x) => x.id === id) ?? snap.contacts.find((x) => x.id === id);
      if (!u || pts.length < 2) continue;
      polyLL(b, pts, dimC(u.side === st.role || st.role === 'SPECTATOR' ? sideCol(u.side) : COL.unknown, 0.35), lw);
    }
  }

  // routes and bomber legs
  if (L.routes) {
    for (const u of snap.units) {
      if (u.status === 'destroyed') continue;
      if (u.route?.length) polyLL(b, [u, ...u.route], dimC(sideCol(u.side), 0.5), lw, 2);
      else if (u.dest && u.kind === 'flight') polyLL(b, gcPath(u, u.dest, 24), (u as Unit).mission === 'strike' ? COL.yellow : dimC(sideCol(u.side), 0.5), lw, 2);
      else if (u.dest && u.kind === 'bomber') polyLL(b, gcPath(u, u.dest, 32), u.status === 'enroute' ? COL.yellow : dimC(sideCol(u.side), 0.55), lw, 2);
    }
  }
  // advisor plan preview
  if (st.plan) {
    for (const c of st.plan.cmds) {
      if (c.op !== 'launch' && c.op !== 'move' && c.op !== 'strike') continue;
      const id = c.op === 'launch' ? c.from : c.unit;
      const u = snap.units.find((x) => x.id === id);
      const tgtName = c.op === 'move' ? c.to : c.target;
      const tgt = findTarget(st, tgtName);
      if (u && tgt) polyLL(b, gcPath(u, tgt, 40), COL.plan, lw * 1.2, 2);
    }
  }

  // detonations
  if (L.blasts) {
    for (const d of snap.detonations) {
      const age = Math.max(0, t - d.t);
      const r = softKillKm(d.yieldKt);
      if (age < 20) {
        const k = 1 - age / 20;
        b.seg(d.lon, d.lat, d.lon, d.lat, [1, 1, 1, 1.6 * k], 7 * dpr * (0.5 + k));
      }
      const ring = r * (1 + Math.min(age, 300) / 60);
      const col = age < 120 ? [1, 0.95, 0.85, 0.9] : age < 600 ? [1, 0.55, 0.2, 0.55] : [0.75, 0.15, 0.1, 0.3];
      polyLL(b, geoCircle(d, ring, 36), col, lw);
      if (age < 300) polyLL(b, geoCircle(d, r * 0.5, 24), col, lw);
    }
  }

  // units / contacts
  const showUnit = (u: Unit | Contact, own: boolean) => {
    if (!branchVisible(L, u.kind)) return;
    const dead = u.status === 'destroyed';
    if (dead && (u.kind === 'bomber' || u.kind === 'flight')) return;
    const unknown = !own && !(u as Contact).identified;
    let col = unknown ? COL.unknown : sideCol(u.side);
    if (dead) col = dimC(col, 0.3);
    if (st.selected === u.id) col = COL.reticle;
    const size = (u.kind === 'carrier' || u.kind === 'ssbn' || u.kind === 'ssn' ? 6.8 : u.kind === 'bomber' ? 7 : 7) * dpr;
    const hdg = u.heading ?? 90;
    // bombers and carriers turn to their heading; submarines (side view) just face east or west
    const rot = u.kind === 'bomber' || u.kind === 'flight' || (u.kind === 'carrier' && u.status === 'moving') ? ((hdg - 90) * Math.PI) / 180 : 0;
    const mirror = (u.kind === 'ssbn' || u.kind === 'ssn' || u.kind === 'carrier') && rot === 0 && u.status === 'moving' && hdg > 180;
    icon(b, u.lat, u.lon, unknown ? 'unknown' : u.kind, col, size, lw * 0.9, rot, mirror);
    if (dead) {
      b.seg(u.lon, u.lat, u.lon, u.lat, col, lw, 0, -size, -size, size, size);
      b.seg(u.lon, u.lat, u.lon, u.lat, col, lw, 0, -size, size, size, -size);
    }
  };
  if (L.units) for (const u of snap.units) showUnit(u, st.role === 'SPECTATOR' || u.side === st.role);
  if (L.contacts) for (const c of snap.contacts) showUnit(c, false);

  // cities
  if (L.cities && st.world) {
    const killed = new Map(snap.cities.map((c) => [c.id, c.killed]));
    for (const c of st.world.cities) {
      const hit = (killed.get(c.id) ?? 0) > c.pop * 0.03;
      const s = (c.pop > 3000 ? 3.2 : c.pop > 1000 ? 2.6 : 2) * dpr;
      icon(b, c.lat, c.lon, 'city', hit ? COL.red : COL.city, s, lw * 0.9);
    }
  }

  // missiles
  if (L.missiles) {
    for (const m of snap.missiles) drawMissile(b, m, t, st, lw);
  }
}

function drawMissile(b: DynBatch, m: Missile, t: number, st: SceneState, lw: number) {
  const pos = ballisticPos(m.from, m.to, m.launchT, m.impactT, m.apexKm, t);
  if (pos.f <= 0) return;
  const base = m.type === 'ABM' ? COL.yellow : missileCol(m.side);
  const N = 40;
  let prev = ballisticPos(m.from, m.to, 0, 1, m.apexKm, 0);
  for (let i = 1; i <= N; i++) {
    const f = (i / N) * pos.f;
    const cur = ballisticPos(m.from, m.to, 0, 1, m.apexKm, f);
    const a = 0.25 + 0.75 * (i / N);
    b.seg(prev.p.lon, prev.p.lat, cur.p.lon, cur.p.lat, [base[0], base[1], base[2], a * (m.confirmed === false ? 0.6 : 1)], lw * 1.1, m.confirmed === false ? 2 : 0, 0, 0, 0, 0, prev.alt, cur.alt);
    prev = cur;
  }
  if (st.layers.predicted && (m.confirmed !== false) && m.type !== 'ABM') {
    let p0 = pos;
    for (let i = 1; i <= 16; i++) {
      const f = pos.f + ((1 - pos.f) * i) / 16;
      const c = ballisticPos(m.from, m.to, 0, 1, m.apexKm, f);
      b.seg(p0.p.lon, p0.p.lat, c.p.lon, c.p.lat, dimC(base, 0.22), lw, 2, 0, 0, 0, 0, p0.alt, c.alt);
      p0 = c;
    }
    // impact marker
    const s = 4 * st.dpr;
    b.seg(m.to.lon, m.to.lat, m.to.lon, m.to.lat, dimC(base, 0.6), lw, 0, -s, -s, s, s);
    b.seg(m.to.lon, m.to.lat, m.to.lon, m.to.lat, dimC(base, 0.6), lw, 0, -s, s, s, -s);
  }
  // bright head (lifted by altitude)
  b.seg(pos.p.lon, pos.p.lat, pos.p.lon, pos.p.lat, [base[0], base[1], base[2], 2.2], 4.5 * st.dpr, 0, 0, 0, 0, 0, pos.alt, pos.alt);
}

function findTarget(st: SceneState, name: string): LatLon | null {
  const r = name.toLowerCase();
  const ll = r.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (ll) return { lat: +ll[1], lon: +ll[2] };
  const s = st.snap;
  const u = s?.contacts.find((c) => c.id === r) ?? s?.units.find((c) => c.id === r);
  if (u) return u;
  const c = st.world?.cities.find((x) => x.name.toLowerCase() === r || x.name.toLowerCase().startsWith(r));
  if (c) return c;
  const sea = st.world?.seaAreas.find((a) => a.name.toLowerCase().includes(r));
  return sea ?? null;
}

// ------------------------------------------------------------------ per-panel labels

export interface Pick {
  id: string;
  x: number;
  y: number;
  name: string;
}

class Occupancy {
  private grid: Uint8Array;
  private cw: number;
  private ch: number;
  constructor(private w: number, private h: number, private cell = 6) {
    this.cw = Math.ceil(w / cell);
    this.ch = Math.ceil(h / cell);
    this.grid = new Uint8Array(this.cw * this.ch);
  }
  tryTake(x: number, y: number, w: number, h: number): boolean {
    const c0 = Math.floor(x / this.cell), c1 = Math.floor((x + w) / this.cell);
    const r0 = Math.floor(y / this.cell), r1 = Math.floor((y + h) / this.cell);
    if (c0 < 0 || r0 < 0 || c1 >= this.cw || r1 >= this.ch) return false;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (this.grid[r * this.cw + c]) return false;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.grid[r * this.cw + c] = 1;
    return true;
  }
}

/** Labels with collision avoidance + pick list for one panel. */
export function buildPanelLabels(b: DynBatch, st: SceneState, xf: Xform, focusLabel: string | null): Pick[] {
  b.reset();
  const picks: Pick[] = [];
  const snap = st.snap;
  const dpr = st.dpr;
  const occ = new Occupancy(xf.w, xf.h, 4 * dpr);
  const span = spanDeg(xf);
  const lw = 1.2 * dpr;
  const L = st.layers;
  const place = (lat: number, lon: number, str: string, size: number, col: number[], dx = 7 * dpr, prio = false) => {
    const p = toScreen(xf, lat, lon);
    if (!p) return false;
    const w = textWidth(str, size);
    if (!occ.tryTake(p[0] + dx - 2, p[1] - size / 2 - 2, w + 4, size + 4) && !prio) return false;
    text(b, lat, lon, str, size, col, lw, dx, 0);
    return true;
  };
  // reserve space for unit icons first
  const units: (Unit | Contact)[] = snap ? [...snap.units, ...snap.contacts] : [];
  for (const u of units) {
    if (u.status === 'destroyed' && (u.kind === 'bomber' || u.kind === 'flight')) continue;
    if (!branchVisible(L, u.kind)) continue;
    const own = st.role === 'SPECTATOR' || u.side === st.role || snap!.units.includes(u as Unit);
    if ((own && !L.units) || (!own && !L.contacts)) continue;
    const p = toScreen(xf, u.lat, u.lon);
    if (!p || p[0] < -20 || p[1] < -20 || p[0] > xf.w + 20 || p[1] > xf.h + 20) continue;
    occ.tryTake(p[0] - 5 * dpr, p[1] - 5 * dpr, 10 * dpr, 10 * dpr);
    picks.push({ id: u.id, x: p[0], y: p[1], name: u.name });
  }
  // missile heads are clickable too (lifted by altitude like the drawing)
  if (snap && L.missiles) {
    const lift = 0.45 * (xf.ky / 111);
    for (const m of snap.missiles) {
      const pos = ballisticPos(m.from, m.to, m.launchT, m.impactT, m.apexKm, st.tNow);
      const p = toScreen(xf, pos.p.lat, pos.p.lon);
      if (!p) continue;
      const y = p[1] - pos.alt * lift;
      picks.push({ id: m.id, x: p[0], y, name: `${m.type} ${m.side} → ${m.target}` });
      if (m.id === st.selected) {
        const r = 16 * dpr;
        for (let i = 0; i < 40; i++) {
          const a0 = (i / 40) * Math.PI * 2, a1 = ((i + 1) / 40) * Math.PI * 2;
          b.seg(pos.p.lon, pos.p.lat, pos.p.lon, pos.p.lat, COL.reticle, 1.6 * dpr, 0, Math.cos(a0) * r, Math.sin(a0) * r, Math.cos(a1) * r, Math.sin(a1) * r, pos.alt, pos.alt);
        }
        const km = Math.round(distKm(pos.p, m.to) );
        const eta = Math.max(0, m.impactT - st.tNow);
        const label = `${m.type} → ${m.target}  ${km} KM  T-${Math.floor(eta / 60)}:${String(Math.floor(eta % 60)).padStart(2, '0')}`;
        const segs = textSegments(label, 8 * dpr, 0);
        for (let i = 0; i < segs.length; i += 4) b.seg(pos.p.lon, pos.p.lat, pos.p.lon, pos.p.lat, COL.reticle, lw, 0, segs[i] + r + 6 * dpr, segs[i + 1], segs[i + 2] + r + 6 * dpr, segs[i + 3], pos.alt, pos.alt);
      }
    }
  }
  if (!L.labels) return picks;

  // selection reticle (film-style magenta circle + big name)
  const sel = st.selected ? units.find((u) => u.id === st.selected) : undefined;
  if (sel) {
    const r = Math.max(18 * dpr, Math.min(60 * dpr, xf.w / 14));
    circlePx(b, sel.lat, sel.lon, r, COL.reticle, 1.6 * dpr, 64);
    place(sel.lat, sel.lon, sel.name, 9 * dpr, COL.reticle, r + 6 * dpr, true);
  }
  if (focusLabel && !sel) {
    // inset title near the centre target
  }

  const big = 7 * dpr, small = 5.5 * dpr;
  if (L.cities && st.world) {
    const minPop = span > 200 ? 4000 : span > 90 ? 1500 : span > 40 ? 500 : 0;
    for (const c of [...st.world.cities].sort((a, b2) => b2.pop - a.pop)) {
      if (c.pop < minPop) continue;
      place(c.lat, c.lon, c.name, span < 30 ? big : small, dimC(COL.city, 0.9));
    }
  }
  if (snap) {
    const unitLabelSpan = 70;
    for (const u of units) {
      if (u.id === st.selected || (u.status === 'destroyed' && (u.kind === 'bomber' || u.kind === 'flight')) || !branchVisible(L, u.kind)) continue;
      const important = u.kind === 'silo' || u.kind === 'carrier' || u.kind === 'ssbn' || u.kind === 'bomber' || u.kind === 'airbase';
      if (span > unitLabelSpan && !(span < 160 && important && u.side === st.role)) continue;
      const unknown = 'identified' in u && !u.identified;
      const col = unknown ? COL.unknown : sideCol(u.side);
      const label = span < 25 ? u.name : u.id.toUpperCase();
      place(u.lat, u.lon, label, span < 25 ? big : small, dimC(col, 0.85));
    }
  }
  if (L.places && span < 22 && st.places.length) {
    const maxRank = span < 4 ? 10 : span < 9 ? 8 : span < 15 ? 6 : 4;
    for (const p of st.places) {
      if (p[3] > maxRank) continue;
      const s = toScreen(xf, p[1], p[2]);
      if (!s || s[0] < 0 || s[1] < 0 || s[0] > xf.w || s[1] > xf.h) continue;
      if (place(p[1], p[2], p[0].toUpperCase(), span < 6 ? big : small, dimC(COL.label, 0.75))) {
        icon(b, p[1], p[2], 'city', dimC(COL.city, 0.7), 2 * dpr, lw);
      }
    }
  }
  if (st.world && span < 160) {
    for (const a of st.world.seaAreas) place(a.lat, a.lon, a.name, small, dimC(COL.coast, 0.4), 0);
  }
  return picks;
}
