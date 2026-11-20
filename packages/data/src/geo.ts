// Node-side loaders for generated geo assets (the GUI imports the JSON files directly via Vite).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GEO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'geo');

/** layer name → list of flat polylines [lon,lat,lon,lat,...] */
export type GeoLayers = Record<string, number[][]>;
/** [name, lat, lon, rank, countryA3] */
export type Place = [string, number, number, number, string];

const cache = new Map<string, unknown>();
function readJson<T>(name: string): T {
  if (cache.has(name)) return cache.get(name) as T;
  const file = join(GEO_DIR, name);
  if (!existsSync(file)) throw new Error(`Missing ${file}. Run "npm run geo" first.`);
  const v = JSON.parse(readFileSync(file, 'utf8')) as T;
  cache.set(name, v);
  return v;
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

export function loadLandMask(): LandMask {
  const raw = readJson<{ w: number; h: number; res: number; data: string }>('landmask.json');
  const bits = Uint8Array.from(Buffer.from(raw.data, 'base64'));
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
