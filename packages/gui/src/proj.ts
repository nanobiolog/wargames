// CPU twin of the vertex-shader projection (used for culling, labels and picking).

export type ProjKind = 'equirect' | 'polar';

export interface View {
  proj: ProjKind;
  lat: number;
  lon: number;
  zoom: number;
  polarLon0: number;
}

export interface Xform {
  kind: 0 | 1;
  lon0: number;
  cx: number;
  cy: number;
  kx: number;
  ky: number;
  w: number;
  h: number;
}

export function fitScale(v: View, w: number, h: number) {
  return v.proj === 'polar' ? Math.min(w, h) / 140 : Math.min(w / 360, h / 165);
}

export function xform(v: View, w: number, h: number): Xform {
  const s = fitScale(v, w, h) * v.zoom;
  if (v.proj === 'polar') {
    const [x, y] = planePolar(v.lat, v.lon, v.polarLon0);
    return { kind: 1, lon0: v.polarLon0, cx: x, cy: y, kx: s, ky: s, w, h };
  }
  const t = Math.max(0, Math.min(1, (v.zoom - 1.5) / 4));
  const lat = Math.max(-70, Math.min(70, v.lat));
  const kx = s * (1 - t + t * Math.cos((lat * Math.PI) / 180));
  return { kind: 0, lon0: v.lon, cx: 0, cy: -v.lat, kx, ky: s, w, h };
}

function planePolar(lat: number, lon: number, lon0: number): [number, number] {
  const r = 90 - lat;
  const th = ((lon - lon0) * Math.PI) / 180;
  return [r * Math.sin(th), r * Math.cos(th)];
}

export function plane(x: Xform, lat: number, lon: number): [number, number] {
  if (x.kind === 1) return planePolar(lat, lon, x.lon0);
  let d = lon - x.lon0;
  d = d - 360 * Math.floor((d + 180) / 360);
  return [d, -lat];
}

/** lat/lon → viewport pixels (null when not drawable). */
export function toScreen(x: Xform, lat: number, lon: number): [number, number] | null {
  if (x.kind === 1 && lat < -30) return null;
  const [px, py] = plane(x, lat, lon);
  return [x.w / 2 + (px - x.cx) * x.kx, x.h / 2 + (py - x.cy) * x.ky];
}

export function fromScreen(x: Xform, sx: number, sy: number): { lat: number; lon: number } {
  const X = (sx - x.w / 2) / x.kx + x.cx;
  const Y = (sy - x.h / 2) / x.ky + x.cy;
  if (x.kind === 1) {
    const r = Math.hypot(X, Y);
    let lon = (Math.atan2(X, Y) * 180) / Math.PI + x.lon0;
    lon = lon - 360 * Math.floor((lon + 180) / 360);
    return { lat: Math.max(-89, 90 - r), lon };
  }
  let lon = X + x.lon0;
  lon = lon - 360 * Math.floor((lon + 180) / 360);
  return { lat: Math.max(-89, Math.min(89, -Y)), lon };
}

/** Visible span (degrees of longitude at the centre) — drives LOD + label density. */
export function spanDeg(x: Xform) {
  return x.w / x.kx;
}

/** lat/lon bounds of the view (equirect) for bucket culling; null = everything. */
export function viewBounds(x: Xform): { lat0: number; lat1: number; lon0: number; lon1: number } | null {
  if (x.kind === 1) {
    const r = Math.hypot(x.w, x.h) / 2 / x.kx + Math.hypot(x.cx, x.cy);
    return { lat0: Math.max(-90, 90 - r), lat1: 90, lon0: -180, lon1: 180 };
  }
  const hw = x.w / 2 / x.kx + 1, hh = x.h / 2 / x.ky + 1;
  return { lat0: -x.cy - hh, lat1: -x.cy + hh, lon0: x.lon0 - hw, lon1: x.lon0 + hw };
}
