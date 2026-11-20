// Loads the Natural Earth LOD files and uploads them as bucketed GPU segment buffers.
import { LAT_BANDS, LON_BANDS, type GeoBuffer, type Renderer } from './gl.ts';
import type { Xform } from './proj.ts';
import { viewBounds } from './proj.ts';

export type LodLayers = Record<string, GeoBuffer>;

const bucketOf = (lon: number, lat: number) => {
  const lb = Math.min(LAT_BANDS - 1, Math.max(0, Math.floor((lat + 90) / 10)));
  const ob = Math.min(LON_BANDS - 1, Math.max(0, Math.floor((lon + 180) / 10)));
  return lb * LON_BANDS + ob;
};

export function bucketize(lines: number[][]): { segs: Float32Array; starts: Int32Array; counts: Int32Array } {
  const NB = LAT_BANDS * LON_BANDS;
  const counts = new Int32Array(NB);
  let total = 0;
  for (const l of lines) for (let k = 2; k < l.length; k += 2) { counts[bucketOf(l[k - 2], l[k - 1])]++; total++; }
  const starts = new Int32Array(NB);
  for (let b = 1; b < NB; b++) starts[b] = starts[b - 1] + counts[b - 1];
  const fill = starts.slice();
  const segs = new Float32Array(total * 4);
  for (const l of lines) {
    for (let k = 2; k < l.length; k += 2) {
      const i = fill[bucketOf(l[k - 2], l[k - 1])]++ * 4;
      segs[i] = l[k - 2]; segs[i + 1] = l[k - 1]; segs[i + 2] = l[k]; segs[i + 3] = l[k + 1];
    }
  }
  return { segs, starts, counts };
}

export class GeoStore {
  lods: (LodLayers | null)[] = [null, null, null];
  private loading: (Promise<void> | null)[] = [null, null, null];
  places: [string, number, number, number, string][] = [];

  constructor(private r: Renderer) {}

  async init() {
    await this.load(0);
    void this.load(1);
    fetch('places.json').then((r) => r.json()).then((p) => (this.places = p)).catch(() => {});
  }

  load(n: 0 | 1 | 2): Promise<void> {
    if (this.loading[n]) return this.loading[n]!;
    this.loading[n] = (async () => {
      const res = await fetch(`lod${n}.json`);
      const json = (await res.json()) as Record<string, number[][]>;
      const out: LodLayers = {};
      for (const [name, lines] of Object.entries(json)) {
        const b = bucketize(lines);
        out[name] = this.r.uploadGeo(b.segs, b.starts, b.counts);
        await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
      }
      this.lods[n] = out;
    })();
    return this.loading[n]!;
  }

  /** Best loaded LOD for a desired level (falls back to coarser while loading). */
  get(want: 0 | 1 | 2): LodLayers | null {
    if (!this.lods[want]) void this.load(want);
    for (let n = want; n >= 0; n--) if (this.lods[n]) return this.lods[n];
    return null;
  }
}

/** Contiguous instance ranges covering the visible buckets (with a one-bucket margin). */
export function visibleRanges(buf: GeoBuffer, xf: Xform): [number, number][] {
  const vb = viewBounds(xf);
  const out: [number, number][] = [];
  const latLo = Math.max(0, Math.floor(((vb?.lat0 ?? -90) + 90) / 10) - 1);
  const latHi = Math.min(LAT_BANDS - 1, Math.floor(((vb?.lat1 ?? 90) + 90) / 10) + 1);
  const span = vb ? vb.lon1 - vb.lon0 : 360;
  const pushRange = (lb: number, o0: number, o1: number) => {
    const b0 = lb * LON_BANDS + o0, b1 = lb * LON_BANDS + o1;
    const start = buf.starts[b0];
    const end = buf.starts[b1] + buf.counts[b1];
    if (end > start) out.push([start, end - start]);
  };
  for (let lb = latLo; lb <= latHi; lb++) {
    if (!vb || span >= 340) { pushRange(lb, 0, LON_BANDS - 1); continue; }
    let o0 = Math.floor((vb.lon0 + 180) / 10) - 1;
    let o1 = Math.floor((vb.lon1 + 180) / 10) + 1;
    if (o0 >= 0 && o1 < LON_BANDS) pushRange(lb, o0, o1);
    else {
      // wraps across the antimeridian
      o0 = ((o0 % LON_BANDS) + LON_BANDS) % LON_BANDS;
      o1 = ((o1 % LON_BANDS) + LON_BANDS) % LON_BANDS;
      pushRange(lb, o0, LON_BANDS - 1);
      pushRange(lb, 0, o1);
    }
  }
  return out;
}
