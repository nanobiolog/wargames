import type { LatLon } from './geo.ts';

export type Side = 'USA' | 'USSR';
export type Role = Side | 'SPECTATOR';
export const SIDES: Side[] = ['USA', 'USSR'];
export const enemyOf = (s: Side): Side => (s === 'USA' ? 'USSR' : 'USA');

export type UnitKind =
  | 'silo' // ICBM field
  | 'airbase' // bomber base (hosts bombers + tankers)
  | 'afb_int' // interceptor / air-defence base
  | 'bomber' // airborne bomber group
  | 'radar' // early warning radar
  | 'abm' // anti-ballistic missile site
  | 'command' // national command post
  | 'navalbase'
  | 'carrier' // carrier / surface action group
  | 'ssbn' // ballistic missile submarine
  | 'ssn'; // attack submarine

export const MOBILE_KINDS: UnitKind[] = ['bomber', 'carrier', 'ssbn', 'ssn'];

export type UnitStatus =
  | 'ready'
  | 'alert'
  | 'moving'
  | 'patrol'
  | 'orbit' // bomber holding at fail-safe point
  | 'enroute' // bomber with go-code
  | 'returning'
  | 'destroyed'
  | 'damaged';

export interface Unit extends LatLon {
  id: string;
  name: string;
  side: Side;
  kind: UnitKind;
  cls: string; // e.g. "MINUTEMAN III", "B-52G", "OHIO"
  status: UnitStatus;
  hp: number; // 0..1
  // weapons
  missiles?: number;
  warheads?: number; // per missile
  yieldKt?: number; // per warhead
  rangeKm?: number;
  // aircraft
  aircraft?: number; // bombers available (base) or in group
  tankers?: number;
  interceptors?: number;
  bombs?: number; // per aircraft
  fuel?: number; // 0..1 remaining for airborne groups
  // sensors / defence
  radarKm?: number;
  defenceKm?: number;
  // movement
  speedKmh?: number;
  dest?: LatLon | null;
  target?: string | null; // target ref for bombers
  targetPos?: LatLon | null;
  home?: string; // base id
  heading?: number;
  submerged?: boolean;
  route?: LatLon[]; // remaining waypoints (ships)
  missilesMax?: number;
  revealedUntil?: number; // subs: visible to enemy after launching
}

/** What the other side knows about one of your units. */
export interface Contact extends LatLon {
  id: string;
  side: Side;
  kind: UnitKind;
  name: string; // real name when identified, otherwise "UNK 5663"
  cls: string;
  status: UnitStatus;
  identified: boolean;
  seenT: number; // game time of last sighting
  heading?: number;
  hp?: number;
}

export type MissileType = 'ICBM' | 'SLBM' | 'ABM';

export interface Missile {
  id: string;
  side: Side;
  type: MissileType;
  from: LatLon;
  to: LatLon;
  launchT: number;
  impactT: number;
  apexKm: number;
  warheads: number;
  yieldKt: number;
  source: string; // unit id
  target: string; // display name
  targetId?: string;
  detected?: boolean; // as seen by the viewer
  confirmed?: boolean; // radar-confirmed (vs satellite-only)
  intercepted?: number; // warheads intercepted by ABM
}

export interface Detonation extends LatLon {
  id: string;
  t: number;
  side: Side; // attacker
  yieldKt: number;
  target: string;
  killed: number;
}

export type EventKind =
  | 'info'
  | 'warn'
  | 'alert'
  | 'launch'
  | 'detect'
  | 'impact'
  | 'intercept'
  | 'destroyed'
  | 'defcon'
  | 'hotline'
  | 'ai'
  | 'end';

export interface GameEvent {
  t: number;
  kind: EventKind;
  side?: Side; // which side the event concerns (for fog filtering) — undefined = public
  visibleTo?: Side[]; // explicit visibility list
  text: string;
  lat?: number;
  lon?: number;
  from?: Side; // hotline sender
}

export interface City extends LatLon {
  id: string;
  name: string;
  side: Side | 'OTHER';
  pop: number; // thousands
  killed: number; // thousands
}

export interface SideScore {
  popStart: number; // thousands
  killed: number; // thousands
  warheadsLaunched: number;
  forcesLost: number;
  forcesStart: number;
}

export interface AiStatus {
  provider: string;
  model: string;
  thinking: boolean;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  lastError?: string;
  lastNote?: string;
}

export interface Snapshot {
  t: number; // game seconds since start
  startEpoch: number; // epoch ms of scenario clock 0 (for HH:MM:SS display)
  speed: number;
  paused: boolean;
  viewer: Role;
  defcon: Record<Side, number>; // own exact; enemy = intel estimate
  tension: number; // 0..100
  units: Unit[]; // own units (all units for spectator)
  contacts: Contact[]; // known enemy units
  missiles: Missile[];
  detonations: Detonation[];
  cities: { id: string; killed: number }[];
  score: Record<Side, SideScore>;
  ai: Partial<Record<Side, AiStatus>>;
  over: null | { winner: Side | 'NONE'; reason: string };
  threat: { inbound: number; impacts: number; bombers: number; subs: number };
}

export interface StaticWorld {
  cities: City[];
  seaAreas: { name: string; lat: number; lon: number }[];
  scenario: string;
}
