import { describe, it, expect } from 'vitest';
import { Game, OceanNav, RouteJob } from '../src/core.ts';
import { loadLandMask } from '@coldlaunch/data';
import { normalizeCode, parseLink, shortCode, wsUrl, makeMatchLink, cleanCallsign, CODE_ALPHABET } from '@coldlaunch/shared';

describe('sliced ocean routing', () => {
  const nav = new OceanNav(loadLandMask());
  it('gives the same route whether run in slices or at once', () => {
    const a = { lat: 34, lon: 20 }, b = { lat: 68, lon: 5 }; // Med → Norwegian Sea via Gibraltar
    const full = nav.route(a, b);
    const job = nav.plan(a, b);
    expect(job).toBeInstanceOf(RouteJob);
    let r: ReturnType<RouteJob['run']>, slices = 0;
    while ((r = (job as RouteJob).run(2000)) === undefined) slices++;
    expect(slices).toBeGreaterThan(1);
    expect(r).toEqual(full);
  });
  it('resumes correctly after another search used the shared buffers', () => {
    const a = { lat: 34, lon: 20 }, b = { lat: 68, lon: 5 };
    const expected = nav.route(a, b);
    const job = nav.plan(a, b) as RouteJob;
    expect(job.run(3000)).toBeUndefined();
    nav.route({ lat: 43, lon: 34 }, { lat: 35, lon: 25 }); // interleaved search
    let r: ReturnType<RouteJob['run']>;
    while ((r = job.run(3000)) === undefined);
    expect(r).toEqual(expected);
  });
});

describe('ship orders do not block', () => {
  it('replies at once and the ship gets its route a few ticks later, also across save/load', () => {
    const g = new Game(7);
    const res = g.apply('USA', { op: 'move', unit: 'cvbg-midway', to: 'barents sea' });
    expect(res.ok).toBe(true);
    expect(res.msg).toMatch(/PLOTTING COURSE/);
    g.step();
    const g2 = Game.deserialize(g.serialize()); // saved mid-search
    for (let i = 0; i < 400 && g.s.routeQueue?.length; i++) g.step();
    for (let i = 0; i < 400 && g2.s.routeQueue?.length; i++) g2.step();
    expect(g.unit('cvbg-midway')!.route?.length).toBeGreaterThan(0);
    expect(g2.hash()).toBe(g.hash());
  });
});

describe('short codes and links', () => {
  it('makes readable 5-char codes and normalises input', () => {
    for (let i = 0; i < 50; i++) {
      const c = shortCode();
      expect(c).toMatch(/^[2-9A-Z]{5}$/);
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
      expect(normalizeCode(c.toLowerCase())).toBe(c);
    }
    expect(normalizeCode(' k7m-2q ')).toBe('K7M2Q');
    expect(normalizeCode('K7M2')).toBeNull();
    expect(normalizeCode('K0M2Q')).toBeNull(); // 0/O/1/I/L are not used
  });
  it('parses online match links and builds the websocket URL', () => {
    const p = parseLink(makeMatchLink('https://play.example.com', 'K7M2Q', 'USSR'))!;
    expect(p).toMatchObject({ host: 'play.example.com', token: 'K7M2Q', role: 'USSR', online: true, secure: true });
    expect(wsUrl(p)).toBe('wss://play.example.com/m/K7M2Q/ws');
    expect(wsUrl(parseLink('http://127.0.0.1:8787/m/k7m2q')!)).toBe('ws://127.0.0.1:8787/m/K7M2Q/ws');
    expect(parseLink('coldlaunch://127.0.0.1:7700/s/abc123?role=USA')).toMatchObject({ port: 7700, token: 'abc123', role: 'USA' });
  });
  it('cleans callsigns', () => {
    expect(cleanCallsign('  raven<script>-42 ')).toBe('RAVENSCRIPT-42');
    expect(cleanCallsign('x')).toBeNull();
  });
});
