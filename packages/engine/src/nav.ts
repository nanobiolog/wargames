// Ocean routing for ships and submarines: A* on a 0.25° water grid derived from the land mask.
// Only water connected to the open ocean is navigable (no inland lakes), plus hand-opened straits.
import type { LandMask } from '@coldlaunch/data';
import type { LatLon } from '@coldlaunch/shared';
import { distKm } from '@coldlaunch/shared';

const RES = 0.25;
const W = 1440;
const H = 720;

/** Straits / canals narrower than a grid cell, forced open (lat, lon polylines). */
const STRAITS: [number, number][][] = [
  [[36.0, -6.3], [35.95, -5.6], [36.0, -5.0], [36.15, -4.4]], // Gibraltar
  [[39.9, 25.9], [40.2, 26.4], [40.45, 26.75], [40.7, 27.6], [40.95, 28.8], [41.1, 29.05], [41.3, 29.15]], // Dardanelles–Marmara–Bosporus
  [[57.7, 10.7], [57.0, 11.2], [56.2, 12.2], [55.7, 12.7], [55.3, 12.9], [54.9, 13.4]], // Kattegat–Øresund
  [[56.0, 10.9], [55.4, 10.95], [54.8, 11.0], [54.4, 11.2]], // Great Belt
  [[45.0, 36.35], [45.3, 36.55], [45.5, 36.7]], // Kerch
  [[12.3, 43.5], [12.6, 43.3], [12.9, 43.15]], // Bab-el-Mandeb
  [[29.85, 32.55], [30.6, 32.35], [31.3, 32.3]], // Suez Canal
  [[8.85, -79.5], [9.1, -79.7], [9.4, -79.9]], // Panama Canal
  [[1.15, 103.6], [1.2, 103.9], [1.3, 104.3]], // Singapore Strait
  [[38.2, 15.6], [38.0, 15.65]], // Messina
];

export class OceanNav {
  private water: Uint8Array;
  constructor(private mask: LandMask) {
    const raw = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        raw[r * W + c] = mask.isLand(90 - (r + 0.5) * RES, -180 + (c + 0.5) * RES) ? 0 : 1;
      }
    }
    for (const line of STRAITS) {
      for (let i = 1; i < line.length; i++) {
        const [la1, lo1] = line[i - 1], [la2, lo2] = line[i];
        const n = Math.ceil(Math.max(Math.abs(la2 - la1), Math.abs(lo2 - lo1)) / (RES / 3)) + 1;
        for (let k = 0; k <= n; k++) {
          const [r, c] = this.cell({ lat: la1 + ((la2 - la1) * k) / n, lon: lo1 + ((lo2 - lo1) * k) / n });
          raw[r * W + c] = 1;
        }
      }
    }
    // keep only water connected to the open ocean (drops Caspian, Ladoga, Great Lakes, …)
    this.water = new Uint8Array(W * H);
    const [sr, sc] = this.cell({ lat: 0, lon: -30 });
    const stack = [sr * W + sc];
    this.water[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const r = Math.floor(i / W), c = i % W;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          if (nr < 0 || nr >= H) continue;
          const ni = nr * W + ((c + dc + W) % W);
          if (raw[ni] && !this.water[ni]) { this.water[ni] = 1; stack.push(ni); }
        }
      }
    }
  }

  isLand(p: LatLon): boolean {
    return this.mask.isLand(p.lat, p.lon);
  }

  private cell(p: LatLon): [number, number] {
    const r = Math.min(H - 1, Math.max(0, Math.floor((90 - p.lat) / RES)));
    let c = Math.floor((p.lon + 180) / RES) % W;
    if (c < 0) c += W;
    return [r, c];
  }

  private center(r: number, c: number): LatLon {
    return { lat: 90 - (r + 0.5) * RES, lon: -180 + (c + 0.5) * RES };
  }

  private wet(r: number, c: number) {
    return r >= 0 && r < H && this.water[r * W + ((c + W) % W)] === 1;
  }

  /** Nearest water cell centre to p (searching outward), or null. */
  private nearestWet(p: LatLon): [number, number] | null {
    const [r0, c0] = this.cell(p);
    for (let rad = 0; rad < 16; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          if (this.wet(r0 + dr, c0 + dc)) return [r0 + dr, (c0 + dc + W) % W];
        }
      }
    }
    return null;
  }

  /**
   * Returns a waypoint list from a to b over water (excluding a, including b),
   * simplified to a handful of turning points. null if unreachable.
   */
  route(a: LatLon, b: LatLon): LatLon[] | null {
    const s = this.nearestWet(a);
    const g = this.nearestWet(b);
    if (!s || !g) return null;
    if (this.straightClear(a, b)) return [b];
    const start = s[0] * W + s[1];
    const goal = g[0] * W + g[1];
    const N = W * H;
    const gScore = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new MinHeap();
    const goalP = this.center(g[0], g[1]);
    const h = (i: number) => distKm(this.center(Math.floor(i / W), i % W), goalP);
    gScore[start] = 0;
    heap.push(start, h(start));
    let found = false;
    let iter = 0;
    while (heap.size && iter++ < 2000000) {
      const cur = heap.pop();
      if (cur === goal) { found = true; break; }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const r = Math.floor(cur / W), c = cur % W;
      const cp = this.center(r, c);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const nr = r + dr, nc = (c + dc + W) % W;
          if (!this.wet(nr, nc)) continue;
          const ni = nr * W + nc;
          if (closed[ni]) continue;
          const ng = gScore[cur] + distKm(cp, this.center(nr, nc));
          if (ng < gScore[ni]) {
            gScore[ni] = ng;
            came[ni] = cur;
            heap.push(ni, ng + h(ni));
          }
        }
      }
    }
    if (!found) return null;
    const cells: LatLon[] = [];
    for (let i = goal; i !== -1; i = came[i]) cells.push(this.center(Math.floor(i / W), i % W));
    cells.reverse();
    // string-pull: keep only points needed for a clear line of sight
    const out: LatLon[] = [];
    let anchor: LatLon = a;
    let k = 0;
    while (k < cells.length) {
      let far = k;
      for (let j = cells.length - 1; j > k; j--) {
        if (this.straightClear(anchor, cells[j])) { far = j; break; }
      }
      out.push(cells[far]);
      anchor = cells[far];
      k = far + 1;
    }
    if (this.straightClear(anchor, b)) out.push(b);
    else out.push(b);
    return out;
  }

  /** True when the great-circle segment a→b doesn't cross land (sampled every ~20 km). */
  straightClear(a: LatLon, b: LatLon): boolean {
    const d = distKm(a, b);
    const n = Math.max(2, Math.ceil(d / 20));
    for (let i = 1; i < n; i++) {
      const f = i / n;
      // cheap linear interpolation is fine for short hops; use gc for long ones
      const p = d < 600
        ? { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + wrapDelta(b.lon - a.lon) * f }
        : gcLerp(a, b, f);
      const [r, c] = this.cell(p);
      if (!this.wet(r, c)) return false;
    }
    return true;
  }
}

function wrapDelta(d: number) {
  return d > 180 ? d - 360 : d < -180 ? d + 360 : d;
}

import { gcInterpolate } from '@coldlaunch/shared';
function gcLerp(a: LatLon, b: LatLon, f: number) {
  return gcInterpolate(a, b, f);
}

class MinHeap {
  private ids: number[] = [];
  private pr: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, p: number) {
    const ids = this.ids, pr = this.pr;
    ids.push(id); pr.push(p);
    let i = ids.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (pr[par] <= pr[i]) break;
      [ids[par], ids[i]] = [ids[i], ids[par]];
      [pr[par], pr[i]] = [pr[i], pr[par]];
      i = par;
    }
  }
  pop(): number {
    const ids = this.ids, pr = this.pr;
    const top = ids[0];
    const lastId = ids.pop()!, lastP = pr.pop()!;
    if (ids.length) {
      ids[0] = lastId; pr[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < ids.length && pr[l] < pr[m]) m = l;
        if (r < ids.length && pr[r] < pr[m]) m = r;
        if (m === i) break;
        [ids[m], ids[i]] = [ids[i], ids[m]];
        [pr[m], pr[i]] = [pr[i], pr[m]];
        i = m;
      }
    }
    return top;
  }
}
