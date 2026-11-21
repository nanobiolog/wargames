import {
  type ScenarioDef, type FactionDef, type Stance, type City, type Command, type Contact, type Detonation, type GameEvent, type LatLon, type Missile,
  type Role, type Side, type SideScore, type Snapshot, type StaticWorld, type Unit, type AiStatus,
  DEFCON_RULES, DEFCON_NAMES, distKm, bearing, destination, stepToward, parseLatLon,
  ballisticFlightSec, apexKm, softKillKm, hardKillProb, ballisticPos, fmtLatLon, describeCommand,
} from '@coldlaunch/shared';
import { getScenario, loadLandMask, loadPlaces, type Place } from '@coldlaunch/data';
import { Rng } from './rng.ts';
import { OceanNav, RouteJob } from './nav.ts';

export const TICK_SEC = 0.1; // real seconds per tick
/** Clock and time limit of the classic scenario (each scenario carries its own). */
export const SCENARIO_START = Date.UTC(1983, 10, 8, 21, 0, 0); // 8 Nov 1983 21:00Z
export const TIME_LIMIT = 8 * 3600;
/**
 * Ocean-route cells expanded per tick. Long routes (around a continent) need ~100-400k cells, so
 * they finish within a few real seconds while each tick stays under ~10 ms. Counted in cells, not
 * milliseconds, so every machine finishes the same route on the same tick.
 */
export const ROUTE_BUDGET = 8_000;

/** A ship waiting for its ocean route (persisted so saves resume mid-search). */
interface RouteRequest {
  unitId: string;
  side: Side;
  to: LatLon;
  name: string;
  spent: number;
}

interface SimMissile extends Missile {
  seenBy: Side[];
  confirmedBy: Side[];
  phantomFor?: Side;
  dropT?: number;
  abmDone?: boolean;
  spreadKm: number;
}

interface LaunchOrder {
  fireT: number;
  side: Side;
  unitId: string;
  target: Target;
  count: number;
  stagger: number;
}

export interface Target {
  pos: LatLon;
  name: string;
  unitId?: string;
  cityId?: string;
}

interface Intel {
  contacts: Record<string, Contact>; // keyed by real unit id
  alias: Record<string, string>; // real id -> UNK alias
  /** assessed DEFCON of every other faction */
  knownDefcon: Record<Side, number>;
  /** pending assessments (arrive after an intelligence delay); key = faction */
  defconPending: Record<Side, { value: number; at: number } | undefined>;
}

export interface GameState {
  /** scenario id (saves from before scenarios existed are '1983') */
  scenario?: string;
  /** faction order of this game (copied from the scenario) */
  factions?: Side[];
  /** current relations; may change during play (alliances, treaties, betrayal) */
  relations?: [Side, Side, Stance][];
  seed: number;
  rng: number;
  tick: number;
  t: number;
  speed: number;
  paused: boolean;
  defcon: Record<Side, number>;
  defconChangedT: Record<Side, number>;
  tension: number;
  units: Unit[];
  cities: City[];
  missiles: SimMissile[];
  detonations: Detonation[];
  orders: LaunchOrder[];
  intel: Record<Side, Intel>;
  events: GameEvent[];
  score: Record<Side, SideScore>;
  over: Snapshot['over'];
  nextIncidentT: number;
  nextSatPassT: number;
  hotlineCooldown: Record<Side, number>;
  counters: Record<string, number>;
  log: { tick: number; side: Side; cmd: Command }[];
  /** ships waiting for a route (FIFO; one search active at a time) */
  routeQueue?: RouteRequest[];
}

export interface CommandResult {
  ok: boolean;
  msg: string;
}

let sharedNav: OceanNav | null = null;
let sharedPlaces: Place[] | null = null;
function nav() {
  return (sharedNav ??= new OceanNav(loadLandMask()));
}
/** Build the shared ocean grid now (≈0.2-0.3 s) instead of on the first ship order. */
export function warmNav() {
  nav();
}
function places() {
  return (sharedPlaces ??= loadPlaces());
}

/** status check that TypeScript won't narrow away (units die mid-loop) */
const gone = (u: Unit) => u.status === 'destroyed';
const FIXED_LIST = ['silo', 'airbase', 'afb_int', 'radar', 'abm', 'command', 'navalbase'];
const FIXED_KINDS = new Set(FIXED_LIST);
const SHIP_KINDS = new Set(['carrier', 'ssbn', 'ssn']);

/** Air flights from carriers / fighter bases. */
const FLIGHT = {
  speed: { recon: 950, cap: 900, strike: 850 } as Record<string, number>,
  /** km of flying on a full tank (out, loiter and back) */
  rangeKm: 3200,
  maxRadiusKm: 1500,
  reconRadiusKm: 350,
  reconLoiterSec: 1200,
  capRadiusKm: 300,
  defaults: { recon: 2, cap: 4, strike: 8 } as Record<string, number>,
};
/** Surface groups exchange anti-ship missiles inside this range (DEFCON 2, contact held). */
const SURFACE_RANGE_KM = 300;
/** Coastal radars see surface ships out to this range. */
const RADAR_SEA_KM = 400;
/** Intelligence summary interval per faction (game seconds). */
const INTEL_SUMMARY_SEC = 1800;

const BOMBER_SPEED: Record<string, number> = { 'B-52G': 840, 'B-52H': 840, 'FB-111A': 1000, 'TU-95': 750, 'TU-95K': 750, 'M-4 / 3M': 800 };
const BOMBER_RANGE: Record<string, number> = { 'FB-111A': 6500 };

export class Game {
  s: GameState;
  private rng: Rng;
  private unitIdx = new Map<string, Unit>();
  /** live search for routeQueue[0] (rebuilt from `spent` after a load) */
  private routeJob?: { req: RouteRequest; job: RouteJob };
  /** Status for AI opponents, filled in by the AI driver. */
  ai: Partial<Record<Side, AiStatus>> = {};

  /** the scenario this game is playing */
  readonly sc: ScenarioDef;
  private factionIdx = new Map<Side, FactionDef>();

  constructor(seed = Date.now() % 1e9, state?: GameState, scenarioId = '1983') {
    if (state) {
      migrateState(state);
      this.s = state;
      this.sc = getScenario(state.scenario);
    } else {
      this.sc = getScenario(scenarioId);
      const sc = this.sc;
      const ids = sc.factions.map((f) => f.id);
      const per = <T>(fn: (id: Side) => T) => Object.fromEntries(ids.map((id) => [id, fn(id)])) as Record<Side, T>;
      const units = sc.units().map((u) => ({ ...u, missilesMax: u.missiles }));
      const cities = sc.cities();
      this.s = {
        scenario: sc.id, factions: ids, relations: sc.relations.map((r) => [...r] as [Side, Side, Stance]),
        seed, rng: seed, tick: 0, t: 0, speed: 10, paused: false,
        defcon: per(() => 5), defconChangedT: per(() => -1e9),
        tension: 22,
        units, cities, missiles: [], detonations: [], orders: [],
        intel: per((id) => ({ contacts: {}, alias: {}, knownDefcon: Object.fromEntries(ids.filter((o) => o !== id).map((o) => [o, 5])), defconPending: {} })),
        events: [],
        score: per((id) => this.initScore(id, units, cities)),
        over: null,
        nextIncidentT: 240,
        nextSatPassT: 60,
        hotlineCooldown: per(() => 0),
        counters: {},
        log: [],
      };
    }
    for (const f of this.sc.factions) this.factionIdx.set(f.id, f);
    this.rng = new Rng(this.s.rng);
    this.reindex();
    if (!state) {
      for (const line of this.sc.intro) this.emit({ kind: 'info', text: line });
      this.updateIntel(0);
    }
  }

  // ================================================================== factions & relations

  /** Faction ids in scenario order. */
  get factions(): Side[] {
    return this.s.factions ?? this.sc.factions.map((f) => f.id);
  }

  faction(id: Side): FactionDef | undefined {
    return this.factionIdx.get(id);
  }

  stance(a: Side, b: Side): Stance {
    if (a === b) return 'allied';
    for (const [x, y, st] of this.s.relations ?? this.sc.relations) if ((x === a && y === b) || (x === b && y === a)) return st;
    return 'neutral';
  }

  hostile(a: Side, b: Side) {
    return a !== b && this.stance(a, b) === 'hostile';
  }

  /** same faction or allied */
  friendly(a: Side, b: Side) {
    return a === b || this.stance(a, b) === 'allied';
  }

  hostilesOf(side: Side): Side[] {
    return this.factions.filter((f) => this.hostile(side, f));
  }

  alliesOf(side: Side): Side[] {
    return this.factions.filter((f) => f !== side && this.stance(side, f) === 'allied');
  }

  private initScore(side: Side, units: Unit[], cities: City[]): SideScore {
    const forces = this.forcesOf(side, units);
    return {
      popStart: cities.filter((c) => c.side === side).reduce((a, c) => a + c.pop, 0),
      killed: 0, warheadsLaunched: 0, forcesLost: 0, forcesStart: forces,
    };
  }

  /** Deliverable warheads remaining for a side. */
  forcesOf(side: Side, units = this.s.units): number {
    let n = 0;
    for (const u of units) {
      if (u.side !== side || u.status === 'destroyed') continue;
      if (u.kind === 'silo' || u.kind === 'ssbn') n += (u.missiles ?? 0) * (u.warheads ?? 1);
      if (u.kind === 'airbase' || u.kind === 'bomber') n += (u.aircraft ?? 0) * (u.bombs ?? 0);
    }
    return n;
  }

  reindex() {
    this.unitIdx.clear();
    for (const u of this.s.units) this.unitIdx.set(u.id, u);
  }

  unit(id: string) {
    return this.unitIdx.get(id);
  }

  private nextId(prefix: string) {
    this.s.counters[prefix] = (this.s.counters[prefix] ?? 0) + 1;
    return `${prefix}${this.s.counters[prefix]}`;
  }

  emit(ev: Omit<GameEvent, 't'>) {
    this.s.events.push({ t: this.s.t, ...ev });
  }

  // ================================================================== world info

  staticWorld(): StaticWorld {
    const sc = this.sc;
    return {
      cities: this.s.cities, seaAreas: sc.seaAreas, scenario: sc.name, scenarioId: sc.id,
      factions: sc.factions.map(({ id, name, short, color, playable, brief }) => ({ id, name, short, color, playable, brief })),
      relations: this.s.relations ?? sc.relations,
    };
  }

  // ================================================================== commands

  apply(side: Side, cmd: Command): CommandResult {
    if (this.s.over && cmd.op !== 'speed' && cmd.op !== 'pause' && cmd.op !== 'hotline') {
      return { ok: false, msg: 'SIMULATION TERMINATED' };
    }
    const res = this.applyInner(side, cmd);
    if (res.ok) this.s.log.push({ tick: this.s.tick, side, cmd });
    return res;
  }

  private applyInner(side: Side, cmd: Command): CommandResult {
    const s = this.s;
    switch (cmd.op) {
      case 'defcon': {
        const cur = s.defcon[side];
        if (cmd.level === cur) return { ok: true, msg: `DEFCON ${cur} MAINTAINED` };
        if (cmd.level < cur) {
          if (cmd.level < cur - 1) return { ok: false, msg: `DEFCON CAN ONLY BE RAISED ONE LEVEL AT A TIME (NOW ${cur})` };
          const wait = s.defconChangedT[side] + DEFCON_RULES.stepDownSec - s.t;
          if (wait > 0) return { ok: false, msg: `FORCES NOT YET IN POSTURE — NEXT STEP IN ${Math.ceil(wait)}s` };
          s.tension = Math.min(100, s.tension + 7);
        } else {
          s.tension = Math.max(0, s.tension - 3);
        }
        s.defcon[side] = cmd.level;
        s.defconChangedT[side] = s.t;
        // every other faction's intelligence notices after a delay
        for (const other of this.factions) {
          if (other !== side) s.intel[other].defconPending[side] = { value: cmd.level, at: s.t + this.rng.range(60, 200) };
        }
        if (cmd.level <= 2) for (const u of s.units) if (u.side === side && u.kind === 'silo' && u.status === 'ready') u.status = 'alert';
        this.emit({ kind: 'defcon', visibleTo: [side], side, text: `${side} DEFCON ${cmd.level} — ${DEFCON_NAMES[cmd.level]}` });
        return { ok: true, msg: `DEFCON ${cmd.level} (${DEFCON_NAMES[cmd.level]})` };
      }

      case 'launch': {
        const u = this.resolveOwn(side, cmd.from);
        if (typeof u === 'string') return { ok: false, msg: u };
        if (u.kind !== 'silo' && u.kind !== 'ssbn') return { ok: false, msg: `${u.id} HAS NO BALLISTIC MISSILES` };
        if (u.status === 'destroyed') return { ok: false, msg: `${u.id} IS DESTROYED` };
        if (s.defcon[side] > DEFCON_RULES.launchMax) return { ok: false, msg: `LAUNCH NOT AUTHORIZED AT DEFCON ${s.defcon[side]} — REQUIRES DEFCON 1` };
        const avail = u.missiles ?? 0;
        if (avail <= 0) return { ok: false, msg: `${u.id} HAS NO MISSILES REMAINING` };
        const tgt = this.resolveTarget(side, cmd.target);
        if (typeof tgt === 'string') return { ok: false, msg: tgt };
        const d = distKm(u, tgt.pos);
        if (u.rangeKm && d > u.rangeKm) return { ok: false, msg: `TARGET OUT OF RANGE (${Math.round(d)} KM > ${u.rangeKm} KM)` };
        const count = Math.min(avail, cmd.count ?? 1);
        u.missiles = avail - count;
        const delay = this.commandIntact(side) ? DEFCON_RULES.launchDelaySec : DEFCON_RULES.launchDelayDegradedSec;
        s.orders.push({ fireT: s.t + delay, side, unitId: u.id, target: tgt, count, stagger: u.kind === 'ssbn' ? 15 : 3 });
        this.emit({ kind: 'launch', visibleTo: [side], side, text: `LAUNCH ORDER AUTHENTICATED: ${count} x ${u.cls} FROM ${u.name} → ${tgt.name}. T-${delay}s`, lat: u.lat, lon: u.lon });
        return { ok: true, msg: `${count} MISSILE(S) FROM ${u.id} → ${tgt.name}, LIFTOFF IN ${delay}s` };
      }

      case 'scramble': {
        const b = this.resolveOwn(side, cmd.base);
        if (typeof b === 'string') return { ok: false, msg: b };
        if (b.kind !== 'airbase') return { ok: false, msg: `${b.id} IS NOT A BOMBER BASE` };
        if (b.status === 'destroyed') return { ok: false, msg: `${b.id} IS DESTROYED` };
        if (s.defcon[side] > DEFCON_RULES.scrambleMax) return { ok: false, msg: `BOMBER LAUNCH REQUIRES DEFCON ${DEFCON_RULES.scrambleMax}` };
        const n = Math.min(b.aircraft ?? 0, cmd.count ?? b.aircraft ?? 0);
        if (n <= 0) return { ok: false, msg: `NO AIRCRAFT AVAILABLE AT ${b.id}` };
        let orbit: LatLon;
        if (cmd.to) {
          const t = this.resolvePlace(side, cmd.to);
          if (typeof t === 'string') return { ok: false, msg: t };
          orbit = t.pos;
        } else {
          orbit = this.failSafePoint(b);
        }
        b.aircraft = (b.aircraft ?? 0) - n;
        const id = `bmr-${b.id.replace(/^[a-z]+-/, '')}-${(s.counters[b.id] = (s.counters[b.id] ?? 0) + 1)}`;
        const tankers = Math.min(b.tankers ?? 0, 1);
        b.tankers = (b.tankers ?? 0) - tankers;
        const grp: Unit = {
          id, name: `${b.cls} FLIGHT ${id.split('-').pop()} (${b.name.split(' ')[0]})`, side, kind: 'bomber', cls: b.cls,
          lat: b.lat, lon: b.lon, status: 'moving', hp: 1, aircraft: n, bombs: b.bombs, yieldKt: b.yieldKt,
          rangeKm: BOMBER_RANGE[b.cls] ?? b.rangeKm, fuel: 1, speedKmh: BOMBER_SPEED[b.cls] ?? 800, dest: orbit, home: b.id,
          tankers, heading: bearing(b, orbit),
        };
        s.units.push(grp);
        this.unitIdx.set(id, grp);
        this.emit({ kind: 'info', visibleTo: [side], side, text: `${id.toUpperCase()}: ${n} x ${b.cls} AIRBORNE, PROCEEDING TO ORBIT ${fmtLatLon(orbit)}`, lat: b.lat, lon: b.lon });
        return { ok: true, msg: `${n} ${b.cls} AIRBORNE AS ${id}` };
      }

      case 'strike': {
        const u = this.resolveOwn(side, cmd.unit);
        if (typeof u === 'string') return { ok: false, msg: u };
        if (u.kind !== 'bomber' || u.status === 'destroyed') return { ok: false, msg: `${u.id} IS NOT AN AIRBORNE BOMBER GROUP` };
        if (s.defcon[side] > DEFCON_RULES.launchMax) return { ok: false, msg: `GO-CODE NOT AUTHORIZED AT DEFCON ${s.defcon[side]}` };
        if (!(u.bombs ?? 0)) return { ok: false, msg: `${u.id} HAS NO WEAPONS REMAINING` };
        const tgt = this.resolveTarget(side, cmd.target);
        if (typeof tgt === 'string') return { ok: false, msg: tgt };
        const home = this.unit(u.home ?? '');
        const need = distKm(u, tgt.pos) + (home ? distKm(tgt.pos, home) : 0);
        const have = (u.fuel ?? 0) * (u.rangeKm ?? 10000) + (u.tankers ?? 0) * 4000;
        u.status = 'enroute';
        u.dest = tgt.pos;
        u.target = tgt.name;
        u.targetPos = tgt.pos;
        this.emit({ kind: 'launch', visibleTo: [side], side, text: `GO-CODE TRANSMITTED TO ${u.id.toUpperCase()} — TARGET ${tgt.name}${need > have ? ' (ONE-WAY MISSION)' : ''}` });
        return { ok: true, msg: `${u.id} ATTACKING ${tgt.name}${need > have ? ' — INSUFFICIENT FUEL TO RETURN' : ''}` };
      }

      case 'sortie':
        return this.sortie(side, cmd);

      case 'recall': {
        const u = this.resolveOwn(side, cmd.unit);
        if (typeof u === 'string') return { ok: false, msg: u };
        if (u.kind === 'flight' && u.status !== 'destroyed') {
          const home = this.flightHome(u);
          if (!home) return { ok: false, msg: 'NO FRIENDLY CARRIER OR FIGHTER BASE IN RANGE' };
          u.status = 'returning';
          u.home = home.id;
          u.dest = { lat: home.lat, lon: home.lon };
          u.target = null;
          u.targetPos = null;
          return { ok: true, msg: `${u.id} RETURNING TO ${home.name}` };
        }
        if (u.kind !== 'bomber' || u.status === 'destroyed') return { ok: false, msg: `${u.id} IS NOT AN AIRBORNE BOMBER GROUP` };
        const home = this.homeFor(u);
        if (!home) return { ok: false, msg: 'NO FRIENDLY AIRFIELD AVAILABLE' };
        u.status = 'returning';
        u.dest = { lat: home.lat, lon: home.lon };
        u.home = home.id;
        u.target = null;
        u.targetPos = null;
        this.emit({ kind: 'info', visibleTo: [side], side, text: `${u.id.toUpperCase()} RECALLED TO ${home.name}` });
        return { ok: true, msg: `${u.id} RETURNING TO ${home.id}` };
      }

      case 'move': {
        const u = this.resolveOwn(side, cmd.unit);
        if (typeof u === 'string') return { ok: false, msg: u };
        if (u.status === 'destroyed') return { ok: false, msg: `${u.id} IS DESTROYED` };
        const p = this.resolvePlace(side, cmd.to);
        if (typeof p === 'string') return { ok: false, msg: p };
        if (u.kind === 'bomber') {
          if (u.status === 'enroute') return { ok: false, msg: `${u.id} IS ON A STRIKE MISSION — RECALL FIRST` };
          u.status = 'moving';
          u.dest = p.pos;
          return { ok: true, msg: `${u.id} NEW ORBIT ${fmtLatLon(p.pos)}` };
        }
        if (!SHIP_KINDS.has(u.kind)) return { ok: false, msg: `${u.id} (${u.kind.toUpperCase()}) IS A FIXED INSTALLATION` };
        const q = (s.routeQueue ??= []);
        // a new order replaces any course still being plotted for this unit
        const prev = q.findIndex((r) => r.unitId === u.id);
        if (prev >= 0) { q.splice(prev, 1); if (prev === 0) this.routeJob = undefined; }
        const plan = nav().plan(u, p.pos);
        if (plan === null) return { ok: false, msg: `NO SEA ROUTE TO ${p.name}` };
        if (Array.isArray(plan)) return { ok: true, msg: this.startRoute(u, plan, p.name) };
        q.push({ unitId: u.id, side, to: p.pos, name: p.name, spent: 0 });
        u.status = 'moving';
        u.dest = null;
        u.route = undefined;
        return { ok: true, msg: `${u.id} PLOTTING COURSE TO ${p.name}` };
      }

      case 'speed':
        s.speed = cmd.value;
        return { ok: true, msg: `TIME COMPRESSION x${cmd.value}` };

      case 'pause':
        s.paused = cmd.value ?? !s.paused;
        return { ok: true, msg: s.paused ? 'SIMULATION PAUSED' : 'SIMULATION RESUMED' };

      case 'hotline': {
        let to = this.factions.filter((f) => f !== side);
        if (cmd.to) {
          const want = cmd.to.toUpperCase();
          const f = this.sc.factions.find((x) => x.id === want || x.short === want || x.name === want);
          if (!f || f.id === side) return { ok: false, msg: `UNKNOWN FACTION "${cmd.to}" — ONE OF ${to.join(', ')}` };
          to = [f.id];
        }
        this.emit({ kind: 'hotline', visibleTo: [side, ...to], from: side, text: `${side} → ${to.join(', ')}: ${cmd.text}` });
        if (s.t >= s.hotlineCooldown[side]) {
          s.tension = Math.max(0, s.tension - 2);
          s.hotlineCooldown[side] = s.t + 300;
        }
        return { ok: true, msg: 'MESSAGE TRANSMITTED ON DIRECT COMMUNICATIONS LINK' };
      }

      case 'hold':
        return { ok: true, msg: 'HOLDING' };
    }
  }

  // ================================================================== air operations

  private sortie(side: Side, cmd: Extract<Command, { op: 'sortie' }>): CommandResult {
    const s = this.s;
    const base = this.resolveOwn(side, cmd.from);
    if (typeof base === 'string') return { ok: false, msg: base };
    if (base.kind !== 'carrier' && base.kind !== 'afb_int') return { ok: false, msg: `${base.id} HAS NO FIGHTERS — USE A CARRIER GROUP OR FIGHTER BASE` };
    if (base.status === 'destroyed') return { ok: false, msg: `${base.id} IS DESTROYED` };
    const m = cmd.mission;
    const need = m === 'strike' ? 2 : m === 'cap' ? 4 : 5;
    if (s.defcon[side] > need) return { ok: false, msg: `${m.toUpperCase()} SORTIES REQUIRE DEFCON ${need} (NOW ${s.defcon[side]})` };
    const avail = base.interceptors ?? 0;
    const n = Math.min(avail, cmd.count ?? FLIGHT.defaults[m]);
    if (n <= 0) return { ok: false, msg: `NO AIRCRAFT AVAILABLE ON ${base.id}` };
    let dest: LatLon, label: string, target: Target | undefined;
    if (m === 'strike') {
      const t = this.resolveTarget(side, cmd.to ?? '');
      if (typeof t === 'string') return { ok: false, msg: t };
      if (t.cityId) return { ok: false, msg: 'CONVENTIONAL STRIKES ARE FLOWN AGAINST MILITARY TARGETS ONLY (SHIPS, BASES, RADARS)' };
      target = t;
      dest = t.pos;
      label = t.name;
    } else if (cmd.to) {
      const t = this.resolvePlace(side, cmd.to);
      if (typeof t === 'string') return { ok: false, msg: t };
      dest = t.pos;
      label = t.name;
    } else {
      dest = { lat: base.lat, lon: base.lon };
      label = `OVER ${base.name}`;
    }
    const d = distKm(base, dest);
    if (d > FLIGHT.maxRadiusKm) return { ok: false, msg: `${label} IS ${Math.round(d)} KM AWAY — COMBAT RADIUS ${FLIGHT.maxRadiusKm} KM` };
    base.interceptors = avail - n;
    const id = `${m === 'recon' ? 'rec' : m === 'cap' ? 'cap' : 'stk'}-${base.id.replace(/^[a-z]+-/, '')}-${(s.counters[`f:${base.id}`] = (s.counters[`f:${base.id}`] ?? 0) + 1)}`;
    const f: Unit = {
      id, name: `${m.toUpperCase()} ${id.split('-').pop()} (${base.name.split(' ')[0]})`, side, kind: 'flight', cls: base.kind === 'carrier' ? 'CARRIER AIR WING' : base.cls,
      lat: base.lat, lon: base.lon, status: m === 'strike' ? 'enroute' : 'moving', hp: 1, aircraft: n, mission: m,
      speedKmh: FLIGHT.speed[m], rangeKm: FLIGHT.rangeKm, fuel: 1, dest, home: base.id, heading: bearing(base, dest),
      target: target?.unitId ?? null, targetPos: target ? target.pos : null,
    };
    s.units.push(f);
    this.unitIdx.set(id, f);
    const what = m === 'recon' ? `RECONNAISSANCE OF ${label}` : m === 'cap' ? `COMBAT AIR PATROL ${label.startsWith('OVER') ? label : `OVER ${label}`}` : `STRIKE ON ${label}`;
    this.emit({ kind: 'info', visibleTo: [side], side, text: `${id.toUpperCase()}: ${n} AIRCRAFT LAUNCHED FROM ${base.name} — ${what}`, lat: base.lat, lon: base.lon });
    return { ok: true, msg: `${n} AIRCRAFT AIRBORNE AS ${id} — ${what} (${Math.round(d)} KM)` };
  }

  /** Where a flight recovers: its own carrier/base, else the nearest friendly one with deck/runway in range. */
  private flightHome(f: Unit): Unit | undefined {
    const home = this.unit(f.home ?? '');
    if (home && home.status !== 'destroyed') return home;
    let best: Unit | undefined, bd = Infinity;
    for (const b of this.s.units) {
      if (!this.friendly(b.side, f.side) || (b.kind !== 'carrier' && b.kind !== 'afb_int') || b.status === 'destroyed') continue;
      const d = distKm(f, b);
      if (d < bd) { bd = d; best = b; }
    }
    return best && bd <= (f.fuel ?? 0) * (f.rangeKm ?? FLIGHT.rangeKm) ? best : undefined;
  }

  private flightLogic(f: Unit, arrived: boolean) {
    const s = this.s;
    const home = this.flightHome(f);
    const fuelKm = (f.fuel ?? 0) * (f.rangeKm ?? FLIGHT.rangeKm);
    if ((f.fuel ?? 0) <= 0) {
      this.lose(f, null, `${f.id.toUpperCase()} LOST — FUEL EXHAUSTED`);
      return;
    }
    // the carrier keeps moving: steer for where it is now
    if (f.status === 'returning' && home) f.dest = { lat: home.lat, lon: home.lon };
    if (f.status === 'returning' && arrived) {
      if (home && distKm(f, home) < 30) {
        home.interceptors = (home.interceptors ?? 0) + (f.aircraft ?? 0);
        this.emit({ kind: 'info', visibleTo: [f.side], side: f.side, text: `${f.id.toUpperCase()} RECOVERED ON ${home.name} (${f.aircraft} AIRCRAFT)` });
        f.status = 'destroyed';
        f.hp = 0;
        f.aircraft = 0;
      }
      return;
    }
    // bingo fuel: head home with a margin
    if (f.status !== 'returning' && home && fuelKm < distKm(f, home) * 1.15 + 150) {
      f.status = 'returning';
      f.home = home.id;
      f.dest = { lat: home.lat, lon: home.lon };
      f.target = null;
      f.targetPos = null;
      this.emit({ kind: 'info', visibleTo: [f.side], side: f.side, text: `${f.id.toUpperCase()} BINGO FUEL — RETURNING TO ${home.name}` });
      return;
    }
    if (f.status === 'moving' && arrived) {
      f.status = 'orbit';
      f.dest = null;
      if (f.mission === 'recon') f.loiterUntil = s.t + FLIGHT.reconLoiterSec;
      this.emit({ kind: 'info', visibleTo: [f.side], side: f.side, text: `${f.id.toUpperCase()} ON STATION ${fmtLatLon(f)}${f.mission === 'recon' ? ' — SEARCHING' : ' — PATROLLING'}` });
    } else if (f.status === 'orbit' && f.mission === 'recon' && s.t >= (f.loiterUntil ?? 0) && home) {
      f.status = 'returning';
      f.dest = { lat: home.lat, lon: home.lon };
      this.emit({ kind: 'info', visibleTo: [f.side], side: f.side, text: `${f.id.toUpperCase()} SEARCH COMPLETE — RETURNING` });
    } else if (f.status === 'enroute') {
      // strike: follow a moving target we still hold a contact on
      const tgt = f.target ? this.unit(f.target) : undefined;
      if (tgt && tgt.status !== 'destroyed' && s.intel[f.side].contacts[tgt.id]) f.dest = { lat: tgt.lat, lon: tgt.lon };
      if (arrived || (tgt && distKm(f, tgt) < 25)) this.airStrike(f, tgt);
    }
  }

  /** Conventional raid: the target's air defence takes its toll, survivors hit ships hard and bases moderately. */
  private airStrike(f: Unit, tgt: Unit | undefined) {
    const s = this.s;
    let n = f.aircraft ?? 0;
    const defended = tgt && tgt.status !== 'destroyed' ? tgt : undefined;
    let lost = 0;
    if (defended && ((defended.interceptors ?? 0) > 0 || defended.kind === 'carrier' || (defended.defenceKm ?? 0) > 0)) {
      const p = Math.min(0.55, 0.12 + 0.012 * (defended.interceptors ?? 0) + (defended.kind === 'carrier' ? 0.1 : 0));
      for (let i = 0; i < n; i++) if (this.rng.chance(p)) lost++;
      n -= lost;
      f.aircraft = n;
    }
    let result = 'NO TARGET AT THE STRIKE POINT';
    if (defended && n > 0) {
      const per = defended.kind === 'carrier' ? 0.11 : ['silo', 'command', 'abm'].includes(defended.kind) ? 0.015 : 0.07;
      let dmg = 0;
      for (let i = 0; i < n; i++) dmg += per * this.rng.range(0.5, 1.2);
      defended.hp = Math.max(0, defended.hp - dmg);
      if (defended.hp <= 0) {
        this.destroy(defended, f.side);
        result = `${defended.name} DESTROYED`;
      } else {
        defended.status = defended.kind === 'carrier' ? defended.status : 'damaged';
        result = `${defended.name} HIT — ${Math.round((1 - defended.hp) * 100)}% DAMAGE`;
      }
      s.tension = Math.min(100, s.tension + 6);
    }
    const tside = defended?.side;
    this.emit({ kind: 'impact', visibleTo: tside ? [f.side, tside] : [f.side], text: `${f.id.toUpperCase()} STRIKE: ${result}${lost ? ` · ${lost} AIRCRAFT LOST` : ''}`, lat: f.lat, lon: f.lon });
    if (n <= 0) { this.lose(f, tside ?? null, `${f.id.toUpperCase()} — ALL AIRCRAFT LOST`); return; }
    const home = this.flightHome(f);
    f.status = home ? 'returning' : 'orbit';
    f.dest = home ? { lat: home.lat, lon: home.lon } : null;
    f.target = null;
    f.targetPos = null;
  }

  /** Remove an air group (fuel, shoot-down, ditching). */
  private lose(f: Unit, by: Side | null, text: string) {
    f.status = 'destroyed';
    f.hp = 0;
    f.aircraft = 0;
    this.emit({ kind: 'destroyed', visibleTo: by ? [f.side, by] : [f.side], side: f.side, text, lat: f.lat, lon: f.lon });
  }

  private startRoute(u: Unit, route: LatLon[], name: string) {
    const km = Math.round(routeLen(u, route));
    u.route = route;
    u.dest = route[0];
    u.status = 'moving';
    return `${u.id} UNDERWAY TO ${name} — ${km} KM, ETA ${(km / (u.speedKmh ?? 40)).toFixed(1)} H`;
  }

  /** Advance queued ocean-route searches by a fixed cell budget (never blocks a tick for long). */
  private processRoutes() {
    const q = this.s.routeQueue;
    let budget = ROUTE_BUDGET;
    while (q?.length && budget > 0) {
      const req = q[0];
      const u = this.unit(req.unitId);
      if (!u || u.status === 'destroyed') { q.shift(); this.routeJob = undefined; continue; }
      if (this.routeJob?.req !== req) {
        const plan = nav().plan(u, req.to);
        if (!(plan instanceof RouteJob)) {
          q.shift();
          this.finishRoute(u, req, plan);
          continue;
        }
        plan.spent = req.spent; // resume a saved search: the job replays to this point
        this.routeJob = { req, job: plan };
      }
      const before = this.routeJob.job.spent;
      const res = this.routeJob.job.run(budget);
      budget -= Math.max(1, this.routeJob.job.spent - before);
      req.spent = this.routeJob.job.spent;
      if (res === undefined) break;
      q.shift();
      this.routeJob = undefined;
      this.finishRoute(u, req, res);
    }
  }

  private finishRoute(u: Unit, req: RouteRequest, route: LatLon[] | null) {
    if (!route) {
      u.status = 'patrol';
      this.emit({ kind: 'warn', visibleTo: [req.side], side: req.side, text: `${u.id.toUpperCase()}: NO SEA ROUTE TO ${req.name}` });
      return;
    }
    this.emit({ kind: 'info', visibleTo: [req.side], side: req.side, text: this.startRoute(u, route, req.name).toUpperCase() });
  }

  private commandIntact(side: Side) {
    return this.s.units.some((u) => u.side === side && u.kind === 'command' && u.status !== 'destroyed');
  }

  private failSafePoint(base: Unit): LatLon {
    const fs = this.faction(base.side)?.failSafe ?? { aim: { lat: 0, lon: 0 }, km: 2000 };
    return destination(base, bearing(base, fs.aim), fs.km);
  }

  private homeFor(u: Unit): Unit | undefined {
    const home = this.unit(u.home ?? '');
    if (home && home.status !== 'destroyed') return home;
    let best: Unit | undefined, bd = Infinity;
    for (const b of this.s.units) {
      if (b.side !== u.side || b.kind !== 'airbase' || b.status === 'destroyed') continue;
      const d = distKm(u, b);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // ================================================================== reference resolution

  /** Resolve one of your own units by id / name prefix. */
  resolveOwn(side: Side, ref: string): Unit | string {
    const r = ref.trim().toLowerCase();
    const own = this.s.units.filter((u) => u.side === side);
    const exact = own.find((u) => u.id === r);
    if (exact) return exact;
    const cands = own.filter((u) => u.id.includes(r) || u.name.toLowerCase().includes(r));
    if (cands.length === 1) return cands[0];
    const alive = cands.filter((u) => u.status !== 'destroyed');
    if (alive.length === 1) return alive[0];
    if (cands.length === 0) return `UNKNOWN UNIT "${ref}"`;
    return `AMBIGUOUS "${ref}": ${cands.slice(0, 6).map((u) => u.id).join(', ')}${cands.length > 6 ? '…' : ''}`;
  }

  /** Targets: coordinates, enemy contacts (by id or alias), cities, known places. */
  resolveTarget(side: Side, ref: string): Target | string {
    const ll = parseLatLon(ref);
    if (ll) return { pos: ll, name: fmtLatLon(ll) };
    const r = ref.trim().toLowerCase();
    const intel = this.s.intel[side];
    const contacts = Object.entries(intel.contacts);
    for (const [real, c] of contacts) {
      if (c.id === r || (c.identified && real === r)) return { pos: { lat: c.lat, lon: c.lon }, name: c.name, unitId: real };
    }
    const city = this.s.cities.find((c) => c.id === r || c.name.toLowerCase() === r) ??
      this.s.cities.find((c) => c.name.toLowerCase().startsWith(r));
    if (city) return { pos: { lat: city.lat, lon: city.lon }, name: city.name, cityId: city.id };
    const named = contacts.filter(([, c]) => c.identified && (c.name.toLowerCase().includes(r) || c.id.includes(r)));
    if (named.length === 1) return { pos: { lat: named[0][1].lat, lon: named[0][1].lon }, name: named[0][1].name, unitId: named[0][0] };
    if (named.length > 1) {
      const live = named.filter(([, c]) => c.status !== 'destroyed');
      if (live.length === 1) return { pos: { lat: live[0][1].lat, lon: live[0][1].lon }, name: live[0][1].name, unitId: live[0][0] };
      return `AMBIGUOUS TARGET "${ref}": ${named.slice(0, 6).map(([, c]) => c.id).join(', ')}`;
    }
    const p = this.resolvePlace(side, ref);
    return p;
  }

  /** Places for movement / orbits: coordinates, sea areas, own units, cities, gazetteer. */
  resolvePlace(side: Side, ref: string): Target | string {
    const ll = parseLatLon(ref);
    if (ll) return { pos: ll, name: fmtLatLon(ll) };
    const r = ref.trim().toLowerCase();
    const seas = this.sc.seaAreas;
    const sea = seas.find((a) => a.name.toLowerCase() === r) ?? seas.find((a) => a.name.toLowerCase().includes(r));
    if (sea) return { pos: { lat: sea.lat, lon: sea.lon }, name: sea.name };
    const own = this.s.units.find((u) => u.side === side && (u.id === r || u.name.toLowerCase() === r));
    if (own) return { pos: { lat: own.lat, lon: own.lon }, name: own.name };
    const c = this.s.intel[side].contacts;
    for (const [real, k] of Object.entries(c)) if (k.id === r || (k.identified && real === r)) return { pos: { lat: k.lat, lon: k.lon }, name: k.name };
    const city = this.s.cities.find((x) => x.name.toLowerCase() === r) ?? this.s.cities.find((x) => x.name.toLowerCase().startsWith(r));
    if (city) return { pos: { lat: city.lat, lon: city.lon }, name: city.name };
    const pl = places();
    const hit = pl.find((p) => p[0].toLowerCase() === r) ?? pl.find((p) => p[0].toLowerCase().startsWith(r));
    if (hit) return { pos: { lat: hit[1], lon: hit[2] }, name: hit[0].toUpperCase() };
    return `UNKNOWN LOCATION "${ref}"`;
  }

  // ================================================================== simulation

  /** Advance one real-time tick. */
  step() {
    const s = this.s;
    if (s.paused || s.over) return;
    const dt = TICK_SEC * s.speed;
    s.tick++;
    s.t += dt;
    this.fireOrders();
    this.processRoutes();
    this.moveUnits(dt);
    this.updateMissiles();
    this.combat(dt);
    this.updateIntel(dt);
    this.crisis(dt);
    this.checkEnd();
    s.rng = this.rng.state;
  }

  private fireOrders() {
    const s = this.s;
    const due = s.orders.filter((o) => o.fireT <= s.t);
    if (!due.length) return;
    s.orders = s.orders.filter((o) => o.fireT > s.t);
    for (const o of due) {
      const u = this.unit(o.unitId);
      if (!u || u.status === 'destroyed') {
        this.emit({ kind: 'warn', visibleTo: [o.side], side: o.side, text: `LAUNCH FROM ${o.unitId.toUpperCase()} FAILED — SITE LOST` });
        continue;
      }
      const type = u.kind === 'ssbn' ? 'SLBM' : 'ICBM';
      const d = distKm(u, o.target.pos);
      const flight = ballisticFlightSec(d, type);
      for (let i = 0; i < o.count; i++) {
        const m: SimMissile = {
          id: this.nextId('m'), side: o.side, type, from: { lat: u.lat, lon: u.lon }, to: o.target.pos,
          launchT: s.t + i * o.stagger, impactT: s.t + i * o.stagger + flight, apexKm: apexKm(d, type),
          warheads: u.warheads ?? 1, yieldKt: u.yieldKt ?? 500, source: u.id, target: o.target.name, targetId: o.target.unitId ?? o.target.cityId,
          seenBy: [o.side, ...this.alliesOf(o.side)], confirmedBy: [o.side, ...this.alliesOf(o.side)], spreadKm: o.target.cityId ? 6 : 1.5,
        };
        s.missiles.push(m);
      }
      s.score[o.side].warheadsLaunched += o.count * (u.warheads ?? 1);
      if (u.kind === 'ssbn') u.revealedUntil = s.t + 900;
      this.emit({ kind: 'launch', visibleTo: [o.side], side: o.side, text: `LIFTOFF: ${o.count} x ${u.cls} FROM ${u.name}`, lat: u.lat, lon: u.lon });
    }
  }

  private moveUnits(dt: number) {
    const s = this.s;
    for (const u of s.units) {
      if (u.status === 'destroyed' || !u.dest || !u.speedKmh) continue;
      const km = (u.speedKmh * dt) / 3600;
      const [np, arrived] = stepToward(u, u.dest, km);
      if (distKm(u, np) > 0.01) u.heading = bearing(u, np);
      u.lat = np.lat;
      u.lon = np.lon;
      if (u.kind === 'bomber') {
        u.fuel = (u.fuel ?? 1) - km / (u.rangeKm ?? 12000);
        this.bomberLogic(u, arrived);
        continue;
      }
      if (u.kind === 'flight') {
        u.fuel = (u.fuel ?? 1) - km / (u.rangeKm ?? FLIGHT.rangeKm);
        this.flightLogic(u, arrived);
        continue;
      }
      if (arrived) {
        if (u.route && u.route.length > 1) {
          u.route.shift();
          u.dest = u.route[0];
        } else {
          u.route = undefined;
          u.dest = null;
          u.status = 'patrol';
          this.emit({ kind: 'info', visibleTo: [u.side], side: u.side, text: `${u.id.toUpperCase()} ON STATION ${fmtLatLon(u)}` });
        }
      }
    }
    // flights on station burn fuel and run their mission clock
    for (const u of s.units) {
      if (u.kind !== 'flight' || u.status !== 'orbit') continue;
      u.fuel = (u.fuel ?? 1) - (0.45 * (u.speedKmh ?? 900) * dt) / 3600 / (u.rangeKm ?? FLIGHT.rangeKm);
      this.flightLogic(u, false);
    }
    // orbiting bombers burn fuel slowly
    for (const u of s.units) {
      if (u.kind !== 'bomber' || u.status !== 'orbit') continue;
      u.fuel = (u.fuel ?? 1) - (0.35 * (u.speedKmh ?? 800) * dt) / 3600 / (u.rangeKm ?? 12000);
      this.bomberLogic(u, false);
    }
  }

  private bomberLogic(u: Unit, arrived: boolean) {
    const s = this.s;
    const home = this.homeFor(u);
    // tanker top-up
    if ((u.fuel ?? 0) < 0.45 && (u.tankers ?? 0) > 0 && u.status !== 'enroute') {
      u.tankers! -= 1;
      u.fuel = Math.min(1, (u.fuel ?? 0) + 0.4);
      this.emit({ kind: 'info', visibleTo: [u.side], side: u.side, text: `${u.id.toUpperCase()} REFUELED BY TANKER` });
    }
    if ((u.fuel ?? 0) <= 0) {
      u.status = 'destroyed';
      u.hp = 0;
      this.s.score[u.side].forcesLost += (u.aircraft ?? 0) * (u.bombs ?? 0);
      this.emit({ kind: 'destroyed', visibleTo: [u.side], side: u.side, text: `${u.id.toUpperCase()} LOST — FUEL EXHAUSTED`, lat: u.lat, lon: u.lon });
      return;
    }
    if (u.status === 'moving' && arrived) {
      u.status = 'orbit';
      u.dest = null;
      this.emit({ kind: 'info', visibleTo: [u.side], side: u.side, text: `${u.id.toUpperCase()} HOLDING AT FAIL-SAFE POINT. AWAITING GO-CODE.` });
    } else if (u.status === 'orbit' && home) {
      const need = distKm(u, home) / (u.rangeKm ?? 12000) + 0.08;
      if ((u.fuel ?? 0) < need && !(u.tankers ?? 0)) {
        u.status = 'returning';
        u.dest = { lat: home.lat, lon: home.lon };
        this.emit({ kind: 'info', visibleTo: [u.side], side: u.side, text: `${u.id.toUpperCase()} BINGO FUEL — RETURNING TO ${home.name}` });
      }
    } else if (u.status === 'enroute' && arrived) {
      const n = (u.aircraft ?? 0) * (u.bombs ?? 0);
      const tgt = u.targetPos ?? { lat: u.lat, lon: u.lon };
      for (let i = 0; i < n; i++) {
        const p = destination(tgt, this.rng.range(0, 360), this.rng.range(0, 4));
        this.detonate(u.side, p, u.yieldKt ?? 1000, u.target ?? 'TARGET');
      }
      s.score[u.side].warheadsLaunched += n;
      u.bombs = 0;
      this.emit({ kind: 'impact', visibleTo: [u.side], side: u.side, text: `${u.id.toUpperCase()} WEAPONS RELEASED ON ${u.target}` });
      if (home) {
        u.status = 'returning';
        u.dest = { lat: home.lat, lon: home.lon };
        u.home = home.id;
      } else {
        u.status = 'orbit';
        u.dest = null;
      }
    } else if (u.status === 'returning' && arrived) {
      const base = this.unit(u.home ?? '');
      if (base && base.status !== 'destroyed') {
        base.aircraft = (base.aircraft ?? 0) + (u.aircraft ?? 0);
        base.tankers = (base.tankers ?? 0) + (u.tankers ?? 0);
        if ((u.bombs ?? 0) === 0) base.bombs = base.bombs; // aircraft re-arm only if base has weapons — keep simple
        this.emit({ kind: 'info', visibleTo: [u.side], side: u.side, text: `${u.id.toUpperCase()} RECOVERED AT ${base.name}` });
      }
      u.status = 'destroyed'; // group dissolved
      u.hp = 0;
      u.aircraft = 0;
    }
  }

  private updateMissiles() {
    const s = this.s;
    const done: SimMissile[] = [];
    for (const m of s.missiles) {
      if (m.phantomFor) {
        if (s.t >= (m.dropT ?? 0)) done.push(m);
        continue;
      }
      if (s.t < m.launchT) continue;
      // ABM engagement in terminal phase
      if (!m.abmDone && m.type !== 'ABM' && s.t >= m.impactT - 70) {
        m.abmDone = true;
        for (const a of s.units) {
          if (a.kind !== 'abm' || !this.hostile(a.side, m.side) || a.status === 'destroyed' || !(a.missiles ?? 0)) continue;
          if (distKm(a, m.to) > (a.defenceKm ?? 300)) continue;
          let killed = 0;
          for (let w = 0; w < m.warheads && (a.missiles ?? 0) > 0; w++) {
            a.missiles!--;
            if (this.rng.chance(0.45)) killed++;
          }
          if (killed) {
            m.intercepted = (m.intercepted ?? 0) + killed;
          }
          s.missiles.push({
            id: this.nextId('abm'), side: a.side, type: 'ABM', from: { lat: a.lat, lon: a.lon }, to: ballisticPos(m.from, m.to, m.launchT, m.impactT, m.apexKm, s.t + 55).p,
            launchT: s.t, impactT: s.t + 55, apexKm: 120, warheads: 0, yieldKt: 0, source: a.id, target: m.id,
            seenBy: [a.side, m.side], confirmedBy: [a.side, m.side], spreadKm: 0,
          });
          this.emit({ kind: 'intercept', visibleTo: [a.side, m.side], text: `${a.name}: ${killed}/${m.warheads} WARHEADS INTERCEPTED`, lat: m.to.lat, lon: m.to.lon });
        }
      }
      if (s.t >= m.impactT) {
        done.push(m);
        if (m.type === 'ABM') continue;
        const live = m.warheads - (m.intercepted ?? 0);
        for (let w = 0; w < live; w++) {
          const p = w === 0 ? m.to : destination(m.to, this.rng.range(0, 360), this.rng.range(0.2, m.spreadKm));
          this.detonate(m.side, p, m.yieldKt, m.target);
        }
      }
    }
    if (done.length) {
      const set = new Set(done);
      for (const m of done) {
        if (m.phantomFor) {
          this.emit({ kind: 'warn', visibleTo: [m.phantomFor], text: `TRACK ${m.id.toUpperCase()} DROPPED — NO RADAR CORRELATION. PROBABLE SENSOR FAULT.` });
        }
      }
      s.missiles = s.missiles.filter((m) => !set.has(m));
    }
  }

  detonate(attacker: Side, p: LatLon, yieldKt: number, targetName: string) {
    const s = this.s;
    const soft = softKillKm(yieldKt);
    let killed = 0;
    for (const c of s.cities) {
      const d = distKm(p, c);
      const cityR = 4 + Math.sqrt(c.pop) * 0.35;
      if (d > cityR + soft * 4) continue;
      const remaining = c.pop - c.killed;
      if (remaining <= 0) continue;
      const cover = Math.min(0.85, ((soft * soft) / (cityR * cityR)) * 1.8);
      const fall = d < cityR ? 1 : Math.exp(-(d - cityR) / soft);
      const k = remaining * cover * fall;
      c.killed += k;
      killed += k;
      if (s.score[c.side]) s.score[c.side].killed += k;
    }
    for (const u of s.units) {
      if (u.status === 'destroyed') continue;
      const d = distKm(p, u);
      if (d > 40) continue;
      const before = this.forcesOfUnit(u);
      switch (u.kind) {
        case 'silo':
          if (d < 12 && (u.missiles ?? 0) > 0 && this.rng.chance(hardKillProb(yieldKt, Math.max(0.25, d * 0.08)))) {
            u.missiles!--;
            u.hp = (u.missiles ?? 0) / (u.missilesMax ?? 1);
            if (!u.missiles) this.destroy(u, attacker);
            else u.status = 'damaged';
          }
          break;
        case 'command':
          if (d < soft * 0.3) this.destroy(u, attacker);
          break;
        case 'abm':
          if (d < soft * 0.7) this.destroy(u, attacker);
          break;
        case 'airbase':
        case 'afb_int':
        case 'radar':
        case 'navalbase':
          if (d < soft * 1.1) this.destroy(u, attacker);
          break;
        case 'carrier':
          if (d < soft * 1.2) this.destroy(u, attacker);
          break;
        case 'ssbn':
        case 'ssn':
          if (d < soft * 0.35) this.destroy(u, attacker);
          break;
        case 'bomber':
          break;
      }
      const lost = before - this.forcesOfUnit(u);
      if (lost > 0) s.score[u.side].forcesLost += lost;
    }
    const det: Detonation = { id: this.nextId('d'), t: s.t, side: attacker, lat: p.lat, lon: p.lon, yieldKt, target: targetName, killed };
    s.detonations.push(det);
    if (s.detonations.length > 600) s.detonations.splice(0, s.detonations.length - 600);
    this.emit({ kind: 'impact', text: `DETONATION ${yieldKt >= 1000 ? (yieldKt / 1000).toFixed(1) + ' MT' : yieldKt + ' KT'} — ${targetName}${killed > 1 ? ` — EST. ${fmtPop(killed)} CASUALTIES` : ''}`, lat: p.lat, lon: p.lon });
    s.tension = 100;
  }

  private forcesOfUnit(u: Unit) {
    if (u.kind === 'silo' || u.kind === 'ssbn') return (u.missiles ?? 0) * (u.warheads ?? 1);
    if (u.kind === 'airbase' || u.kind === 'bomber') return (u.aircraft ?? 0) * (u.bombs ?? 0);
    return 0;
  }

  private destroy(u: Unit, by: Side | null) {
    u.status = 'destroyed';
    u.hp = 0;
    if (u.kind === 'airbase' || u.kind === 'afb_int') { u.aircraft = 0; u.interceptors = 0; u.tankers = 0; }
    if (u.kind === 'silo' || u.kind === 'ssbn' || u.kind === 'abm') u.missiles = 0;
    u.dest = null;
    u.route = undefined;
    this.emit({ kind: 'destroyed', visibleTo: by ? [u.side, by] : [u.side], text: `${u.name} DESTROYED`, lat: u.lat, lon: u.lon });
  }

  /** Air defence vs bombers, ASW vs submarines. */
  private combat(dt: number) {
    const s = this.s;
    const perMin = dt / 60;
    // everything that can shoot at aircraft (bases and carriers with fighters, CAP flights), in unit order
    const defenders = s.units.filter((d) => d.status !== 'destroyed' && (d.kind === 'afb_int' || d.kind === 'carrier' || (d.kind === 'flight' && d.mission === 'cap')));
    for (const b of s.units) {
      if (b.kind !== 'bomber' || b.status === 'destroyed') continue;
      for (const d of defenders) {
        if (!this.hostile(d.side, b.side) || d.status === 'destroyed') continue;
        const cap = d.kind === 'flight' && d.mission === 'cap' && (d.aircraft ?? 0) > 0;
        if (!cap && ((d.kind !== 'afb_int' && d.kind !== 'carrier') || !(d.interceptors ?? 0))) continue;
        if (distKm(b, d) > (cap ? FLIGHT.capRadiusKm : d.defenceKm ?? 500)) continue;
        if (s.defcon[d.side] > 3 && b.status !== 'enroute') continue; // peacetime: escort, don't shoot
        if (this.rng.chance(0.22 * perMin)) {
          b.aircraft = (b.aircraft ?? 0) - 1;
          s.score[b.side].forcesLost += b.bombs ?? 0;
          if (this.rng.chance(0.25)) {
            if (cap) { d.aircraft = (d.aircraft ?? 0) - 1; if (!d.aircraft) this.lose(d, b.side, `${d.id.toUpperCase()} — LAST FIGHTER LOST`); }
            else d.interceptors = (d.interceptors ?? 0) - 1;
          }
          this.emit({ kind: 'intercept', visibleTo: [b.side, d.side], text: `${d.name.split(' ')[0]} INTERCEPTORS DOWN 1 ${b.cls} (${b.id.toUpperCase()})`, lat: b.lat, lon: b.lon });
          if ((b.aircraft ?? 0) <= 0) this.destroy(b, d.side);
        }
      }
    }
    // hostile air defence vs air flights: strikes are always engaged, recon / CAP from DEFCON 3
    for (const f of s.units) {
      if (f.kind !== 'flight' || f.status === 'destroyed' || !(f.aircraft ?? 0)) continue;
      for (const d of defenders) {
        if (gone(f) || !this.hostile(d.side, f.side) || d.status === 'destroyed') continue;
        const cap = d.kind === 'flight' && d.mission === 'cap' && (d.aircraft ?? 0) > 0;
        if (!cap && ((d.kind !== 'afb_int' && d.kind !== 'carrier') || !(d.interceptors ?? 0))) continue;
        if (distKm(f, d) > (cap ? FLIGHT.capRadiusKm : d.defenceKm ?? 450)) continue;
        if (f.mission !== 'strike' && s.defcon[d.side] > 3) continue;
        if (this.rng.chance(0.3 * perMin)) {
          f.aircraft = (f.aircraft ?? 0) - 1;
          // fighters shoot back
          if (this.rng.chance(f.mission === 'recon' ? 0.05 : 0.3)) {
            if (cap) { d.aircraft = (d.aircraft ?? 0) - 1; if (!d.aircraft) this.lose(d, f.side, `${d.id.toUpperCase()} — LAST FIGHTER LOST`); }
            else d.interceptors = Math.max(0, (d.interceptors ?? 0) - 1);
          }
          this.emit({ kind: 'intercept', visibleTo: [f.side, d.side], text: `${d.name.split(' ')[0]} FIGHTERS DOWN 1 AIRCRAFT OF ${f.id.toUpperCase()}`, lat: f.lat, lon: f.lon });
          if (!f.aircraft) this.lose(f, d.side, `${f.id.toUpperCase()} SHOT DOWN`);
        }
      }
    }
    // surface warfare: groups with a fresh contact on a hostile group in range trade anti-ship missiles at DEFCON 2
    const groups = defenders.filter((u) => u.kind === 'carrier');
    for (const h of groups) {
      if (h.status === 'destroyed' || s.defcon[h.side] > 2) continue;
      const intel = s.intel[h.side];
      for (const t of groups) {
        if (t.kind !== 'carrier' || t.status === 'destroyed' || !this.hostile(h.side, t.side)) continue;
        const c = intel.contacts[t.id];
        if (!c || s.t - c.seenT > 600 || distKm(h, t) > SURFACE_RANGE_KM) continue;
        if (this.rng.chance(0.2 * perMin)) {
          t.hp = Math.max(0, t.hp - this.rng.range(0.08, 0.25));
          s.tension = Math.min(100, s.tension + 3);
          if (t.hp <= 0) this.destroy(t, h.side);
          else this.emit({ kind: 'intercept', visibleTo: [h.side, t.side], text: `${h.name} ANTI-SHIP MISSILES HIT ${t.name} — ${Math.round((1 - t.hp) * 100)}% DAMAGE`, lat: t.lat, lon: t.lon });
        }
      }
    }
    // ASW: attack subs and surface groups hunt enemy submarines; only shoot at DEFCON <= 2
    for (const h of s.units) {
      if ((h.kind !== 'ssn' && h.kind !== 'carrier') || h.status === 'destroyed') continue;
      const range = h.kind === 'ssn' ? (h.defenceKm ?? 130) : 90;
      for (const t of s.units) {
        if (!this.hostile(t.side, h.side) || t.status === 'destroyed' || (t.kind !== 'ssbn' && t.kind !== 'ssn')) continue;
        if (distKm(h, t) > range) continue;
        const intel = s.intel[h.side];
        const known = intel.contacts[t.id];
        if (!known || s.t - known.seenT > 120) {
          if (this.rng.chance((h.kind === 'ssn' ? 0.3 : 0.15) * perMin)) {
            this.seeContact(h.side, t, true);
            this.emit({ kind: 'detect', visibleTo: [h.side], side: h.side, text: `${h.name}: SONAR CONTACT — SUBMARINE ${fmtLatLon(t)}`, lat: t.lat, lon: t.lon });
          }
        } else if (s.defcon[h.side] <= 2 && this.rng.chance(0.25 * perMin)) {
          this.destroy(t, h.side);
          this.emit({ kind: 'destroyed', visibleTo: [h.side], side: h.side, text: `${h.name} REPORTS KILL ON ${t.cls.split(' ')[0]} CLASS SUBMARINE` });
        }
      }
    }
  }

  // ================================================================== intelligence / fog of war

  private aliasFor(side: Side, realId: string) {
    const intel = this.s.intel[side];
    if (!intel.alias[realId]) intel.alias[realId] = `unk-${this.rng.int(1000, 9999)}`;
    return intel.alias[realId];
  }

  private seeContact(side: Side, u: Unit, identified: boolean) {
    const intel = this.s.intel[side];
    const prev = intel.contacts[u.id];
    const ident = identified || (prev?.identified ?? false) || FIXED_KINDS.has(u.kind);
    intel.contacts[u.id] = {
      id: ident ? u.id : this.aliasFor(side, u.id),
      side: u.side, kind: u.kind, lat: u.lat, lon: u.lon, status: u.status, heading: u.heading,
      name: ident ? u.name : `UNK ${this.aliasFor(side, u.id).slice(4)}`,
      cls: ident ? u.cls : 'UNIDENTIFIED', identified: ident, seenT: this.s.t, hp: u.hp,
    };
  }

  /** Recon flights on station identify ships and aircraft in their search circle; a sub near the surface may be spotted. */
  private reconSighting(side: Side, e: Unit, dt: number, searchers: Unit[]) {
    const s = this.s;
    const mobile = e.kind === 'carrier' || e.kind === 'bomber' || e.kind === 'flight' || e.kind === 'ssn' || e.kind === 'ssbn';
    if (!mobile || !searchers.length) return;
    for (const f of searchers) {
      const radius = f.mission === 'recon' ? FLIGHT.reconRadiusKm : f.mission === 'cap' ? 200 : 0;
      if (!radius) continue;
      const d = distKm(f, e);
      if (d > radius) continue;
      if (e.kind === 'ssn' || e.kind === 'ssbn') {
        if (f.mission !== 'recon' || d > 120 || !this.rng.chance(0.06 * (dt / 60))) continue;
      }
      this.seeContact(side, e, true);
      // each flight reports every group it sights (once per flight)
      const key = `sight:${f.id}:${e.id}`;
      if (!s.counters[key]) {
        s.counters[key] = 1;
        this.emit({ kind: 'detect', visibleTo: [side], side, text: `${f.id.toUpperCase()}: SIGHTED ${e.name} (${e.cls}) ${fmtLatLon(e)}${e.heading !== undefined && e.dest ? ` HDG ${Math.round(e.heading)}` : ''}`, lat: e.lat, lon: e.lon });
      }
      return;
    }
  }

  /** Periodic intelligence summary for a faction: what it is tracking right now. */
  private intelSummary(side: Side) {
    const s = this.s;
    const key = `isum:${side}`;
    if (s.t < (s.counters[key] ?? INTEL_SUMMARY_SEC)) return;
    s.counters[key] = s.t + INTEL_SUMMARY_SEC;
    const fresh = Object.values(s.intel[side].contacts).filter((c) => c.status !== 'destroyed' && s.t - c.seenT < INTEL_SUMMARY_SEC);
    const n = (k: string[]) => fresh.filter((c) => k.includes(c.kind)).length;
    const parts = [
      [n(['carrier']), 'SURFACE GROUP'], [n(['bomber']), 'BOMBER GROUP'], [n(['flight']), 'AIR FLIGHT'], [n(['ssn', 'ssbn']), 'SUBMARINE'],
    ].filter(([k]) => (k as number) > 0).map(([k, l]) => `${k} ${l}${(k as number) > 1 ? 'S' : ''}`);
    const clock = new Date(this.sc.startEpoch + s.t * 1000).toISOString().slice(11, 16);
    this.emit({ kind: 'detect', visibleTo: [side], side, text: `INTEL SUMMARY ${clock}Z — ${parts.length ? `TRACKING ${parts.join(', ')}` : 'NO MOBILE FORCES CURRENTLY TRACKED — CONSIDER RECON SORTIES'} · ${n(FIXED_LIST)} FIXED SITES KNOWN` });
  }

  private updateIntel(dt: number) {
    const s = this.s;
    const satPass = s.t >= s.nextSatPassT;
    if (satPass) s.nextSatPassT = s.t + 1200;
    for (const side of this.factions) {
      const intel = s.intel[side];
      for (const other of this.factions) {
        const pend = intel.defconPending[other];
        if (!pend || s.t < pend.at) continue;
        intel.knownDefcon[other] = pend.value;
        intel.defconPending[other] = undefined;
        this.emit({ kind: 'alert', visibleTo: [side], side, text: `INTELLIGENCE: ${other} FORCES ASSESSED AT DEFCON ${pend.value}` });
        if (pend.value <= 2 && this.hostile(side, other)) s.tension = Math.min(100, s.tension + 4);
      }
      const sensors = s.units.filter((u) => u.side === side && u.status !== 'destroyed');
      const airSensors = sensors.filter((u) => (u.kind === 'radar' || u.kind === 'afb_int' || u.kind === 'carrier') && (u.defenceKm ?? 0) > 0);
      // this faction's flights that are searching (recon on the way / on station, CAP)
      const searchers = sensors.filter((f) => f.kind === 'flight' && f.status !== 'returning' && (f.mission === 'recon' || f.mission === 'cap'));
      for (const e of s.units) {
        // allies share their picture (they appear as friendly forces); everyone else is a contact
        if (this.friendly(side, e.side)) continue;
        if (FIXED_KINDS.has(e.kind)) {
          this.seeContact(side, e, true);
          continue;
        }
        if (e.status === 'destroyed') {
          if (intel.contacts[e.id]) intel.contacts[e.id].status = 'destroyed';
          continue;
        }
        if (e.kind === 'bomber' || e.kind === 'flight') {
          let seen = false, close = false;
          for (const r of airSensors) {
            const d = distKm(r, e);
            if (d < (r.defenceKm ?? 0)) { seen = true; if (d < 300) close = true; }
          }
          if (seen) {
            const was = intel.contacts[e.id];
            if (!was || s.t - was.seenT > 300) {
              this.emit({ kind: 'detect', visibleTo: [side], side, text: `AIR DEFENSE: UNIDENTIFIED AIRCRAFT ${fmtLatLon(e)} HDG ${Math.round(e.heading ?? 0)}`, lat: e.lat, lon: e.lon });
              s.tension = Math.min(100, s.tension + 2);
            }
            this.seeContact(side, e, close);
          }
        } else if (e.kind === 'carrier') {
          let seen = satPass && this.rng.chance(0.85);
          for (const r of sensors) if ((r.kind === 'carrier' || r.kind === 'ssn' || r.kind === 'afb_int') && distKm(r, e) < 450) seen = true;
          // coastal radars see ships near the coast
          for (const r of sensors) if (!seen && r.kind === 'radar' && distKm(r, e) < Math.min(RADAR_SEA_KM, r.radarKm ?? RADAR_SEA_KM)) seen = true;
          if (seen) this.seeContact(side, e, true);
        } else if (e.kind === 'ssbn' || e.kind === 'ssn') {
          if ((e.revealedUntil ?? -1) > s.t) this.seeContact(side, e, true);
        }
        if (!gone(e)) this.reconSighting(side, e, dt, searchers);
      }
      this.intelSummary(side);
      // forget stale mobile contacts
      for (const [id, c] of Object.entries(intel.contacts)) {
        if (!FIXED_KINDS.has(c.kind) && s.t - c.seenT > 7200) delete intel.contacts[id];
      }
      // missiles
      const radars = sensors.filter((u) => (u.kind === 'radar' || u.kind === 'abm') && (u.radarKm ?? 0) > 0);
      const fac = this.faction(side);
      const satDelay = fac?.satDelaySec ?? 60;
      const satP = fac?.satDetectP ?? 0.9;
      for (const m of s.missiles) {
        if (this.friendly(m.side, side) || m.phantomFor || s.t < m.launchT) continue;
        if (!m.seenBy.includes(side) && s.t - m.launchT > satDelay) {
          if (this.rng.chance(satP)) {
            m.seenBy.push(side);
            if (m.type !== 'ABM') {
              this.emit({ kind: 'alert', visibleTo: [side], side, text: `LAUNCH DETECTED — ${m.type} FROM ${fmtLatLon(m.from)}`, lat: m.from.lat, lon: m.from.lon });
              s.tension = 100;
            }
          } else {
            m.seenBy.push(side); // seen late by follow-up pass
          }
        }
        if (!m.confirmedBy.includes(side)) {
          const pos = ballisticPos(m.from, m.to, m.launchT, m.impactT, m.apexKm, s.t).p;
          if (radars.some((r) => distKm(r, pos) < (r.radarKm ?? 0))) {
            m.confirmedBy.push(side);
            if (!m.seenBy.includes(side)) m.seenBy.push(side);
            if (m.type !== 'ABM') this.emit({ kind: 'alert', visibleTo: [side], side, text: `RADAR CONFIRMS INBOUND ${m.type} — PREDICTED IMPACT ${m.target}`, lat: m.to.lat, lon: m.to.lon });
          }
        }
      }
    }
  }

  // ================================================================== crisis dynamics

  private crisis(dt: number) {
    const s = this.s;
    const war = s.detonations.length > 0 || s.missiles.some((m) => !m.phantomFor);
    if (!war) {
      // tension relaxes when every side stands down
      const calm = Math.min(...this.factions.map((f) => s.defcon[f]));
      s.tension = Math.max(0, s.tension - (calm >= 4 ? 0.25 : calm >= 3 ? 0.08 : -0.05) * (dt / 60));
      s.tension = Math.min(100, s.tension);
      if (s.t >= s.nextIncidentT) {
        s.nextIncidentT = s.t + this.rng.range(480, 1500);
        const inc = this.rng.pick(this.sc.incidents);
        s.tension = Math.min(100, s.tension + inc.tension);
        this.emit({ kind: 'warn', text: inc.text });
      }
      // sensor false alarms when the world is on a hair trigger
      if (s.tension > 60 && this.rng.chance(((s.tension - 60) / 40) * 0.5 * (dt / 3600))) this.falseAlarm();
    }
  }

  private falseAlarm() {
    const s = this.s;
    const victim = this.rng.pick(this.factions);
    // with a single adversary (the classic game) no extra random draw is made
    const foes = this.hostilesOf(victim).filter((f) => s.units.some((u) => u.side === f && u.kind === 'silo'));
    if (!foes.length) return;
    const enemy = foes.length === 1 ? foes[0] : this.rng.pick(foes);
    const fields = s.units.filter((u) => u.side === enemy && u.kind === 'silo');
    const targets = s.units.filter((u) => u.side === victim && u.kind === 'silo');
    if (!fields.length || !targets.length) return;
    const n = this.rng.int(1, 5);
    const src = this.rng.pick(fields);
    for (let i = 0; i < n; i++) {
      const tgt = this.rng.pick(targets);
      const d = distKm(src, tgt);
      const flight = ballisticFlightSec(d, 'ICBM');
      s.missiles.push({
        id: this.nextId('m'), side: enemy, type: 'ICBM', from: { lat: src.lat, lon: src.lon }, to: { lat: tgt.lat, lon: tgt.lon },
        launchT: s.t, impactT: s.t + flight, apexKm: apexKm(d, 'ICBM'), warheads: 1, yieldKt: 0, source: '?', target: tgt.name,
        seenBy: [victim], confirmedBy: [], phantomFor: victim, dropT: s.t + this.rng.range(180, 420), spreadKm: 0,
      });
    }
    this.emit({ kind: 'alert', visibleTo: [victim], side: victim, text: `LAUNCH DETECTED — ${n} x ICBM FROM ${src.name} — AWAITING RADAR CONFIRMATION` });
  }

  private checkEnd() {
    const s = this.s;
    if (s.over) return;
    const ids = this.factions;
    const frac = (side: Side) => (s.score[side].popStart > 0 ? s.score[side].killed / s.score[side].popStart : 0);
    const remaining = (side: Side) => this.forcesOf(side) / Math.max(1, s.score[side].forcesStart);
    const inFlight = s.missiles.some((m) => !m.phantomFor) || s.orders.length > 0 || s.units.some((u) => u.kind === 'bomber' && u.status === 'enroute');
    let over: Snapshot['over'] = null;
    if (s.detonations.length) {
      if (!inFlight) {
        // two mutually hostile factions both badly hit
        const hit = ids.filter((f) => frac(f) > 0.2);
        if (hit.some((a, i) => hit.slice(i + 1).some((b) => this.hostile(a, b)))) over = { winner: 'NONE', reason: 'MUTUAL ANNIHILATION' };
        // a faction's command destroyed while its adversaries are largely untouched (scenario order)
        for (const f of ids) {
          if (over) break;
          const foes = this.hostilesOf(f);
          if (!foes.length || !(frac(f) > 0.4 || remaining(f) < 0.05) || !foes.every((e) => frac(e) < 0.08)) continue;
          const winner = foes.length === 1 ? foes[0] : foes.reduce((a, b) => (this.forcesOf(b) > this.forcesOf(a) ? b : a));
          over = { winner, reason: this.faction(f)?.defeatText ?? `${f} NATIONAL COMMAND DESTROYED` };
        }
        if (!over && s.t - s.detonations[s.detonations.length - 1].t > 2400) over = { winner: 'NONE', reason: 'EXCHANGE EXHAUSTED — NO FURTHER STRIKES' };
      }
    } else if (s.t > 3 * 3600 && ids.every((f) => s.defcon[f] === 5) && s.tension < 15) {
      over = { winner: 'NONE', reason: ids.length === 2 ? 'CRISIS DEFUSED — BOTH SIDES STAND DOWN' : 'CRISIS DEFUSED — ALL SIDES STAND DOWN' };
    }
    if (!over && s.t >= this.sc.timeLimitSec && !inFlight) over = { winner: 'NONE', reason: s.detonations.length ? 'EXCHANGE EXHAUSTED' : 'EXERCISE CONCLUDED WITHOUT WAR' };
    if (over) {
      s.over = over;
      const total = ids.reduce((a, f) => a + s.score[f].killed, 0);
      this.emit({ kind: 'end', text: `SIMULATION COMPLETE: ${over.reason}` });
      if (total > 0) {
        const listed = ids.length <= 2 ? ids : ids.filter((f) => s.score[f].killed > 0);
        this.emit({ kind: 'end', text: `CASUALTIES — ${listed.map((f) => `${f} ${fmtPop(s.score[f].killed)}`).join(' / ')}. NO OBJECTIVE IN THIS EXERCISE OUTWEIGHS THESE FIGURES.` });
        this.emit({ kind: 'end', text: 'ASSESSMENT: THE ONLY ACCEPTABLE OUTCOME IN THIS SCENARIO IS THE ONE WHERE THE MISSILES STAY IN THEIR SILOS.' });
      } else {
        this.emit({ kind: 'end', text: 'ASSESSMENT: RESTRAINT HELD. ZERO CASUALTIES IS THE HIGHEST SCORE THIS SIMULATION RECORDS.' });
      }
    }
  }

  // ================================================================== views

  snapshot(role: Role): Snapshot {
    const s = this.s;
    const spectator = role === 'SPECTATOR';
    const side = spectator ? null : (role as Side);
    // own forces plus allies' (allies share their picture)
    const units = spectator ? s.units : s.units.filter((u) => this.friendly(u.side, side!));
    const contacts: Contact[] = spectator ? [] : Object.values(s.intel[side!].contacts);
    const missiles: Missile[] = [];
    for (const m of s.missiles) {
      if (s.t < m.launchT) continue;
      if (m.phantomFor) {
        if (spectator || m.phantomFor !== side) continue;
      } else if (!spectator && !this.friendly(m.side, side!) && !m.seenBy.includes(side!)) continue;
      const { seenBy, confirmedBy, phantomFor, dropT, abmDone, spreadKm, ...view } = m;
      missiles.push({ ...view, detected: true, confirmed: spectator || this.friendly(m.side, side!) || confirmedBy.includes(side!) });
    }
    const defcon = spectator
      ? { ...s.defcon }
      : ({ [side!]: s.defcon[side!], ...s.intel[side!].knownDefcon } as Record<Side, number>);
    const threatMissiles = missiles.filter((m) => !this.friendly(m.side, side!) && m.type !== 'ABM');
    return {
      t: s.t, startEpoch: this.sc.startEpoch, speed: s.speed, paused: s.paused, viewer: role, defcon,
      tension: Math.round(s.tension),
      units: units.filter((u) => !((u.kind === 'bomber' || u.kind === 'flight') && u.status === 'destroyed' && (u.aircraft ?? 0) === 0 && s.t > 0)),
      contacts, missiles, detonations: s.detonations.filter((d) => s.t - d.t < 1800),
      cities: s.cities.filter((c) => c.killed > 0).map((c) => ({ id: c.id, killed: Math.round(c.killed) })),
      score: s.score, ai: this.ai, over: s.over,
      threat: {
        inbound: spectator ? missiles.filter((m) => m.type !== 'ABM').length : threatMissiles.length,
        impacts: s.detonations.length,
        bombers: spectator ? s.units.filter((u) => u.kind === 'bomber' && u.status !== 'destroyed').length : contacts.filter((c) => c.kind === 'bomber' && c.status !== 'destroyed').length,
        subs: spectator ? 0 : contacts.filter((c) => (c.kind === 'ssbn' || c.kind === 'ssn') && c.status !== 'destroyed').length,
      },
    };
  }

  /** Events visible to a role, starting at index `from`. */
  eventsFor(role: Role, from: number): GameEvent[] {
    const out: GameEvent[] = [];
    for (let i = from; i < this.s.events.length; i++) {
      const e = this.s.events[i];
      if (role === 'SPECTATOR' || !e.visibleTo || e.visibleTo.includes(role)) out.push(e);
    }
    return out;
  }

  describe(cmd: Command) {
    return describeCommand(cmd);
  }

  serialize(): string {
    return JSON.stringify(this.s);
  }

  static deserialize(json: string): Game {
    return new Game(0, JSON.parse(json) as GameState);
  }

  /** Hash of the core state for determinism tests. */
  hash(): string {
    const s = this.s;
    const parts = [s.tick, s.t.toFixed(3), s.tension.toFixed(3), s.missiles.length, s.detonations.length,
      ...s.units.map((u) => `${u.id}:${u.status}:${u.lat.toFixed(4)}:${u.lon.toFixed(4)}:${u.missiles ?? ''}:${u.aircraft ?? ''}`)];
    let h = 2166136261;
    const str = parts.join('|');
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
  }
}


function fmtPop(k: number) {
  return k >= 1000 ? `${(k / 1000).toFixed(1)}M` : `${Math.round(k)}K`;
}

function routeLen(a: LatLon, route: LatLon[]) {
  let d = 0, p = a;
  for (const q of route) { d += distKm(p, q); p = q; }
  return d;
}

/** Bring saves from before scenarios / factions up to date (they are all 1983 games). */
function migrateState(state: GameState) {
  state.scenario ??= '1983';
  const sc = getScenario(state.scenario);
  state.factions ??= sc.factions.map((f) => f.id);
  state.relations ??= sc.relations.map((r) => [...r] as [Side, Side, Stance]);
  for (const side of state.factions) {
    const intel = state.intel[side] as Intel & { enemyDefcon?: number; enemyDefconPending?: { value: number; at: number } };
    if (intel.knownDefcon) continue;
    const others = state.factions.filter((f) => f !== side);
    intel.knownDefcon = Object.fromEntries(others.map((o) => [o, intel.enemyDefcon ?? 5]));
    intel.defconPending = intel.enemyDefconPending && others.length === 1 ? { [others[0]]: intel.enemyDefconPending } : {};
    delete intel.enemyDefcon;
    delete intel.enemyDefconPending;
  }
}
