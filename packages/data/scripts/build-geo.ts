/**
 * Builds the vector map assets from Natural Earth (public domain).
 *
 *   npm run geo
 *
 * Inputs:  world-atlas / us-atlas npm packages + Natural Earth GeoJSON (downloaded once to raw/)
 * Outputs: packages/data/geo/lod{0,1,2}.json  — flat polylines [lon,lat,lon,lat,...] per layer
 *          packages/data/geo/places.json       — populated places for labels / search
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as topo from 'topojson-client';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const RAW = join(ROOT, 'raw');
const OUT = join(ROOT, 'geo');
mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';

type Line = number[]; // flat lon,lat pairs
type Pt = [number, number];

async function fetchNE(name: string): Promise<any> {
  const file = join(RAW, name);
  if (!existsSync(file) || statSync(file).size < 100) {
    process.stdout.write(`  downloading ${name} ... `);
    const res = await fetch(NE + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log('ok');
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function loadTopo(pkgPath: string): any {
  return JSON.parse(readFileSync(require.resolve(pkgPath), 'utf8'));
}

// ---------------------------------------------------------------- geometry helpers

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3 || tol <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function bboxSize(pts: Pt[]): number {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return Math.max(x1 - x0, y1 - y0);
}

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

/** Split lines that wrap the antimeridian so renderers never draw a world-wide streak. */
function splitDateline(pts: Pt[]): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && Math.abs(pts[i][0] - pts[i - 1][0]) > 180) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
    cur.push(pts[i]);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

function geomLines(geom: any): Pt[][] {
  if (!geom) return [];
  switch (geom.type) {
    case 'LineString': return [geom.coordinates];
    case 'MultiLineString': return geom.coordinates;
    case 'Polygon': return geom.coordinates;
    case 'MultiPolygon': return geom.coordinates.flat();
    case 'GeometryCollection': return geom.geometries.flatMap(geomLines);
    default: return [];
  }
}

function toLayer(lines: Pt[][], tol: number, minSize: number, dp: number): Line[] {
  const out: Line[] = [];
  for (const l of lines) {
    for (const seg of splitDateline(l)) {
      if (minSize > 0 && bboxSize(seg) < minSize) continue;
      const s = simplify(seg, tol);
      if (s.length < 2) continue;
      const flat: number[] = [];
      for (const [x, y] of s) flat.push(round(x, dp), round(y, dp));
      out.push(flat);
    }
  }
  return out;
}

function count(layer: Line[]) {
  return layer.reduce((n, l) => n + l.length / 2, 0);
}

// ---------------------------------------------------------------- build

async function main() {
  console.log('Building vector map assets…');
  const w110 = loadTopo('world-atlas/countries-110m.json');
  const w50 = loadTopo('world-atlas/countries-50m.json');
  const w10 = loadTopo('world-atlas/countries-10m.json');
  const l110 = loadTopo('world-atlas/land-110m.json');
  const l50 = loadTopo('world-atlas/land-50m.json');
  const l10 = loadTopo('world-atlas/land-10m.json');
  const us = loadTopo('us-atlas/states-10m.json');

  const coast = (t: any) => geomLines(topo.mesh(t, t.objects.land));
  const borders = (t: any) => geomLines(topo.mesh(t, t.objects.countries, (a: any, b: any) => a !== b));
  const usStates = geomLines(topo.mesh(us, us.objects.states, (a: any, b: any) => a !== b));

  const [rivers50, rivers10, lakes10, roads10, urban10, admin1, places] = await Promise.all([
    fetchNE('ne_50m_rivers_lake_centerlines.geojson'),
    fetchNE('ne_10m_rivers_lake_centerlines.geojson'),
    fetchNE('ne_10m_lakes.geojson'),
    fetchNE('ne_10m_roads.geojson'),
    fetchNE('ne_10m_urban_areas.geojson'),
    fetchNE('ne_10m_admin_1_states_provinces_lines.geojson'),
    fetchNE('ne_10m_populated_places_simple.geojson'),
  ]);

  const feats = (fc: any, pred: (p: any) => boolean = () => true) =>
    fc.features.filter((f: any) => pred(f.properties ?? {})).flatMap((f: any) => geomLines(f.geometry));

  const admin1Other = feats(admin1, (p) => (p.ADM0_A3 ?? p.adm0_a3) !== 'USA');
  const majorRoads = feats(roads10, (p) => (p.scalerank ?? 10) <= 6 && /Major|Primary|Secondary|Highway/i.test(`${p.type} ${p.expressway}`));
  const lod = {
    lod0: {
      coast: toLayer(coast(l110), 0.15, 1.5, 2),
      borders: toLayer(borders(w110), 0.15, 0, 2),
    },
    lod1: {
      coast: toLayer(coast(l50), 0.03, 0.25, 2),
      borders: toLayer(borders(w50), 0.03, 0, 2),
      states: toLayer(usStates, 0.03, 0, 2),
      admin1: toLayer(admin1Other, 0.05, 0, 2),
      rivers: toLayer(feats(rivers50, (p) => (p.scalerank ?? 9) <= 5), 0.05, 0, 2),
    },
    lod2: {
      coast: toLayer(coast(l10), 0.004, 0, 3),
      borders: toLayer(borders(w10), 0.004, 0, 3),
      states: toLayer(usStates, 0.004, 0, 3),
      admin1: toLayer(admin1Other, 0.006, 0, 3),
      rivers: toLayer(feats(rivers10), 0.004, 0, 3),
      lakes: toLayer(feats(lakes10, (p) => (p.scalerank ?? 9) <= 8), 0.004, 0.02, 3),
      roads: toLayer(majorRoads, 0.006, 0, 3),
      urban: toLayer(feats(urban10, (p) => (p.area_sqkm ?? 0) > 25), 0.004, 0, 3),
    },
  };

  for (const [name, layers] of Object.entries(lod)) {
    const file = join(OUT, `${name}.json`);
    writeFileSync(file, JSON.stringify(layers));
    const stats = Object.entries(layers).map(([k, v]) => `${k}:${count(v as Line[])}`).join(' ');
    console.log(`  ${name}.json  ${(statSync(file).size / 1024).toFixed(0)} KB  (${stats})`);
  }

  // Land mask (0.25°) by even-odd scanline fill of land-50m polygons.
  {
    const res = 0.25, W = 1440, H = 720;
    const bits = new Uint8Array((W * H) >> 3);
    const landGeom = topo.feature(l50, l50.objects.land) as any;
    const rings: Pt[][] = [];
    const collect = (g: any) => {
      if (g.type === 'Polygon') rings.push(...g.coordinates);
      else if (g.type === 'MultiPolygon') for (const p of g.coordinates) rings.push(...p);
      else if (g.type === 'GeometryCollection') g.geometries.forEach(collect);
      else if (g.type === 'FeatureCollection') g.features.forEach((f: any) => collect(f.geometry));
      else if (g.type === 'Feature') collect(g.geometry);
    };
    collect(landGeom);
    const xs: number[][] = Array.from({ length: H }, () => []);
    const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
      const r0 = Math.ceil((90 - Math.max(y1, y2)) / res - 0.5);
      const r1 = Math.floor((90 - Math.min(y1, y2)) / res - 0.5);
      for (let r = Math.max(0, r0); r <= Math.min(H - 1, r1); r++) {
        const y = 90 - (r + 0.5) * res;
        if ((y1 > y) === (y2 > y)) continue;
        xs[r].push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    };
    for (const ring of rings) {
      const seam: number[] = [];
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        if (Math.abs(x2 - x1) > 180) {
          // edge crosses the antimeridian: split it at ±180
          const x2u = x2 + (x1 > 0 ? 360 : -360);
          const edge = x1 > 0 ? 180 : -180;
          // seam points often sit exactly on ±180, which makes the interpolation 0/0
          const ym = Math.abs(x2u - x1) < 1e-9 ? (y1 + y2) / 2 : y1 + ((edge - x1) / (x2u - x1)) * (y2 - y1);
          addEdge(x1, y1, edge, ym);
          addEdge(-edge, ym, x2, y2);
          seam.push(ym);
          continue;
        }
        addEdge(x1, y1, x2, y2);
      }
      // A ring that wraps the globe (Eurasia + Chukotka) leaves its boundary along the 180° meridian implicit:
      // close it with vertical edges on both sides between consecutive seam crossings.
      seam.sort((a, b) => a - b);
      for (let k = 0; k + 1 < seam.length; k += 2) {
        addEdge(180, seam[k], 180, seam[k + 1]);
        addEdge(-180, seam[k], -180, seam[k + 1]);
      }
    }
    let landCells = 0;
    for (let r = 0; r < H; r++) {
      const row = xs[r].sort((a, b) => a - b);
      for (let k = 0; k + 1 < row.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((row[k] + 180) / res - 0.5));
        const c1 = Math.min(W - 1, Math.floor((row[k + 1] + 180) / res - 0.5));
        for (let c = c0; c <= c1; c++) {
          const i = r * W + c;
          bits[i >> 3] |= 1 << (i & 7);
          landCells++;
        }
      }
    }
    // Antarctica: treat everything south of 78S as land (polygon touches the pole)
    for (let r = Math.floor((90 + 78) / res); r < H; r++) for (let c = 0; c < W; c++) { const i = r * W + c; bits[i >> 3] |= 1 << (i & 7); }
    writeFileSync(join(OUT, 'landmask.json'), JSON.stringify({ w: W, h: H, res, data: Buffer.from(bits).toString('base64') }));
    console.log(`  landmask.json  ${W}x${H}  land=${((landCells / (W * H)) * 100).toFixed(1)}%`);
  }

  // Places: [name, lat, lon, rank(0 biggest..10), countryA3]
  const pl = places.features
    .map((f: any) => {
      const p = f.properties;
      return [p.name, round(p.latitude, 3), round(p.longitude, 3), p.scalerank ?? p.rank_max ?? 10, p.adm0_a3 ?? ''];
    })
    .filter((p: any[]) => typeof p[0] === 'string');
  writeFileSync(join(OUT, 'places.json'), JSON.stringify(pl));
  console.log(`  places.json  ${pl.length} places`);
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
