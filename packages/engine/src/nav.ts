// Ocean routing for ships and submarines: A* on a 0.5° water grid derived from the land mask.
import type { LandMask } from '@coldlaunch/data';
import type { LatLon } from '@coldlaunch/shared';
import { distKm } from '@coldlaunch/shared';

const RES = 0.5;
const W = 720;
const H = 360;

export class OceanNav {
  private water: Uint8Array;
  constructor(private mask: LandMask) {
    this.water = new Uint8Array(W * H);
    // A 0.5° cell is navigable if any of its 4 quarter-degree sub-cells is water,
    // which keeps narrow straits (Gibraltar, Bosporus, Øresund) open.
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const lat = 90 - (r + 0.5) * RES;
        const lon = -180 + (c + 0.5) * RES;
        let wet = false;
        for (const [dy, dx] of [[-0.125, -0.125], [-0.125, 0.125], [0.125, -0.125], [0.125, 0.125]]) {
          if (!mask.isLand(lat + dy, lon + dx)) { wet = true; break; }
        }
        this.water[r * W + c] = wet ? 1 : 0;
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
    for (let rad = 0; rad < 8; rad++) {
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
    while (heap.size && iter++ < 400000) {
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
