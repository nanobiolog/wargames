// Spherical geometry + map projections shared by engine, TUI and GUI.

export const EARTH_R = 6371; // km
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface LatLon {
  lat: number;
  lon: number;
}

export function normLon(lon: number): number {
  let l = ((lon + 180) % 360 + 360) % 360 - 180;
  if (l === -180 && lon > 0) l = 180;
  return l;
}

/** Great-circle distance in km. */
export function distKm(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing in degrees (0 = north, clockwise). */
export function bearing(a: LatLon, b: LatLon): number {
  const p1 = a.lat * D2R;
  const p2 = b.lat * D2R;
  const dl = (b.lon - a.lon) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Interpolate along the great circle, f in [0,1]. */
export function gcInterpolate(a: LatLon, b: LatLon, f: number): LatLon {
  const p1 = a.lat * D2R, l1 = a.lon * D2R;
  const p2 = b.lat * D2R, l2 = b.lon * D2R;
  const d = distKm(a, b) / EARTH_R;
  if (d < 1e-9) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return { lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * R2D, lon: Math.atan2(y, x) * R2D };
}

/** Point at distance km along bearing deg from origin. */
export function destination(a: LatLon, bearingDeg: number, km: number): LatLon {
  const d = km / EARTH_R;
  const th = bearingDeg * D2R;
  const p1 = a.lat * D2R, l1 = a.lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * R2D, lon: normLon(l2 * R2D) };
}

/** Move from a toward b by km (great circle). Returns [newPos, arrived]. */
export function stepToward(a: LatLon, b: LatLon, km: number): [LatLon, boolean] {
  const d = distKm(a, b);
  if (d <= km || d < 1e-6) return [{ lat: b.lat, lon: b.lon }, true];
  return [gcInterpolate(a, b, km / d), false];
}

/** Sample a great-circle path into n+1 points (for drawing). */
export function gcPath(a: LatLon, b: LatLon, n = 32): LatLon[] {
  const out: LatLon[] = [];
  for (let i = 0; i <= n; i++) out.push(gcInterpolate(a, b, i / n));
  return out;
}

/** Circle of radius km around center (for coverage rings). */
export function geoCircle(c: LatLon, km: number, n = 48): LatLon[] {
  const out: LatLon[] = [];
  for (let i = 0; i <= n; i++) out.push(destination(c, (i / n) * 360, km));
  return out;
}

// ---------------------------------------------------------------- projections

export type ProjectionKind = 'equirect' | 'polar';

/**
 * Projections map lat/lon to a unitless plane:
 *  - equirect: x = lon, y = -lat (degrees)
 *  - polar   : north-polar azimuthal equidistant, x/y in "degrees of arc from pole", rotated so
 *              that lon0 points down (like a planning chart centred on the Arctic).
 */
export interface Projection {
  kind: ProjectionKind;
  lon0: number; // rotation / central meridian
  project(lat: number, lon: number): [number, number];
  invert(x: number, y: number): [number, number];
}

export function makeProjection(kind: ProjectionKind, lon0 = 0): Projection {
  if (kind === 'polar') {
    return {
      kind,
      lon0,
      project(lat, lon) {
        const r = 90 - lat;
        const th = (lon - lon0) * D2R;
        return [r * Math.sin(th), r * Math.cos(th)];
      },
      invert(x, y) {
        const r = Math.sqrt(x * x + y * y);
        const lon = normLon(Math.atan2(x, y) * R2D + lon0);
        return [90 - r, lon];
      },
    };
  }
  return {
    kind,
    lon0,
    project(lat, lon) {
      return [normLon(lon - lon0), -lat];
    },
    invert(x, y) {
      return [-y, normLon(x + lon0)];
    },
  };
}

/** Parse "lat,lon" / "47.9N 97.4W" style strings. */
export function parseLatLon(s: string): LatLon | null {
  const t = s.trim().toUpperCase();
  let m = t.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const lat = +m[1], lon = +m[2];
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    return null;
  }
  m = t.match(/^(\d+(?:\.\d+)?)\s*([NS])[\s,]*(\d+(?:\.\d+)?)\s*([EW])$/);
  if (m) {
    const lat = +m[1] * (m[2] === 'S' ? -1 : 1);
    const lon = +m[3] * (m[4] === 'W' ? -1 : 1);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  return null;
}

export function fmtLatLon(p: LatLon): string {
  const la = `${Math.abs(p.lat).toFixed(1)}${p.lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(p.lon).toFixed(1)}${p.lon >= 0 ? 'E' : 'W'}`;
  return `${la} ${lo}`;
}

/**
 * Position of a ballistic missile at time t (for drawing / tracking).
 * Returns ground point and altitude in km.
 */
export function ballisticPos(
  from: LatLon,
  to: LatLon,
  launchT: number,
  impactT: number,
  apexKm: number,
  t: number,
): { p: LatLon; alt: number; f: number } {
  const f = Math.max(0, Math.min(1, (t - launchT) / Math.max(1, impactT - launchT)));
  return { p: gcInterpolate(from, to, f), alt: 4 * apexKm * f * (1 - f), f };
}
