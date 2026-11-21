import { describe, it, expect } from 'vitest';
import { Game } from '../src/core.ts';

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

describe('carrier air operations', () => {
  it('recon finds and identifies an enemy surface group, then the flight recovers aboard', () => {
    const g = new Game(11);
    g.s.speed = 30;
    const minsk = g.unit('sag-minsk')!;
    expect(g.snapshot('USA').contacts.find((c) => c.id === 'sag-minsk')).toBeUndefined();
    const before = g.unit('cvbg-midway')!.interceptors!;
    const r = g.apply('USA', { op: 'sortie', from: 'cvbg-midway', mission: 'recon', to: `${minsk.lat},${minsk.lon}` });
    expect(r.ok, r.msg).toBe(true);
    expect(g.unit('cvbg-midway')!.interceptors).toBe(before - 2);
    runFor(g, 3 * 3600);
    expect(texts(g, 'USA')).toMatch(/SIGHTED MINSK TASK FORCE/);
    const c = Object.values(g.s.intel.USA.contacts).find((x) => x.name === 'MINSK TASK FORCE');
    expect(c?.identified).toBe(true);
    runFor(g, 3 * 3600);
    expect(texts(g, 'USA')).toMatch(/RECOVERED ON MIDWAY BATTLE GROUP/);
    expect(g.unit('cvbg-midway')!.interceptors).toBe(before);
  });

  it('respects DEFCON: CAP needs 4, strikes need 2, recon is always allowed', () => {
    const g = new Game(3);
    expect(g.apply('USA', { op: 'sortie', from: 'cvbg-eisenhower', mission: 'cap' }).msg).toMatch(/REQUIRE DEFCON 4/);
    expect(g.apply('USA', { op: 'sortie', from: 'cvbg-eisenhower', mission: 'strike', to: 'sag-kiev' }).ok).toBe(false);
    expect(g.apply('USA', { op: 'sortie', from: 'cvbg-eisenhower', mission: 'recon', to: 'mediterranean' }).ok).toBe(true);
    expect(g.apply('USA', { op: 'sortie', from: 'icbm-minot', mission: 'recon', to: 'barents sea' }).msg).toMatch(/HAS NO FIGHTERS/);
    expect(g.apply('USA', { op: 'sortie', from: 'cvbg-eisenhower', mission: 'recon', to: 'hawaii' }).msg).toMatch(/COMBAT RADIUS/);
  });

  it('CAP shoots down hostile bombers at DEFCON 3', () => {
    const g = new Game(5);
    g.s.speed = 30;
    escalate(g, 'USA', 3);
    escalate(g, 'USSR', 3);
    const base = g.s.units.find((u) => u.side === 'USSR' && u.kind === 'airbase' && (u.aircraft ?? 0) > 0)!;
    expect(g.apply('USSR', { op: 'scramble', base: base.id, count: 6 }).ok).toBe(true);
    const bmr = g.s.units.find((u) => u.side === 'USSR' && u.kind === 'bomber')!;
    for (let i = 0; i < 200 && bmr.status !== 'orbit'; i++) runFor(g, 300);
    expect(bmr.status).toBe('orbit');
    // bring a carrier under the orbit and put its whole air wing up as CAP (no fighters left aboard)
    const cv = g.unit('cvbg-enterprise')!;
    cv.lat = bmr.lat + 2; cv.lon = bmr.lon; cv.dest = null; cv.route = undefined; cv.defenceKm = 0;
    const r = g.apply('USA', { op: 'sortie', from: cv.id, mission: 'cap', to: `${bmr.lat},${bmr.lon}`, count: 24 });
    expect(r.ok, r.msg).toBe(true);
    expect(cv.interceptors).toBe(0);
    const before = bmr.aircraft!;
    runFor(g, 2 * 3600);
    expect(bmr.aircraft!).toBeLessThan(before);
    expect(texts(g, 'USA')).toMatch(/CAP-ENTERPRISE-1 ON STATION/);
  });

  it('a conventional strike damages or sinks a ship group and surface groups fight at DEFCON 2', () => {
    const g = new Game(9);
    g.s.speed = 30;
    escalate(g, 'USA', 2);
    escalate(g, 'USSR', 2);
    const kiev = g.unit('sag-kiev')!;
    const ike = g.unit('cvbg-eisenhower')!;
    // make sure the US holds a contact on the Kiev group
    expect(g.apply('USA', { op: 'sortie', from: ike.id, mission: 'recon', to: `${kiev.lat},${kiev.lon}` }).ok).toBe(true);
    runFor(g, 2 * 3600);
    const contact = Object.entries(g.s.intel.USA.contacts).find(([real]) => real === 'sag-kiev');
    expect(contact).toBeTruthy();
    const r = g.apply('USA', { op: 'sortie', from: ike.id, mission: 'strike', to: contact![1].id, count: 12 });
    expect(r.ok, r.msg).toBe(true);
    runFor(g, 3 * 3600);
    expect(texts(g, 'USA')).toMatch(/STRIKE: (KIEV TASK FORCE (HIT|DESTROYED))/);
    expect(g.unit('sag-kiev')!.hp).toBeLessThan(1);
  });

  it('coastal radar tracks ships near the coast and intelligence summaries arrive', () => {
    const g = new Game(4);
    g.s.speed = 30;
    // park a Soviet group just off a US early-warning radar
    const radar = g.s.units.find((u) => u.side === 'USA' && u.kind === 'radar')!;
    const sag = g.unit('sag-northern')!;
    sag.lat = radar.lat + 1.5; sag.lon = radar.lon + 1.5; sag.dest = null; sag.route = undefined;
    runFor(g, 120);
    expect(g.s.intel.USA.contacts['sag-northern']).toBeTruthy();
    runFor(g, 1900);
    expect(texts(g, 'USA')).toMatch(/INTEL SUMMARY \d\d:\d\dZ — TRACKING .*SURFACE GROUP/);
  });
});
