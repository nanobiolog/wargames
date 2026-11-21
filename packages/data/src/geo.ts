// Loaders for generated geo assets (the GUI imports the JSON files directly via Vite).
// In Node they are read from packages/data/geo. Other runtimes (Cloudflare Workers) bundle the JSON
// and register it with setGeoSource() before the engine starts.

/** Node built-ins without a static import, so bundlers for other runtimes never see node:fs. */
function builtin<T>(name: string): T {
  const p = (globalThis as { process?: { getBuiltinModule?: (n: string) => unknown } }).process;
  const m = p?.getBuiltinModule?.(name);
  if (!m) throw new Error(`geo data: ${name} unavailable here — call setGeoSource() first`);
  return m as T;
}

/** layer name → list of flat polylines [lon,lat,lon,lat,...] */
export type GeoLayers = Record<string, number[][]>;
/** [name, lat, lon, rank, countryA3] */
export type Place = [string, number, number, number, string];

type Source = (name: string) => unknown;
let source: Source | null = null;
const cache = new Map<string, unknown>();

/** Provide geo JSON without a filesystem, e.g. setGeoSource({ 'landmask.json': mask, 'places.json': places }). */
export function setGeoSource(files: Record<string, unknown> | Source) {
  source = typeof files === 'function' ? files : (name) => files[name];
  cache.clear();
}

/** Directory with the generated geo JSON (Node only). */
export function geoDir(): string {
  const { dirname, join } = builtin<typeof import('node:path')>('node:path');
  const { fileURLToPath } = builtin<typeof import('node:url')>('node:url');
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'geo');
}

function readJson<T>(name: string): T {
  if (cache.has(name)) return cache.get(name) as T;
  let v: unknown = source?.(name);
  if (v === undefined) {
    const { readFileSync, existsSync } = builtin<typeof import('node:fs')>('node:fs');
    const { join } = builtin<typeof import('node:path')>('node:path');
    const file = join(geoDir(), name);
    if (!existsSync(file)) throw new Error(`Missing ${file}. Run "npm run geo" first.`);
    v = JSON.parse(readFileSync(file, 'utf8'));
  }
  cache.set(name, v);
  return v as T;
}

export function loadGeo(lod: 0 | 1 | 2): GeoLayers {
  return readJson<GeoLayers>(`lod${lod}.json`);
}

export function loadPlaces(): Place[] {
  return readJson<Place[]>('places.json');
}

/** Land mask: 0.25° grid, row 0 = 90N, col 0 = 180W. */
export interface LandMask {
  w: number;
  h: number;
  res: number;
  bits: Uint8Array;
  isLand(lat: number, lon: number): boolean;
}

function b64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function loadLandMask(): LandMask {
  const raw = readJson<{ w: number; h: number; res: number; data: string }>('landmask.json');
  const bits = b64(raw.data);
  const { w, h, res } = raw;
  return {
    w, h, res, bits,
    isLand(lat, lon) {
      const r = Math.min(h - 1, Math.max(0, Math.floor((90 - lat) / res)));
      let c = Math.floor((lon + 180) / res) % w;
      if (c < 0) c += w;
      const i = r * w + c;
      return (bits[i >> 3] & (1 << (i & 7))) !== 0;
    },
  };
}
