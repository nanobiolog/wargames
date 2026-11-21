// Ocean routing for ships and submarines: A* on a 0.25° water grid derived from the land mask.
// Only water connected to the open ocean is navigable (no inland lakes), plus hand-opened straits.
import type { LandMask } from '@coldlaunch/data';
import type { LatLon } from '@coldlaunch/shared';
import { distKm } from '@coldlaunch/shared';

const D2R = Math.PI / 180;
const EARTH_KM = 6371;
/** Slightly inflated heuristic: explores far fewer cells; string-pulling hides the small detour. */
const H_WEIGHT = 1.2;

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
   * simplified to a handful of turning points. null if unreachable. Runs to completion;
   * the game uses `plan()` instead so long searches are spread across ticks.
   */
  route(a: LatLon, b: LatLon): LatLon[] | null {
    const job = this.plan(a, b);
    if (!(job instanceof RouteJob)) return job;
    let r: LatLon[] | null | undefined;
    while ((r = job.run(Infinity)) === undefined);
    return r;
  }

  /**
   * Start a route search. Trivial cases (straight line of sight, unreachable) resolve immediately;
   * otherwise returns a RouteJob to advance with run(budget). Budgets count expanded cells, not
   * wall-clock time, so a sliced search finishes on the same tick on every machine (determinism).
   */
  plan(a: LatLon, b: LatLon): RouteJob | LatLon[] | null {
    const s = this.nearestWet(a);
    const g = this.nearestWet(b);
    if (!s || !g) return null;
    if (this.straightClear(a, b)) return [b];
    return new RouteJob(this, a, b, s[0] * W + s[1], g[0] * W + g[1]);
  }

  /** Waypoints from the finished search state (string-pulled). */
  /** @internal */ finish(a: LatLon, b: LatLon, goal: number): LatLon[] {
    const came = this.came!;
    const cells: LatLon[] = [];
    for (let i = goal; i !== -1; i = came[i]) cells.push(this.center(Math.floor(i / W), i % W));
    cells.reverse();
    // String-pull in linear time. Pass 1 walks forward and keeps a cell only when the line of sight
    // from the last kept point breaks (checks are spaced every few cells, then refined). Pass 2 drops
    // any kept point whose neighbours can see each other. The old farthest-first scan was O(n²)
    // line-of-sight checks and took up to ~90 ms on ocean-crossing routes.
    const pts: LatLon[] = [a];
    let k = 0;
    while (k < cells.length - 1) {
      const anchor = pts[pts.length - 1];
      let lo = k, step = 8;
      // gallop forward while visible
      while (lo + step < cells.length && this.straightClear(anchor, cells[lo + step])) { lo += step; step *= 2; }
      let hi = Math.min(cells.length - 1, lo + step);
      if (lo === hi || this.straightClear(anchor, cells[hi])) { lo = hi; }
      else {
        // narrow down between the last visible (lo) and first blocked (hi) sample
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (this.straightClear(anchor, cells[mid])) lo = mid; else hi = mid;
        }
      }
      if (lo === k && k > 0 && pts[pts.length - 1] === cells[k]) lo = k + 1; // always make progress
      pts.push(cells[lo]);
      k = lo === k ? k + 1 : lo;
    }
    pts.push(b);
    const out: LatLon[] = [];
    let prev = a;
    for (let i = 1; i < pts.length; i++) {
      const next = pts[i + 1];
      if (next && i < pts.length - 1 && this.straightClear(prev, next)) continue;
      if (pts[i] !== prev) out.push(pts[i]);
      prev = pts[i];
    }
    if (out[out.length - 1] !== b) out.push(b);
    return out;
  }

  // ---- A* scratch buffers, shared by every job in the process (allocating and filling 1M-cell
  // arrays per route was most of the old cost). `stamp` marks cells touched by the current search;
  // `owner` says which job the buffers currently hold. Only one search is live at a time.
  private gScore?: Float32Array;
  private came?: Int32Array;
  private stamp?: Uint32Array;
  private closedStamp?: Uint32Array;
  private gen = 0;
  private heap = new MinHeap();
  private goalTrig = [0, 0, 0];
  /** @internal */ owner: RouteJob | null = null;
  // per-row trig tables: step costs depend only on the row and the direction
  private static rowSin = Float64Array.from({ length: H }, (_, r) => Math.sin((90 - (r + 0.5) * RES) * D2R));
  private static rowCos = Float64Array.from({ length: H }, (_, r) => Math.cos((90 - (r + 0.5) * RES) * D2R));
  private static colLon = Float64Array.from({ length: W }, (_, c) => (-180 + (c + 0.5) * RES) * D2R);
  /** stepCost[r*9 + (dr+1)*3 + (dc+1)] = km from row r centre to the neighbour */
  private static stepCost = (() => {
    const t = new Float32Array(H * 9);
    for (let r = 0; r < H; r++) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = Math.min(H - 1, Math.max(0, r + dr));
          t[r * 9 + (dr + 1) * 3 + dc + 1] = distKm(
            { lat: 90 - (r + 0.5) * RES, lon: 0 }, { lat: 90 - (nr + 0.5) * RES, lon: dc * RES },
          );
        }
      }
    }
    return t;
  })();

  /** Great-circle km from cell i to the goal (spherical law of cosines on precomputed trig). */
  private hKm(i: number) {
    const r = (i / W) | 0, c = i - r * W;
    const [gs, gc, glon] = this.goalTrig;
    const x = OceanNav.rowSin[r] * gs + OceanNav.rowCos[r] * gc * Math.cos(OceanNav.colLon[c] - glon);
    return EARTH_KM * Math.acos(x > 1 ? 1 : x < -1 ? -1 : x) * H_WEIGHT;
  }

  /** @internal reset the shared buffers for a new search */
  begin(start: number, goal: number) {
    const N = W * H;
    if (!this.gScore) {
      this.gScore = new Float32Array(N);
      this.came = new Int32Array(N);
      this.stamp = new Uint32Array(N);
      this.closedStamp = new Uint32Array(N);
    }
    const gen = ++this.gen;
    this.heap.clear();
    const gr = (goal / W) | 0, gcol = goal - gr * W;
    this.goalTrig = [OceanNav.rowSin[gr], OceanNav.rowCos[gr], OceanNav.colLon[gcol]];
    this.stamp![start] = gen; this.gScore[start] = 0; this.came![start] = -1;
    this.heap.push(start, this.hKm(start));
  }

  /** @internal expand up to `budget` cells: true = found, false = unreachable, undefined = budget used */
  expand(goal: number, budget: number): { result: boolean | undefined; used: number } {
    const gScore = this.gScore!, came = this.came!, stamp = this.stamp!, closed = this.closedStamp!;
    const water = this.water, stepCost = OceanNav.stepCost, heap = this.heap, gen = this.gen;
    let used = 0;
    while (heap.size) {
      if (used >= budget) return { result: undefined, used };
      const cur = heap.pop();
      if (cur === goal) return { result: true, used };
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      used++;
      const r = (cur / W) | 0, c = cur - r * W;
      const gCur = gScore[cur];
      for (let dr = -1; dr <= 1; dr++) {
        const nr = r + dr;
        if (nr < 0 || nr >= H) continue;
        const rowBase = nr * W;
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          let nc = c + dc;
          if (nc < 0) nc += W; else if (nc >= W) nc -= W;
          const ni = rowBase + nc;
          if (!water[ni] || closed[ni] === gen) continue;
          const ng = gCur + stepCost[r * 9 + (dr + 1) * 3 + dc + 1];
          if (stamp[ni] !== gen || ng < gScore[ni]) {
            stamp[ni] = gen;
            gScore[ni] = ng;
            came[ni] = cur;
            heap.push(ni, ng + this.hKm(ni));
          }
        }
      }
    }
    return { result: false, used };
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

/**
 * A resumable ocean-route search. `run(budget)` returns the waypoints, null (no route) or
 * undefined (not finished yet). `spent` (cells expanded so far) is all that needs saving: a job
 * resumed after a save/load or after another job used the shared buffers replays to the same point.
 */
export class RouteJob {
  spent = 0;
  constructor(private nav: OceanNav, readonly from: LatLon, readonly to: LatLon, private start: number, private goal: number) {}

  run(budget: number): LatLon[] | null | undefined {
    const nav = this.nav;
    if (nav.owner !== this) {
      nav.owner = this;
      nav.begin(this.start, this.goal);
      if (this.spent > 0) {
        const replay = nav.expand(this.goal, this.spent);
        if (replay.result !== undefined) return this.done(replay.result);
      }
    }
    const { result, used } = nav.expand(this.goal, budget);
    this.spent += used;
    return result === undefined ? undefined : this.done(result);
  }

  private done(found: boolean) {
    this.nav.owner = null;
    return found ? this.nav.finish(this.from, this.to, this.goal) : null;
  }
}

class MinHeap {
  private ids = new Int32Array(1 << 16);
  private pr = new Float64Array(1 << 16);
  size = 0;
  clear() { this.size = 0; }
  push(id: number, p: number) {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.size * 2); ids.set(this.ids); this.ids = ids;
      const pr = new Float64Array(this.size * 2); pr.set(this.pr); this.pr = pr;
    }
    const ids = this.ids, pr = this.pr;
    let i = this.size++;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (pr[par] <= p) break;
      ids[i] = ids[par]; pr[i] = pr[par];
      i = par;
    }
    ids[i] = id; pr[i] = p;
  }
  pop(): number {
    const ids = this.ids, pr = this.pr;
    const top = ids[0];
    const n = --this.size;
    if (n > 0) {
      const id = ids[n], p = pr[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const m = l + 1 < n && pr[l + 1] < pr[l] ? l + 1 : l;
        if (pr[m] >= p) break;
        ids[i] = ids[m]; pr[i] = pr[m];
        i = m;
      }
      ids[i] = id; pr[i] = p;
    }
    return top;
  }
}
