// Human-readable detail lines for a selected unit, contact or missile (distance, speed, ETA, fuel …).
// Shared by the terminal, the display info card and the in-display console.
import { distKm, ballisticPos, fmtLatLon, type LatLon } from './geo.ts';
import { KIND_LABEL } from './rules.ts';
import type { Contact, Missile, Snapshot, Unit } from './types.ts';

export interface DetailLine {
  label: string;
  value: string;
  tone?: 'warn' | 'bad' | 'good' | 'dim';
}

const KNOT = 1.852;

/** mm:ss or h:mm:ss for a duration in seconds. */
export function fmtDuration(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const clock = (snap: Snapshot, t: number) => new Date(snap.startEpoch + t * 1000).toISOString().slice(11, 16) + 'Z';

/** Arrival line: game time of arrival + how long that takes in real time at the current time compression. */
function eta(snap: Snapshot, gameSec: number): string {
  const real = snap.paused ? 'paused' : `${fmtDuration(gameSec / Math.max(0.5, snap.speed))} real`;
  const days = Math.floor((snap.startEpoch + (snap.t + gameSec) * 1000) / 86400000) - Math.floor((snap.startEpoch + snap.t * 1000) / 86400000);
  return `${fmtDuration(gameSec)} → ${clock(snap, snap.t + gameSec)}${days > 0 ? ` +${days}d` : ''}  (${real})`;
}

function routeKm(u: LatLon, route: LatLon[] | undefined, dest: LatLon | null | undefined): number {
  if (route?.length) {
    let d = 0, p: LatLon = u;
    for (const q of route) { d += distKm(p, q); p = q; }
    return d;
  }
  return dest ? distKm(u, dest) : 0;
}

const STATUS_TEXT: Record<string, string> = {
  ready: 'READY', alert: 'ALERT', moving: 'UNDERWAY', patrol: 'ON STATION', orbit: 'HOLDING AT FAIL-SAFE', enroute: 'ATTACKING',
  returning: 'RETURNING', destroyed: 'DESTROYED', damaged: 'DAMAGED',
};

export function unitDetails(u: Unit | Contact, snap: Snapshot): DetailLine[] {
  const x = u as Unit;
  const out: DetailLine[] = [];
  const isContact = 'seenT' in u;
  out.push({ label: 'TYPE', value: `${KIND_LABEL[u.kind]} · ${u.cls}` });
  out.push({ label: 'STATUS', value: `${u.side} · ${STATUS_TEXT[u.status] ?? u.status.toUpperCase()}`, tone: u.status === 'destroyed' ? 'bad' : u.status === 'enroute' ? 'warn' : undefined });
  out.push({ label: 'POSITION', value: `${fmtLatLon(u)}${u.heading !== undefined && (x.dest || u.kind === 'bomber') ? `  HDG ${String(Math.round(u.heading)).padStart(3, '0')}°` : ''}` });
  if (isContact) {
    const c = u as Contact;
    out.push({ label: 'INTEL', value: `${c.identified ? 'IDENTIFIED' : 'UNIDENTIFIED'} · last seen ${fmtDuration(snap.t - c.seenT)} ago`, tone: 'dim' });
    if (c.kind === 'bomber' || c.kind === 'carrier') {
      out.push({ label: 'NOTE', value: 'speed and destination unknown (enemy unit)', tone: 'dim' });
    }
  }
  if (x.missiles !== undefined) {
    out.push({ label: 'MISSILES', value: `${x.missiles}${x.missilesMax ? `/${x.missilesMax}` : ''} × ${x.warheads ?? 1} RV × ${x.yieldKt} KT` });
    if (x.rangeKm) out.push({ label: 'RANGE', value: `${x.rangeKm.toLocaleString('en-US')} KM` });
  }
  if (x.aircraft !== undefined && u.kind !== 'bomber') out.push({ label: 'AIRCRAFT', value: `${x.aircraft} × ${x.bombs ?? 0} weapons${x.tankers !== undefined ? ` · ${x.tankers} tankers` : ''}` });
  if (x.interceptors !== undefined) out.push({ label: 'INTERCEPTORS', value: `${x.interceptors}${x.defenceKm ? ` · radius ${x.defenceKm} KM` : ''}` });
  if (x.radarKm) out.push({ label: 'RADAR', value: `${x.radarKm.toLocaleString('en-US')} KM` });

  const speed = x.speedKmh ?? 0;
  if (u.kind === 'bomber' && !isContact) {
    out.push({ label: 'GROUP', value: `${x.aircraft} × ${u.cls} · ${x.bombs ?? 0} weapons each × ${x.yieldKt} KT` });
    const fuel = x.fuel ?? 0;
    const reach = fuel * (x.rangeKm ?? 12000);
    out.push({ label: 'FUEL', value: `${Math.round(fuel * 100)}% · ~${Math.round(reach).toLocaleString('en-US')} KM left${x.tankers ? ` · ${x.tankers} tanker` : ''}`, tone: fuel < 0.25 ? 'bad' : fuel < 0.45 ? 'warn' : undefined });
    if (u.status === 'orbit') {
      const holdH = (fuel * (x.rangeKm ?? 12000)) / (0.35 * Math.max(1, speed));
      out.push({ label: 'ENDURANCE', value: `~${fmtDuration(holdH * 3600)} holding before bingo fuel` });
    }
  }
  if (!isContact && x.dest && speed > 0 && u.status !== 'destroyed') {
    const km = routeKm(u, x.route, x.dest);
    out.push({ label: 'SPEED', value: u.kind === 'bomber' ? `${speed} KM/H` : `${Math.round(speed / KNOT)} KN (${speed} KM/H)` });
    out.push({ label: x.target ? 'TO TARGET' : 'REMAINING', value: `${Math.round(km).toLocaleString('en-US')} KM${x.target ? ` → ${x.target}` : ''}` });
    out.push({ label: 'ETA', value: eta(snap, (km / speed) * 3600) });
  } else if (!isContact && speed > 0 && u.status !== 'destroyed') {
    out.push({ label: 'SPEED', value: `stationary · max ${u.kind === 'bomber' ? `${speed} KM/H` : `${Math.round(speed / KNOT)} KN`}`, tone: 'dim' });
  }
  return out;
}

export function missileDetails(m: Missile, snap: Snapshot): DetailLine[] {
  const now = snap.t;
  const pos = ballisticPos(m.from, m.to, m.launchT, m.impactT, m.apexKm, now);
  const total = distKm(m.from, m.to);
  const flight = Math.max(1, m.impactT - m.launchT);
  const remainKm = total * (1 - pos.f);
  const avgKms = total / flight;
  const phase = m.type === 'ABM' ? 'INTERCEPT' : pos.f < 0.12 ? 'BOOST' : pos.f < 0.82 ? 'MIDCOURSE' : 'TERMINAL / RE-ENTRY';
  const out: DetailLine[] = [
    { label: 'TRACK', value: `${m.id.toUpperCase()} · ${m.type} · ${m.side}`, tone: m.side === snap.viewer ? undefined : 'bad' },
    { label: 'TARGET', value: m.target },
    { label: 'PHASE', value: `${phase} · ${Math.round(pos.f * 100)}% of flight` },
    { label: 'ALTITUDE', value: `${Math.round(pos.alt).toLocaleString('en-US')} KM (apex ${Math.round(m.apexKm)} KM)` },
    { label: 'SPEED', value: `${avgKms.toFixed(1)} KM/S ground · ≈ MACH ${Math.round(avgKms / 0.343)}` },
    { label: 'REMAINING', value: `${Math.round(remainKm).toLocaleString('en-US')} of ${Math.round(total).toLocaleString('en-US')} KM` },
    { label: 'IMPACT IN', value: eta(snap, m.impactT - now), tone: m.side === snap.viewer ? undefined : 'bad' },
  ];
  if (m.type !== 'ABM') out.push({ label: 'PAYLOAD', value: `${m.warheads} × ${m.yieldKt >= 1000 ? `${(m.yieldKt / 1000).toFixed(1)} MT` : `${m.yieldKt} KT`}${m.intercepted ? ` · ${m.intercepted} intercepted` : ''}` });
  out.push({ label: 'LAUNCHED', value: `${clock(snap, m.launchT)} from ${fmtLatLon(m.from)}` });
  if (m.side !== snap.viewer) out.push({ label: 'TRACKING', value: m.confirmed === false ? 'SATELLITE ONLY — UNCONFIRMED (possible false alarm)' : 'RADAR CONFIRMED', tone: m.confirmed === false ? 'warn' : 'bad' });
  return out;
}

/** Details for whatever id is selected (unit, contact or missile). */
export function selectionDetails(id: string, snap: Snapshot): { title: string; lines: DetailLine[] } | null {
  const m = snap.missiles.find((x) => x.id === id);
  if (m) return { title: `${m.type} → ${m.target}`, lines: missileDetails(m, snap) };
  const u = snap.units.find((x) => x.id === id) ?? snap.contacts.find((x) => x.id === id);
  if (u) return { title: `${u.name} [${u.id.toUpperCase()}]`, lines: unitDetails(u, snap) };
  return null;
}
