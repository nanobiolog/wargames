import {
  makeProjection, normLon, gcPath, geoCircle, ballisticPos, softKillKm, PALETTE, KIND_GLYPH,
  type Projection, type Snapshot, type StaticWorld, type Unit, type Contact, type LatLon, type Side,
} from '@coldlaunch/shared';
import { loadGeo, loadPlaces, type GeoLayers, type Place } from '@coldlaunch/data';
import { BrailleCanvas } from './braille.ts';
import { hex, dim, type RGB, type Screen } from './screen.ts';

export const LAYER_NAMES = [
  'coast', 'borders', 'states', 'admin1', 'rivers', 'lakes', 'roads', 'urban', 'grid', 'cities', 'places',
  'units', 'contacts', 'missiles', 'tracks', 'blasts', 'coverage', 'routes', 'labels',
] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

const C = {
  coast: hex(PALETTE.coast), coastDim: hex(PALETTE.coastDim), border: hex(PALETTE.border), states: hex(PALETTE.states),
  admin1: dim(hex(PALETTE.states), 0.7), river: dim(hex(PALETTE.river), 0.8), road: dim(hex(PALETTE.road), 0.7),
  urban: hex(PALETTE.urban), grid: hex(PALETTE.grid), city: hex(PALETTE.city), label: hex(PALETTE.label),
  reticle: hex(PALETTE.reticle), usa: hex(PALETTE.usa), ussr: hex(PALETTE.ussr), mUSA: hex(PALETTE.missileUSA),
  mUSSR: hex(PALETTE.missileUSSR), blast: hex(PALETTE.blast), warn: hex(PALETTE.warn), lake: dim(hex(PALETTE.coast), 0.6),
};

interface LodData {
  layers: GeoLayers;
  bbox: Record<string, Float32Array>; // per line: minLon,minLat,maxLon,maxLat
}

function buildBBoxes(layers: GeoLayers): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const [name, lines] of Object.entries(layers)) {
    const bb = new Float32Array(lines.length * 4);
    lines.forEach((l, i) => {
      let x0 = 999, y0 = 999, x1 = -999, y1 = -999;
      for (let k = 0; k < l.length; k += 2) {
        const x = l[k], y = l[k + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      bb.set([x0, y0, x1, y1], i * 4);
    });
    out[name] = bb;
  }
  return out;
}

export interface MapData {
  snap?: Snapshot;
  world?: StaticWorld;
  side?: Side | 'SPECTATOR';
  selected?: string | null;
}

export class MapView {
  proj: 'equirect' | 'polar' = 'equirect';
  lat = 30;
  lon = -20;
  zoom = 1;
  layers: Record<LayerName, boolean> = {
    coast: true, borders: true, states: true, admin1: false, rivers: true, lakes: true, roads: true, urban: true, grid: true,
    cities: true, places: true, units: true, contacts: true, missiles: true, tracks: true, blasts: true, coverage: false,
    routes: true, labels: true,
  };
  canvas = new BrailleCanvas();
  private lods: (LodData | null)[] = [null, null, null];
  private places: Place[] | null = null;
  private projection: Projection = makeProjection('equirect', this.lon);
  private kx = 1;
  private ky = 1;
  private cx = 0;
  private cy = 0;
  hits: { id: string; x: number; y: number; name: string }[] = [];
  private occupied = new Uint8Array(0);
  private labelsQ: { x: number; y: number; text: string; color: RGB; prio: number }[] = [];
  private glyphQ: { x: number; y: number; ch: string; color: RGB; bold?: boolean }[] = [];
  lodInUse = 0;

  setSize(cw: number, ch: number) {
    if (cw !== this.canvas.cw || ch !== this.canvas.ch) this.canvas.resize(cw, ch);
  }

  private lod(n: 0 | 1 | 2): LodData {
    if (!this.lods[n]) {
      const layers = loadGeo(n);
      this.lods[n] = { layers, bbox: buildBBoxes(layers) };
    }
    return this.lods[n]!;
  }

  private fitScale() {
    const { pw, ph } = this.canvas;
    if (this.proj === 'polar') return Math.min(pw, ph) / 150; // ~75° from pole visible radius
    return Math.min(pw / 360, ph / 150);
  }

  /** Visible longitudinal span in degrees. */
  spanDeg() {
    return this.canvas.pw / (this.fitScale() * this.zoom);
  }

  private setup() {
    const scale = this.fitScale() * this.zoom;
    if (this.proj === 'polar') {
      this.projection = makeProjection('polar', -80);
      this.kx = scale;
      this.ky = scale;
      const [x, y] = this.projection.project(this.lat, this.lon);
      this.cx = x;
      this.cy = y;
    } else {
      this.projection = makeProjection('equirect', this.lon);
      const latC = Math.max(-70, Math.min(70, this.lat));
      this.kx = scale * (this.zoom >= 3 ? Math.cos((latC * Math.PI) / 180) : 1);
      this.ky = scale;
      this.cx = 0;
      this.cy = -this.lat;
    }
  }

  /** lat/lon → braille pixel coords. */
  px(lat: number, lon: number): [number, number] {
    const [x, y] = this.projection.project(lat, lon);
    return [this.canvas.pw / 2 + (x - this.cx) * this.kx, this.canvas.ph / 2 + (y - this.cy) * this.ky];
  }

  cellToLatLon(cx: number, cy: number): LatLon {
    this.setup();
    const X = (cx * 2 + 1 - this.canvas.pw / 2) / this.kx + this.cx;
    const Y = (cy * 4 + 2 - this.canvas.ph / 2) / this.ky + this.cy;
    const [lat, lon] = this.projection.invert(X, Y);
    return { lat: Math.max(-89, Math.min(89, lat)), lon };
  }

  zoomBy(f: number, atCell?: { x: number; y: number }) {
    const before = atCell ? this.cellToLatLon(atCell.x, atCell.y) : null;
    this.zoom = Math.max(0.6, Math.min(400, this.zoom * f));
    if (before && atCell) {
      // keep the point under the cursor fixed
      const after = this.cellToLatLon(atCell.x, atCell.y);
      this.lat = Math.max(-85, Math.min(89, this.lat + (before.lat - after.lat)));
      this.lon = normLon(this.lon + (before.lon - after.lon));
    }
  }

  panCells(dx: number, dy: number) {
    const c = this.cellToLatLon(this.canvas.cw / 2 + dx, this.canvas.ch / 2 + dy);
    this.lat = Math.max(-85, Math.min(89, c.lat));
    this.lon = c.lon;
  }

  centerOn(lat: number, lon: number, zoom?: number) {
    this.lat = lat;
    this.lon = lon;
    if (zoom) this.zoom = zoom;
  }

  private polyline(pts: number[], color: RGB, prio: number) {
    const polar = this.proj === 'polar';
    let px = 0, py = 0, pX = 0, has = false;
    for (let k = 0; k < pts.length; k += 2) {
      const lon = pts[k], lat = pts[k + 1];
      if (polar && lat < -25) { has = false; continue; }
      const [X, Y] = this.projection.project(lat, lon);
      const x = this.canvas.pw / 2 + (X - this.cx) * this.kx;
      const y = this.canvas.ph / 2 + (Y - this.cy) * this.ky;
      if (has && (polar || Math.abs(X - pX) < 180)) this.canvas.line(px, py, x, y, color, prio);
      px = x; py = y; pX = X; has = true;
    }
  }

  private pathLL(pts: LatLon[], color: RGB, prio: number, dashed = false) {
    const polar = this.proj === 'polar';
    let prev: [number, number, number] | null = null;
    pts.forEach((p, i) => {
      if (polar && p.lat < -25) { prev = null; return; }
      const [X] = this.projection.project(p.lat, p.lon);
      const [x, y] = this.px(p.lat, p.lon);
      if (prev && (polar || Math.abs(X - prev[2]) < 180) && (!dashed || i % 2 === 0)) this.canvas.line(prev[0], prev[1], x, y, color, prio);
      prev = [x, y, X];
    });
  }

  private viewBounds() {
    if (this.proj === 'polar') return null;
    const hw = this.canvas.pw / 2 / this.kx;
    const hh = this.canvas.ph / 2 / this.ky;
    return { lon0: this.lon - hw, lon1: this.lon + hw, lat0: this.lat - hh, lat1: this.lat + hh, wrap: hw >= 180 };
  }

  private drawLayer(lod: LodData, name: string, color: RGB, prio: number) {
    const lines = lod.layers[name];
    if (!lines) return;
    const bb = lod.bbox[name];
    const vb = this.viewBounds();
    for (let i = 0; i < lines.length; i++) {
      if (vb) {
        if (bb[i * 4 + 3] < vb.lat0 || bb[i * 4 + 1] > vb.lat1) continue;
        if (!vb.wrap && vb.lon0 >= -180 && vb.lon1 <= 180 && (bb[i * 4 + 2] < vb.lon0 || bb[i * 4] > vb.lon1)) continue;
      } else if (bb[i * 4 + 3] < -25) continue;
      this.polyline(lines[i], color, prio);
    }
  }

  private cellOf(lat: number, lon: number): [number, number] | null {
    if (this.proj === 'polar' && lat < -25) return null;
    const [x, y] = this.px(lat, lon);
    const cx = Math.floor(x / 2), cy = Math.floor(y / 4);
    if (cx < 0 || cy < 0 || cx >= this.canvas.cw || cy >= this.canvas.ch) return null;
    return [cx, cy];
  }

  private label(cx: number, cy: number, text: string, color: RGB, prio: number) {
    this.labelsQ.push({ x: cx, y: cy, text, color, prio });
  }

  private glyph(lat: number, lon: number, ch: string, color: RGB, id?: string, name?: string, bold = false) {
    const c = this.cellOf(lat, lon);
    if (!c) return null;
    this.glyphQ.push({ x: c[0], y: c[1], ch, color, bold });
    if (id) this.hits.push({ id, x: c[0], y: c[1], name: name ?? id });
    return c;
  }

  render(scr: Screen, ox: number, oy: number, d: MapData) {
    this.setup();
    const cv = this.canvas;
    cv.clear();
    this.hits = [];
    this.labelsQ = [];
    this.glyphQ = [];
    this.occupied = new Uint8Array(cv.cw * cv.ch);
    const span = this.spanDeg();
    const lodN: 0 | 1 | 2 = span > 140 ? 0 : span > 30 ? 1 : 2;
    this.lodInUse = lodN;
    const lod = this.lod(lodN);
    const L = this.layers;

    // ---- graticule
    if (L.grid) {
      const step = span > 200 ? 30 : span > 60 ? 10 : span > 15 ? 5 : 1;
      for (let lon = -180; lon < 180; lon += step) {
        const pts: number[] = [];
        for (let lat = -80; lat <= 85; lat += 2.5) pts.push(lon, lat);
        this.polyline(pts, C.grid, 1);
      }
      for (let lat = -60; lat <= 80; lat += step) {
        const pts: number[] = [];
        for (let lon = -180; lon <= 180; lon += 2) pts.push(lon, lat);
        this.polyline(pts, C.grid, 1);
      }
    }
    // ---- geography (draw order = priority)
    if (L.admin1 && lodN > 0) this.drawLayer(lod, 'admin1', C.admin1, 2);
    if (L.roads && lodN === 2) this.drawLayer(lod, 'roads', C.road, 2);
    if (L.rivers && lodN > 0) this.drawLayer(lod, 'rivers', C.river, 3);
    if (L.lakes && lodN === 2) this.drawLayer(lod, 'lakes', C.lake, 3);
    if (L.urban && lodN === 2) this.drawLayer(lod, 'urban', C.urban, 4);
    if (L.states && lodN > 0) this.drawLayer(lod, 'states', C.states, 4);
    if (L.borders) this.drawLayer(lod, 'borders', C.border, 5);
    if (L.coast) this.drawLayer(lod, 'coast', C.coast, 6);

    const snap = d.snap;
    const viewer = d.side ?? 'USA';
    const sideColor = (s: Side) => (s === 'USA' ? C.usa : C.ussr);

    // ---- cities
    if (L.cities && d.world) {
      const killed = new Map(snap?.cities.map((c) => [c.id, c.killed]) ?? []);
      for (const c of d.world.cities) {
        const minPop = span > 200 ? 3000 : span > 90 ? 1200 : span > 40 ? 400 : 0;
        if (c.pop < minPop) continue;
        const k = killed.get(c.id) ?? 0;
        const hit = k > c.pop * 0.05;
        const col = hit ? C.ussr : C.city;
        const cc = this.glyph(c.lat, c.lon, hit ? '✱' : '∘', col);
        if (cc && L.labels) this.label(cc[0] + 1, cc[1], c.name, dim(col, 0.9), c.pop > 3000 ? 3 : 2);
      }
    }
    if (L.places && span < 25) {
      this.places ??= loadPlaces();
      const maxRank = span < 4 ? 10 : span < 10 ? 7 : 5;
      for (const p of this.places) {
        if (p[3] > maxRank) continue;
        const cc = this.glyph(p[1], p[2], '·', dim(C.city, 0.7));
        if (cc && L.labels) this.label(cc[0] + 1, cc[1], p[0].toUpperCase(), dim(C.city, 0.65), 1);
      }
    }

    if (!snap) return this.compose(scr, ox, oy);

    // ---- coverage rings
    if (L.coverage) {
      for (const u of snap.units) {
        if (u.status === 'destroyed') continue;
        if (u.radarKm) this.pathLL(geoCircle(u, u.radarKm, 72), dim(sideColor(u.side), 0.35), 2, true);
        if (u.defenceKm && (u.kind === 'afb_int' || u.kind === 'carrier' || u.kind === 'abm')) this.pathLL(geoCircle(u, u.defenceKm, 48), dim(sideColor(u.side), 0.5), 2);
      }
    }

    // ---- routes / bomber legs
    if (L.routes) {
      for (const u of snap.units) {
        if (u.status === 'destroyed') continue;
        if (u.route?.length) this.pathLL([u, ...u.route], dim(sideColor(u.side), 0.55), 7, true);
        else if (u.dest && u.kind === 'bomber') this.pathLL(gcPath(u, u.dest, 24), dim(u.status === 'enroute' ? C.warn : sideColor(u.side), 0.7), 7, true);
      }
    }

    // ---- missiles
    if (L.missiles) {
      for (const m of snap.missiles) {
        const pos = ballisticPos(m.from, m.to, m.launchT, m.impactT, m.apexKm, snap.t);
        const col = m.type === 'ABM' ? C.warn : m.side === 'USA' ? C.mUSA : C.mUSSR;
        const n = 28;
        const trail: LatLon[] = [];
        for (let i = 0; i <= n; i++) trail.push(ballisticPos(m.from, m.to, 0, 1, m.apexKm, (i / n) * pos.f).p);
        if (L.tracks) this.pathLL(trail, col, 9);
        if (L.tracks && (m.confirmed || m.side === viewer)) {
          const fut: LatLon[] = [];
          for (let i = 0; i <= 16; i++) fut.push(ballisticPos(m.from, m.to, 0, 1, m.apexKm, pos.f + ((1 - pos.f) * i) / 16).p);
          this.pathLL(fut, dim(col, 0.35), 8, true);
        }
        const sel = d.selected === m.id;
        const c = this.glyph(pos.p.lat, pos.p.lon, m.confirmed === false ? '?' : '●', sel ? C.reticle : col, m.id, `${m.type} → ${m.target}`, true);
        if (sel && c) {
          const [x, y] = this.px(pos.p.lat, pos.p.lon);
          cv.circle(x, y, 6, C.reticle, 12);
          const eta = Math.max(0, m.impactT - snap.t);
          this.label(c[0] + 2, c[1] - 1, `${m.type} → ${m.target} T-${Math.floor(eta / 60)}:${String(Math.floor(eta % 60)).padStart(2, '0')}`, C.reticle, 9);
        }
      }
    }

    // ---- detonations
    if (L.blasts) {
      for (const b of snap.detonations) {
        const age = snap.t - b.t;
        const col: RGB = age < 90 ? C.blast : age < 400 ? [255, 160, 60] : [150, 40, 30];
        const [x, y] = this.px(b.lat, b.lon);
        const rkm = softKillKm(b.yieldKt) * (age < 60 ? 2.5 : 1.5);
        const rpx = Math.max(1.5, (rkm / 111) * this.ky);
        cv.circle(x, y, rpx, col, 10);
        if (age < 120) cv.circle(x, y, rpx * 0.5, col, 10);
      }
    }

    // ---- units
    const drawUnit = (u: Unit | Contact, own: boolean) => {
      const dead = u.status === 'destroyed';
      if (dead && u.kind === 'bomber') return;
      const unknown = !own && !(u as Contact).identified;
      const col = dead ? dim(sideColor(u.side), 0.35) : unknown ? C.warn : sideColor(u.side);
      const ch = dead ? '×' : unknown ? '◌' : u.kind === 'bomber' ? '↑↗→↘↓↙←↖'[Math.round((u.heading ?? 90) / 45) % 8] : KIND_GLYPH[u.kind];
      const isSel = d.selected && (u.id === d.selected);
      const c = this.glyph(u.lat, u.lon, ch, isSel ? C.reticle : col, u.id, u.name, !dead);
      if (!c) return;
      if (isSel) {
        const [x, y] = this.px(u.lat, u.lon);
        cv.circle(x, y, Math.max(6, Math.min(cv.ph / 5, 10 + this.zoom)), C.reticle, 12);
        this.label(c[0] + 2, c[1] - 1, u.name, C.reticle, 9);
      } else if (L.labels && (span < 35 || (span < 80 && (u.kind === 'silo' || u.kind === 'carrier' || u.kind === 'ssbn' || u.kind === 'bomber')))) {
        this.label(c[0] + 1, c[1], u.id.toUpperCase(), dim(col, 0.8), 4);
      }
    };
    if (L.units) for (const u of snap.units) drawUnit(u, viewer === 'SPECTATOR' || u.side === viewer);
    if (L.contacts) for (const c of snap.contacts) drawUnit(c, false);

    this.compose(scr, ox, oy);
  }

  private compose(scr: Screen, ox: number, oy: number) {
    const cv = this.canvas;
    cv.blit(scr, ox, oy);
    for (const g of this.glyphQ) {
      scr.put(ox + g.x, oy + g.y, g.ch, g.color, [0, 0, 0], g.bold);
      this.occupied[g.y * cv.cw + g.x] = 1;
    }
    this.labelsQ.sort((a, b) => b.prio - a.prio);
    for (const l of this.labelsQ) {
      if (l.y < 0 || l.y >= cv.ch) continue;
      const len = Math.min(l.text.length, cv.cw - l.x);
      if (len < 3) continue;
      let free = true;
      for (let i = -1; i <= len; i++) {
        const x = l.x + i;
        if (x >= 0 && x < cv.cw && this.occupied[l.y * cv.cw + x]) { free = false; break; }
      }
      if (!free) continue;
      for (let i = 0; i < len; i++) this.occupied[l.y * cv.cw + l.x + i] = 1;
      scr.put(ox + l.x, oy + l.y, l.text.slice(0, len), l.color);
    }
  }

  hitTest(cx: number, cy: number): string | null {
    let best: string | null = null, bd = 9;
    for (const h of this.hits) {
      const d = (h.x - cx) ** 2 + ((h.y - cy) * 2) ** 2;
      if (d < bd) { bd = d; best = h.id; }
    }
    return best;
  }
}
