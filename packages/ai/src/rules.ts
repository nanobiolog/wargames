// Built-in doctrine AI: no API key needed; also the fallback when an LLM call fails.
import { enemyOf, distKm, type Command, type GameEvent, type Side, type Snapshot, type Unit } from '@coldlaunch/shared';
import { Rng } from '@coldlaunch/engine';

export class RuleBrain {
  private rng: Rng;
  private scrambled = new Set<string>();
  private retaliated = false;
  private atWar = false;
  private unconfirmedSince: number | null = null;
  private lastHotlineReplyT = -1e9;
  private lastPeaceT = -1e9;

  constructor(private side: Side, private personality = 0.5, seed = 7) {
    this.rng = new Rng(seed);
  }

  decide(s: Snapshot, events: GameEvent[]): { cmds: Command[]; note: string } {
    const side = this.side, enemy = enemyOf(side), p = this.personality;
    const cmds: Command[] = [];
    if (s.over) return { cmds, note: 'over' };
    const own = s.defcon[side];
    const enemyDef = s.defcon[enemy];
    const inbound = s.missiles.filter((m) => m.side === enemy && m.type !== 'ABM');
    const confirmed = inbound.filter((m) => m.confirmed);
    if (s.detonations.some((d) => d.side === enemy) || s.score[side].killed > 0) this.atWar = true;
    const hitUs = this.atWar;
    const live = s.units.filter((u) => u.status !== 'destroyed');

    // --- diplomacy: react to hotline messages from the other side
    const newHot = events.filter((e) => e.kind === 'hotline' && e.from === enemy);
    for (const h of newHot) {
      const peaceful = /stand ?down|de-?escalat|peace|calm|talk|withdraw|negotiat|no (?:hostile|intention)|exercise/i.test(h.text);
      const threat = /launch|strike|destroy|ultimatum|surrender|attack/i.test(h.text);
      if (s.t - this.lastHotlineReplyT > 120) {
        this.lastHotlineReplyT = s.t;
        const text = peaceful && !hitUs
          ? `${side === 'USSR' ? 'MOSCOW' : 'WASHINGTON'}: WE NOTE YOUR MESSAGE. WE WILL MATCH ANY VERIFIABLE STAND-DOWN OF YOUR FORCES.`
          : threat
            ? `${side === 'USSR' ? 'MOSCOW' : 'WASHINGTON'}: ANY ATTACK WILL BE MET WITH AN IMMEDIATE AND OVERWHELMING RESPONSE.`
            : `${side === 'USSR' ? 'MOSCOW' : 'WASHINGTON'}: MESSAGE RECEIVED. WE EXPECT YOUR FORCES TO RETURN TO PEACETIME POSTURE.`;
        cmds.push({ op: 'hotline', text });
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
    // hawkish first strike when the world is at the brink
    if (p >= 0.85 && own === 1 && enemyDef <= 2 && s.tension >= 95 && this.rng.chance(0.08) && !this.retaliated) {
      this.retaliated = true;
      cmds.push(...this.fullStrike(s, live, false));
      return { cmds, note: 'pre-emption' };
    }
    return { cmds, note: 'posture' };
  }

  /** Assign remaining missiles and bombers to targets: counterforce first, then countervalue. */
  private fullStrike(s: Snapshot, live: Unit[], countervalue: boolean, leftovers = false): Command[] {
    const cmds: Command[] = [];
    const contacts = s.contacts.filter((c) => c.status !== 'destroyed' && c.identified);
    const cf = [
      ...contacts.filter((c) => c.kind === 'silo'),
      ...contacts.filter((c) => c.kind === 'command'),
      ...contacts.filter((c) => c.kind === 'airbase'),
      ...contacts.filter((c) => c.kind === 'navalbase' || c.kind === 'radar'),
    ].map((c) => ({ id: c.id, lat: c.lat, lon: c.lon }));
    const enemy = enemyOf(this.side);
    const cities = (countervalue ? CITY_TARGETS[enemy] : []).map((n) => ({ id: n, lat: NaN, lon: NaN }));
    const targets = leftovers ? [...cities, ...cf] : [...cf, ...cities];
    if (!targets.length) return cmds;
    let ti = 0;
    for (const u of live) {
      if ((u.kind !== 'silo' && u.kind !== 'ssbn') || !(u.missiles ?? 0)) continue;
      let left = u.missiles ?? 0;
      while (left > 0 && ti < targets.length * 3) {
        const t = targets[ti % targets.length];
        ti++;
        if (u.kind === 'ssbn' && !Number.isNaN(t.lat) && distKm(u, t) > (u.rangeKm ?? 5000)) continue;
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
}

const CITY_TARGETS: Record<Side, string[]> = {
  USA: ['washington', 'new york', 'chicago', 'los angeles', 'philadelphia', 'detroit', 'san francisco', 'boston', 'houston', 'seattle'],
  USSR: ['moscow', 'leningrad', 'kiev', 'gorky', 'sverdlovsk', 'kuibyshev', 'novosibirsk', 'kharkov', 'minsk', 'chelyabinsk'],
};
