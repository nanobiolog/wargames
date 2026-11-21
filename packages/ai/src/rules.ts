// Built-in doctrine AI: no API key needed; also the fallback when an LLM call fails.
import { enemyOf, hostilesOf, distKm, type Command, type Contact, type GameEvent, type Side, type Snapshot, type StaticWorld, type Unit } from '@coldlaunch/shared';
import { Rng } from '@coldlaunch/engine/core';

export class RuleBrain {
  private rng: Rng;
  private scrambled = new Set<string>();
  private retaliated = false;
  private atWar = false;
  private unconfirmedSince: number | null = null;
  private lastHotlineReplyT = -1e9;
  private lastPeaceT = -1e9;
  /** per carrier / fighter base: last recon and strike launch (game time) */
  private lastRecon = new Map<string, number>();
  private lastAirStrike = new Map<string, number>();
  private world?: StaticWorld;

  constructor(private side: Side, private personality = 0.5, seed = 7) {
    this.rng = new Rng(seed);
  }

  decide(s: Snapshot, events: GameEvent[], world?: StaticWorld): { cmds: Command[]; note: string } {
    this.world = world ?? this.world;
    const side = this.side, p = this.personality;
    // the adversary that matters most right now: the hostile faction at the highest readiness (classic: the other side)
    const hostiles = hostilesOf(this.world, side);
    const enemy = hostiles.reduce((a, b) => ((s.defcon[b] ?? 5) < (s.defcon[a] ?? 5) ? b : a), hostiles[0] ?? enemyOf(side));
    const cmds: Command[] = [];
    if (s.over || !hostiles.length) return { cmds, note: s.over ? 'over' : 'no adversary' };
    const own = s.defcon[side];
    const enemyDef = s.defcon[enemy] ?? 5;
    const inbound = s.missiles.filter((m) => hostiles.includes(m.side) && m.type !== 'ABM');
    const confirmed = inbound.filter((m) => m.confirmed);
    if (s.detonations.some((d) => hostiles.includes(d.side)) || s.score[side].killed > 0) this.atWar = true;
    const hitUs = this.atWar;
    // only our own forces: the snapshot also shows allies' units, which we cannot order
    const live = s.units.filter((u) => u.side === side && u.status !== 'destroyed');

    // --- diplomacy: react to hotline messages from the other side
    const newHot = events.filter((e) => e.kind === 'hotline' && !!e.from && e.from !== side);
    const capital = CAPITAL[side] ?? side;
    for (const h of newHot) {
      const peaceful = /stand ?down|de-?escalat|peace|calm|talk|withdraw|negotiat|no (?:hostile|intention)|exercise/i.test(h.text);
      const threat = /launch|strike|destroy|ultimatum|surrender|attack/i.test(h.text);
      if (s.t - this.lastHotlineReplyT > 120) {
        this.lastHotlineReplyT = s.t;
        const text = peaceful && !hitUs
          ? `${capital}: WE NOTE YOUR MESSAGE. WE WILL MATCH ANY VERIFIABLE STAND-DOWN OF YOUR FORCES.`
          : threat
            ? `${capital}: ANY ATTACK WILL BE MET WITH AN IMMEDIATE AND OVERWHELMING RESPONSE.`
            : `${capital}: MESSAGE RECEIVED. WE EXPECT YOUR FORCES TO RETURN TO PEACETIME POSTURE.`;
        // answer the sender only (in the classic game that is the one adversary anyway)
        cmds.push(hostiles.length === 1 && h.from === hostiles[0] ? { op: 'hotline', text } : { op: 'hotline', text, to: h.from });
      }
      if (peaceful) this.lastPeaceT = s.t;
    }

    // --- war: retaliation
    if (hitUs || confirmed.length) {
      if (own > 1) cmds.push({ op: 'defcon', level: own - 1 });
      else if (!this.retaliated) {
        this.retaliated = true;
        cmds.push(...this.fullStrike(s, live, hitUs || p > 0.5));
      } else {
        // follow-up: remaining missiles at whatever is left
        cmds.push(...this.fullStrike(s, live, true, true));
      }
      return { cmds, note: 'retaliation' };
    }

    // satellite-only warnings: doves wait for radar, hawks may jump the gun
    if (inbound.length) {
      this.unconfirmedSince ??= s.t;
      if (own > 1) cmds.push({ op: 'defcon', level: own - 1 });
      if (p > 0.85 && own === 1 && s.t - this.unconfirmedSince > 150 && !this.retaliated && this.rng.chance(0.5)) {
        this.retaliated = true;
        cmds.push({ op: 'hotline', text: 'WE HAVE DETECTED YOUR LAUNCH. WE ARE RESPONDING.' });
        cmds.push(...this.fullStrike(s, live, false));
      }
      return { cmds, note: 'warning' };
    }
    this.unconfirmedSince = null;

    // --- posture management
    const shift = (p - 0.5) * 30;
    let desired = s.tension < 30 + shift * -1 ? 5 : s.tension < 50 - shift ? 4 : s.tension < 72 - shift ? 3 : 2;
    // don't fall behind the adversary by more than one level
    desired = Math.min(desired, enemyDef + (p > 0.6 ? 0 : 1));
    if (s.t - this.lastPeaceT < 900 && enemyDef >= own) desired = Math.max(desired, Math.min(5, own + 1));
    if (desired < own) cmds.push({ op: 'defcon', level: own - 1 });
    else if (desired > own) cmds.push({ op: 'defcon', level: own + 1 });

    // bombers to the air at DEFCON 3
    if (own <= 3) {
      for (const b of live.filter((u) => u.kind === 'airbase' && (u.aircraft ?? 0) > 0)) {
        if (this.scrambled.has(b.id)) continue;
        this.scrambled.add(b.id);
        cmds.push({ op: 'scramble', base: b.id, count: Math.max(1, Math.ceil((b.aircraft ?? 0) * (0.4 + p * 0.4))) });
      }
    }
    // stand-down: recall orbiting bombers once things calm
    if (own >= 4) {
      for (const g of live.filter((u) => u.kind === 'bomber' && (u.status === 'orbit' || u.status === 'moving'))) cmds.push({ op: 'recall', unit: g.id });
      this.scrambled.clear();
    }
    cmds.push(...this.airOps(s, live, own));
    // hawkish first strike when the world is at the brink
    if (p >= 0.85 && own === 1 && enemyDef <= 2 && s.tension >= 95 && this.rng.chance(0.08) && !this.retaliated) {
      this.retaliated = true;
      cmds.push(...this.fullStrike(s, live, false));
      return { cmds, note: 'pre-emption' };
    }
    return { cmds, note: 'posture' };
  }

  /**
   * Naval aviation doctrine: recon patrols once tension rises (DEFCON 4), a standing CAP over every
   * carrier from DEFCON 3, and conventional strikes on known hostile surface groups once shooting has
   * started (or, for hawks, at DEFCON 2).
   */
  private airOps(s: Snapshot, live: Unit[], own: number): Command[] {
    const cmds: Command[] = [];
    const wings = live.filter((u) => (u.kind === 'carrier' || u.kind === 'afb_int') && (u.interceptors ?? 0) >= 2);
    const flights = live.filter((u) => u.kind === 'flight');
    const foes = new Set(hostilesOf(this.world, this.side));
    const hostileShips = s.contacts.filter((c) => c.status !== 'destroyed' && c.kind === 'carrier' && foes.has(c.side) && s.t - c.seenT < 1800);
    for (const w of wings) {
      const mine = flights.filter((f) => f.home === w.id);
      // CAP over carriers at DEFCON 3
      if (w.kind === 'carrier' && own <= 3 && !mine.some((f) => f.mission === 'cap') && (w.interceptors ?? 0) >= 6) {
        cmds.push({ op: 'sortie', from: w.id, mission: 'cap', count: 4 });
        continue;
      }
      // strikes on hostile surface groups in reach
      const canStrike = own <= 2 && (this.atWar || (this.personality > 0.8 && s.tension > 85));
      if (canStrike && s.t - (this.lastAirStrike.get(w.id) ?? -1e9) > 1800 && (w.interceptors ?? 0) >= 8) {
        const t = nearest(w, hostileShips, 1400);
        if (t) {
          this.lastAirStrike.set(w.id, s.t);
          cmds.push({ op: 'sortie', from: w.id, mission: 'strike', to: t.id, count: Math.min(12, (w.interceptors ?? 0) - 2) });
          continue;
        }
      }
      // reconnaissance once things heat up: where we have stale contacts, else the nearest sea area
      if (w.kind === 'carrier' && own <= 4 && !mine.some((f) => f.mission === 'recon') && s.t - (this.lastRecon.get(w.id) ?? -1e9) > 2400) {
        const stale = nearest(w, s.contacts.filter((c) => c.kind === 'carrier' && c.status !== 'destroyed' && s.t - c.seenT > 1200), 1400);
        const seas = (this.world?.seaAreas ?? []).filter((a) => { const d = distKm(w, a); return d > 300 && d < 1400; });
        const to = stale ? `${stale.lat.toFixed(2)},${stale.lon.toFixed(2)}` : seas.length ? seas[this.rng.int(0, seas.length - 1)].name : null;
        if (to) {
          this.lastRecon.set(w.id, s.t);
          cmds.push({ op: 'sortie', from: w.id, mission: 'recon', to, count: 2 });
        }
      }
    }
    return cmds;
  }

  /** Assign remaining missiles and bombers to targets: counterforce first, then countervalue. */
  private fullStrike(s: Snapshot, live: Unit[], countervalue: boolean, leftovers = false): Command[] {
    const cmds: Command[] = [];
    // only forces of hostile nations; neutrals are never targeted
    const foes = new Set(hostilesOf(this.world, this.side));
    const contacts = s.contacts.filter((c) => c.status !== 'destroyed' && c.identified && foes.has(c.side));
    const cf = [
      ...contacts.filter((c) => c.kind === 'silo'),
      ...contacts.filter((c) => c.kind === 'command'),
      ...contacts.filter((c) => c.kind === 'airbase'),
      ...contacts.filter((c) => c.kind === 'navalbase' || c.kind === 'radar'),
    ].map((c) => ({ id: c.id, lat: c.lat, lon: c.lon }));
    const hostiles = hostilesOf(this.world, this.side);
    const cityPos = new Map((this.world?.cities ?? []).map((c) => [c.name.toLowerCase(), c]));
    const cities = (countervalue ? hostiles.flatMap((h) => this.cityTargets(h)) : []).map((n) => ({ id: n, lat: cityPos.get(n)?.lat ?? NaN, lon: cityPos.get(n)?.lon ?? NaN }));
    const targets = leftovers ? [...cities, ...cf] : [...cf, ...cities];
    if (!targets.length) return cmds;
    let ti = 0;
    for (const u of live) {
      if ((u.kind !== 'silo' && u.kind !== 'ssbn') || !(u.missiles ?? 0)) continue;
      let left = u.missiles ?? 0;
      while (left > 0 && ti < targets.length * 3) {
        const t = targets[ti % targets.length];
        ti++;
        if (!Number.isNaN(t.lat) && distKm(u, t) > (u.rangeKm ?? 5000)) continue;
        const n = Math.min(left, u.kind === 'silo' ? 2 : 2);
        cmds.push({ op: 'launch', from: u.id, target: t.id, count: n });
        left -= n;
      }
    }
    let bi = 0;
    for (const g of live.filter((x) => x.kind === 'bomber' && x.status !== 'enroute' && (x.bombs ?? 0) > 0)) {
      const t = targets[(bi++ * 3 + 1) % targets.length];
      cmds.push({ op: 'strike', unit: g.id, target: t.id });
    }
    return cmds;
  }

  /** Countervalue list for a faction: the classic lists, otherwise its largest cities in the scenario. */
  private cityTargets(f: Side): string[] {
    if (CITY_TARGETS[f] && (!this.world?.scenarioId || this.world.scenarioId === '1983')) return CITY_TARGETS[f];
    return (this.world?.cities ?? []).filter((c) => c.side === f).sort((a, b) => b.pop - a.pop).slice(0, 10).map((c) => c.name.toLowerCase());
  }
}

function nearest(from: Unit, cs: Contact[], maxKm: number): Contact | undefined {
  let best: Contact | undefined, bd = maxKm;
  for (const c of cs) { const d = distKm(from, c); if (d < bd) { bd = d; best = c; } }
  return best;
}

const CAPITAL: Record<Side, string> = {
  USA: 'WASHINGTON', USSR: 'MOSCOW', RUS: 'MOSCOW', CHN: 'BEIJING', EUR: 'BRUSSELS', IND: 'NEW DELHI', PAK: 'ISLAMABAD', GBR: 'LONDON', FRA: 'PARIS',
};

const CITY_TARGETS: Record<Side, string[]> = {
  USA: ['washington', 'new york', 'chicago', 'los angeles', 'philadelphia', 'detroit', 'san francisco', 'boston', 'houston', 'seattle'],
  USSR: ['moscow', 'leningrad', 'kiev', 'gorky', 'sverdlovsk', 'kuibyshev', 'novosibirsk', 'kharkov', 'minsk', 'chelyabinsk'],
};
