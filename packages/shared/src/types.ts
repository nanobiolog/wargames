import type { LatLon } from './geo.ts';

/**
 * A faction id: 'USA' and 'USSR' in the 1983 scenario, 'USA' | 'RUS' | 'CHN' | … in modern ones.
 * (Kept under the old name `Side` so commands, saves and links are unchanged.)
 */
export type Side = string;
export type Role = Side | 'SPECTATOR';
/** Factions of the classic scenario (legacy helpers for two-player code paths). */
export const SIDES: Side[] = ['USA', 'USSR'];
/** Legacy two-faction helper; scenario-aware code uses hostilesOf(world, side). */
export const enemyOf = (s: Side): Side => (s === 'USA' ? 'USSR' : 'USA');

export type Stance = 'allied' | 'neutral' | 'hostile';

/** What clients need to know about a faction (sent in StaticWorld). */
export interface FactionInfo {
  id: Side;
  /** full name, e.g. "UNITED STATES" */
  name: string;
  /** short label for HUDs, e.g. "USA" */
  short: string;
  /** map colour (#rrggbb) */
  color: string;
  /** can a human take this seat */
  playable: boolean;
  /** one line on who they are and what they want */
  brief: string;
}

/** Full scenario faction definition (data package). */
export interface FactionDef extends FactionInfo {
  /** seconds until early-warning satellites report a launch, and the chance they do */
  satDelaySec: number;
  satDetectP: number;
  /** default bomber holding point: this far toward `aim` */
  failSafe: { aim: LatLon; km: number };
  /** end-of-game reason when this faction's command is destroyed */
  defeatText: string;
}

export interface ScenarioDef {
  id: string;
  /** shown in HUDs, e.g. "1983 AUTUMN EXERCISE" */
  name: string;
  /** lobby description */
  summary: string;
  /** scenario clock 0, epoch ms */
  startEpoch: number;
  timeLimitSec: number;
  factions: FactionDef[];
  /** pairs not listed are neutral */
  relations: [Side, Side, Stance][];
  /** [host default, opponent default] for two-player matches */
  defaultSides: [Side, Side];
  intro: string[];
  incidents: { text: string; tension: number }[];
  units(): Unit[];
  cities(): City[];
  seaAreas: { name: string; lat: number; lon: number }[];
}

/** relation lookup over a StaticWorld (or anything carrying `relations`) */
export function stanceOf(world: { relations?: [Side, Side, Stance][] } | undefined, a: Side, b: Side): Stance {
  if (a === b) return 'allied';
  if (!world?.relations) return 'hostile'; // classic two-player default
  for (const [x, y, st] of world.relations) if ((x === a && y === b) || (x === b && y === a)) return st;
  return 'neutral';
}

/** Factions hostile to `side`. Falls back to the classic USA/USSR pair. */
export function hostilesOf(world: { factions?: FactionInfo[]; relations?: [Side, Side, Stance][] } | undefined, side: Side): Side[] {
  if (!world?.factions?.length) return [enemyOf(side)];
  return world.factions.filter((f) => f.id !== side && stanceOf(world, side, f.id) === 'hostile').map((f) => f.id);
}

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
  | 'ssn' // attack submarine
  | 'flight' // airborne fighter / recon / strike flight, ISR drone or attack-drone swarm
  | 'satellite'; // reconnaissance satellite in orbit (moves on its ground track, sees a swath below it)

export const MOBILE_KINDS: UnitKind[] = ['bomber', 'carrier', 'ssbn', 'ssn', 'flight'];

/** Air missions flown from carriers and fighter bases. */
export type AirMission = 'recon' | 'cap' | 'strike' | 'drone' | 'swarm';

/** Command branches a nation can be split into between several players. */
export type Branch = 'commander' | 'navy' | 'air' | 'rocket';
export const BRANCHES: Branch[] = ['commander', 'navy', 'air', 'rocket'];
export const BRANCH_LABEL: Record<Branch, string> = { commander: 'COMMANDER', navy: 'NAVY', air: 'AIR FORCE', rocket: 'ROCKET FORCES' };

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
  // air flights
  mission?: AirMission;
  /** recon flights: leave the search area at this game time */
  loiterUntil?: number;
  /** drones available at a base / carrier */
  drones?: number;
  /** conventional cruise missiles aboard (surface groups, attack submarines) */
  cruise?: number;
  cruiseRangeKm?: number;
  /** satellites: circular orbit and the width of ground they see */
  orbit?: { incDeg: number; periodSec: number; raanDeg: number; phaseDeg: number };
  swathKm?: number;
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

export type MissileType = 'ICBM' | 'SLBM' | 'ABM' | 'CRUISE';

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
  /** owning faction, or 'OTHER' for cities outside every faction */
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
  /** nations that are out of the war (eliminated or resigned); their players watch */
  out?: Side[];
  /** milestones already announced in open-ended games (crisis defused, scenario time reached) */
  milestones?: string[];
  threat: { inbound: number; impacts: number; bombers: number; subs: number };
}

export interface StaticWorld {
  cities: City[];
  seaAreas: { name: string; lat: number; lon: number }[];
  scenario: string;
  /** scenario id ('1983', 'modern') */
  scenarioId?: string;
  factions?: FactionInfo[];
  relations?: [Side, Side, Stance][];
}
