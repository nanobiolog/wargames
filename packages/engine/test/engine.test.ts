import { describe, expect, it } from 'vitest';
import {
  distKm, gcInterpolate, makeProjection, parseCommandLine, parseLatLon, ballisticFlightSec, CommandSchema,
} from '@coldlaunch/shared';
import { Game, OceanNav } from '@coldlaunch/engine';
import { loadLandMask } from '@coldlaunch/data';

const NY = { lat: 40.71, lon: -74.01 };
const MOSCOW = { lat: 55.76, lon: 37.62 };

function runFor(g: Game, gameSeconds: number) {
  const ticks = Math.ceil(gameSeconds / (0.1 * g.s.speed));
  for (let i = 0; i < ticks; i++) g.step();
}

function escalate(g: Game, side: 'USA' | 'USSR', to: number) {
  for (let lvl = g.s.defcon[side] - 1; lvl >= to; lvl--) {
    runFor(g, 95);
    expect(g.apply(side, { op: 'defcon', level: lvl }).ok).toBe(true);
  }
}

describe('geo', () => {
  it('great-circle distance New York → Moscow ≈ 7500 km', () => {
    expect(distKm(NY, MOSCOW)).toBeGreaterThan(7400);
    expect(distKm(NY, MOSCOW)).toBeLessThan(7600);
  });
  it('interpolation endpoints', () => {
    const a = gcInterpolate(NY, MOSCOW, 0), b = gcInterpolate(NY, MOSCOW, 1);
    expect(distKm(a, NY)).toBeLessThan(0.01);
    expect(distKm(b, MOSCOW)).toBeLessThan(0.01);
    // the polar route peaks well north of both cities
    expect(gcInterpolate(NY, MOSCOW, 0.5).lat).toBeGreaterThan(60);
  });
  it('polar projection round-trips', () => {
    const p = makeProjection('polar', -100);
    const [x, y] = p.project(47.9, -97.4);
    const [lat, lon] = p.invert(x, y);
    expect(lat).toBeCloseTo(47.9, 6);
    expect(lon).toBeCloseTo(-97.4, 6);
  });
  it('parses coordinates', () => {
    expect(parseLatLon('47.9N 97.4W')).toEqual({ lat: 47.9, lon: -97.4 });
    expect(parseLatLon('55.7, 37.6')).toEqual({ lat: 55.7, lon: 37.6 });
    expect(parseLatLon('moscow')).toBeNull();
  });
  it('ICBM flight time is about half an hour over 9000 km', () => {
    const t = ballisticFlightSec(9000, 'ICBM');
    expect(t).toBeGreaterThan(1500);
    expect(t).toBeLessThan(2000);
  });
});

describe('command parsing', () => {
  it('parses launch with count', () => {
    const r = parseCommandLine('launch icbm-minot at Moscow x 3');
    expect(r).toEqual({ kind: 'cmd', cmd: { op: 'launch', from: 'icbm-minot', target: 'Moscow', count: 3 } });
  });
  it('parses scramble and move', () => {
    expect(parseCommandLine('scramble afb-loring 4 to 70N 30W')).toMatchObject({ kind: 'cmd', cmd: { op: 'scramble', base: 'afb-loring', count: 4, to: '70N 30W' } });
    expect(parseCommandLine('move cvbg-midway to sea of japan')).toMatchObject({ kind: 'cmd', cmd: { op: 'move', unit: 'cvbg-midway', to: 'sea of japan' } });
  });
  it('rejects invalid commands in the schema', () => {
    expect(CommandSchema.safeParse({ op: 'defcon', level: 0 }).success).toBe(false);
    expect(CommandSchema.safeParse({ op: 'launch', from: 'x' }).success).toBe(false);
  });
  it('unknown verbs fall through', () => {
    expect(parseCommandLine('zoom moscow').kind).toBe('none');
  });
});

describe('engine rules', () => {
  it('blocks launches above DEFCON 1 and enforces stepwise escalation', () => {
    const g = new Game(1);
    expect(g.apply('USA', { op: 'launch', from: 'icbm-minot', target: 'moscow' }).ok).toBe(false);
    expect(g.apply('USA', { op: 'defcon', level: 3 }).ok).toBe(false); // can't skip a level
    runFor(g, 95);
    expect(g.apply('USA', { op: 'defcon', level: 4 }).ok).toBe(true);
    expect(g.apply('USA', { op: 'defcon', level: 3 }).ok).toBe(false); // too soon
  });

  it('launches, flies and detonates', () => {
    const g = new Game(2);
    escalate(g, 'USA', 1);
    const r = g.apply('USA', { op: 'launch', from: 'icbm-minot', target: 'kozelsk', count: 2 });
    expect(r.ok).toBe(true);
    expect(g.unit('icbm-minot')!.missiles).toBe(13);
    runFor(g, 60);
    expect(g.s.missiles.filter((m) => m.side === 'USA').length).toBe(2);
    runFor(g, 2200);
    expect(g.s.detonations.length).toBeGreaterThan(0);
    const koz = g.unit('icbm-kozelsk')!;
    expect(koz.missiles!).toBeLessThan(8);
  });

  it('bombers scramble only at DEFCON 3 and orbit', () => {
    const g = new Game(3);
    expect(g.apply('USA', { op: 'scramble', base: 'afb-loring' }).ok).toBe(false);
    escalate(g, 'USA', 3);
    const r = g.apply('USA', { op: 'scramble', base: 'afb-loring', count: 3 });
    expect(r.ok).toBe(true);
    const grp = g.s.units.find((u) => u.kind === 'bomber')!;
    expect(grp.aircraft).toBe(3);
    runFor(g, 3 * 3600);
    expect(['orbit', 'returning', 'destroyed']).toContain(grp.status);
  }, 30000);

  it('fog of war hides submerged enemy submarines', () => {
    const g = new Game(4);
    runFor(g, 60);
    const snap = g.snapshot('USA');
    expect(snap.units.every((u) => u.side === 'USA')).toBe(true);
    expect(snap.contacts.some((c) => c.kind === 'ssbn')).toBe(false);
    expect(snap.contacts.some((c) => c.kind === 'silo')).toBe(true); // fixed sites are known
    expect(JSON.stringify(snap)).not.toContain('ssbn-k219');
  });

  it('is deterministic for the same seed and commands', () => {
    const play = () => {
      const g = new Game(42);
      escalate(g, 'USA', 1);
      g.apply('USA', { op: 'launch', from: 'icbm-warren', target: 'tatishchevo', count: 3 });
      runFor(g, 1500);
      return g.hash();
    };
    expect(play()).toBe(play());
  });

  it('save/load round-trips', () => {
    const g = new Game(5);
    runFor(g, 300);
    const g2 = Game.deserialize(g.serialize());
    expect(g2.hash()).toBe(g.hash());
    runFor(g, 100);
    runFor(g2, 100);
    expect(g2.hash()).toBe(g.hash());
  });
});

describe('ocean routing', () => {
  const nav = new OceanNav(loadLandMask());
  it('knows land from sea', () => {
    expect(nav.isLand({ lat: 50, lon: 10 })).toBe(true); // Germany
    expect(nav.isLand({ lat: 40, lon: -40 })).toBe(false); // Atlantic
  });
  it('never routes through inland lakes (Norwegian Sea → Barents stays at sea)', () => {
    const a = { lat: 66.5, lon: -1 }, b = { lat: 73, lon: 40 };
    const r = nav.route(a, b)!;
    expect(r).not.toBeNull();
    let len = 0, p = a;
    for (const q of r) { len += distKm(p, q); p = q; }
    expect(len).toBeLessThan(3200);
    expect(r.some((q) => q.lat < 62 && q.lon > 15 && q.lon < 35)).toBe(false); // not via the Baltic / Finland
  });
  it('keeps the Bosporus and the Danish straits open', () => {
    expect(nav.route({ lat: 43, lon: 34 }, { lat: 35, lon: 25 })).not.toBeNull(); // Black Sea → Aegean
    expect(nav.route({ lat: 55, lon: 18 }, { lat: 57, lon: 5 })).not.toBeNull(); // Baltic → North Sea
  });
  it('routes Mediterranean → Norwegian Sea via Gibraltar', () => {
    const r = nav.route({ lat: 34, lon: 20 }, { lat: 68, lon: 5 });
    expect(r).not.toBeNull();
    expect(r!.some((p) => p.lon < -5)).toBe(true); // went west through the strait
  });
});
