import { describe, it, expect } from 'vitest';
import { Game } from '../src/core.ts';
import { distKm } from '@coldlaunch/shared';

function runFor(g: Game, gameSeconds: number) {
  const ticks = Math.ceil(gameSeconds / (0.1 * g.s.speed));
  for (let i = 0; i < ticks; i++) g.step();
}
function escalate(g: Game, side: string, to: number) {
  for (let lvl = g.s.defcon[side] - 1; lvl >= to; lvl--) {
    runFor(g, 95);
    expect(g.apply(side, { op: 'defcon', level: lvl }).ok).toBe(true);
  }
}
const texts = (g: Game, side: string) => g.eventsFor(side, 0).map((e) => e.text).join('\n');

describe('reconnaissance satellites', () => {
  it('orbit the Earth, are seen by everyone, and image ships under their swath', () => {
    const g = new Game(2, undefined, 'modern', 'open');
    g.s.speed = 30;
    expect(g.apply('USA', { op: 'move', unit: 'm-sat-kh11-1', to: 'arctic ocean' }).msg).toMatch(/IN ORBIT/);
    const sat = g.unit('m-sat-kh11-1')!;
    const p0 = { lat: sat.lat, lon: sat.lon };
    runFor(g, 600);
    expect(distKm(p0, sat)).toBeGreaterThan(3000); // ~7 km/s ground speed
    expect(Math.abs(sat.lat)).toBeLessThanOrEqual(82.2); // inclination 97.9° → max latitude ~82°
    expect(g.snapshot('CHN').contacts.some((c) => c.id === 'm-sat-kh11-1' && c.identified)).toBe(true);
    runFor(g, 4 * 3600);
    expect(texts(g, 'USA')).toMatch(/KH-11 BLOCK IV \(\d\): IMAGED .* GROUP/);
  });
});

describe('drones', () => {
  it('an ISR drone flies out, watches for hours and identifies ships', () => {
    const g = new Game(3, undefined, 'modern');
    g.s.speed = 30;
    const r = g.apply('USA', { op: 'sortie', from: 'm-int-kadena', mission: 'drone', to: 'east china sea' });
    expect(r.ok, r.msg).toBe(true);
    const uav = g.s.units.find((u) => u.mission === 'drone')!;
    runFor(g, 3 * 3600);
    expect(uav.status).toBe('orbit');
    expect(texts(g, 'USA')).toMatch(/UAV-KADENA-1: SIGHTED .*(LIAONING|FUJIAN)/);
  });

  it('attack swarms need DEFCON 2, take losses to air defence and damage what is left', () => {
    const g = new Game(4, undefined, 'modern');
    g.s.speed = 30;
    expect(g.apply('RUS', { op: 'sortie', from: 'm-ab-engels', mission: 'swarm', to: 'm-int-coningsby', count: 20 }).msg).toMatch(/DEFCON 2/);
    escalate(g, 'RUS', 2);
    escalate(g, 'EUR', 2);
    const target = g.unit('m-ab-stdizier')!;
    expect(g.apply('RUS', { op: 'sortie', from: 'm-ab-engels', mission: 'swarm', to: 'm-ab-stdizier' }).msg).toMatch(/DRONE RANGE/);
    const r = g.apply('RUS', { op: 'sortie', from: 'm-int-chkalovsk', mission: 'swarm', to: 'm-ab-stdizier', count: 6 });
    expect(r.ok, r.msg).toBe(true);
    runFor(g, 10 * 3600);
    expect(texts(g, 'RUS')).toMatch(/SWM-CHKALOVSK-1: (.*HIT BY \d+ DRONES|.*DESTROYED|NO TARGET)|SHOT DOWN/);
    expect(target.hp).toBeLessThanOrEqual(1);
  });

  it('bases without drones say so; 1983 has none', () => {
    const g = new Game(1);
    expect(g.apply('USA', { op: 'sortie', from: 'cvbg-midway', mission: 'drone', to: 'sea of japan' }).msg).toMatch(/NO DRONES/);
  });
});

describe('cruise missiles', () => {
  it('are invisible until a radar near the track sees them, and hit a base', () => {
    const g = new Game(5, undefined, 'modern');
    g.s.speed = 30;
    escalate(g, 'USA', 2);
    // a Russian naval base: fixed, so it is still there when the missiles arrive
    const r = g.apply('USA', { op: 'cruise', from: 'm-ssn-virginia', target: 'm-nb-severomorsk', count: 6 });
    expect(r.ok, r.msg).toBe(true);
    expect(g.unit('m-ssn-virginia')!.cruise).toBe(6);
    runFor(g, 120);
    // a minute in: no satellite launch warning for cruise missiles
    expect(texts(g, 'RUS')).not.toMatch(/LAUNCH DETECTED — CRUISE/);
    runFor(g, 3 * 3600);
    const rus = texts(g, 'RUS');
    expect(rus).toMatch(/LOW-LEVEL TRACKS: CRUISE MISSILES/);
    expect(texts(g, 'USA')).toMatch(/CRUISE MISSILE HIT ON SEVEROMORSK|SEVEROMORSK DESTROYED|SHOOTS DOWN CRUISE MISSILE/);
    expect(g.apply('USA', { op: 'cruise', from: 'm-ssn-virginia', target: 'moscow' }).msg).toMatch(/MILITARY TARGETS ONLY/);
  });

  it('carrier air defence shoots some down', () => {
    let downed = 0;
    for (const seed of [1, 2, 3]) {
      const g = new Game(seed, undefined, 'modern');
      g.s.speed = 30;
      escalate(g, 'RUS', 2);
      const ford = g.unit('m-csg-ford')!;
      const sag = g.unit('m-sag-northern')!;
      sag.lat = ford.lat + 6; sag.lon = ford.lon; sag.dest = null; sag.route = undefined;
      g.s.intel.RUS.contacts[ford.id] = { id: ford.id, side: 'USA', kind: 'carrier', name: ford.name, cls: ford.cls, lat: ford.lat, lon: ford.lon, status: ford.status, identified: true, seenT: g.s.t };
      expect(g.apply('RUS', { op: 'cruise', from: sag.id, target: ford.id, count: 12 }).ok).toBe(true);
      runFor(g, 3600);
      downed += (texts(g, 'USA').match(/SHOOTS DOWN CRUISE MISSILE/g) ?? []).length;
    }
    expect(downed).toBeGreaterThan(0);
  });
});

describe('open-ended games', () => {
  it('keep going past the scenario endings and announce milestones instead', () => {
    const g = new Game(6, undefined, '1983', 'open');
    g.s.speed = 60;
    runFor(g, 9 * 3600);
    expect(g.s.over).toBeNull();
    expect(texts(g, 'USA')).toMatch(/MILESTONE: THE SCENARIO'S PLANNED TIME HAS PASSED/);
  });

  it('a nation that loses everything is out; the last one standing wins', () => {
    const g = new Game(7, undefined, '1983', 'open');
    for (const u of g.s.units) if (u.side === 'USSR' && u.kind !== 'satellite') { u.status = 'destroyed'; u.missiles = 0; u.aircraft = 0; u.interceptors = 0; }
    runFor(g, 30);
    expect(g.s.out).toContain('USSR');
    expect(g.s.over?.winner).toBe('USA');
    expect(g.apply('USSR', { op: 'defcon', level: 4 }).ok).toBe(false);
  });

  it('resign takes a nation out; in a five-nation game the others play on', () => {
    const g = new Game(8, undefined, 'modern', 'open');
    expect(g.apply('IND', { op: 'resign' }).ok).toBe(true);
    runFor(g, 60);
    expect(g.s.out).toEqual(['IND']);
    expect(g.s.over).toBeNull();
    expect(g.apply('IND', { op: 'defcon', level: 4 }).msg).toMatch(/OUT OF THE WAR/);
    expect(g.snapshot('USA').out).toEqual(['IND']);
    expect(new Game(9).apply('USA', { op: 'resign' }).msg).toMatch(/ONLY POSSIBLE IN OPEN-ENDED/);
  });
});
