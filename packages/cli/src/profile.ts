// Engine profiler: npm run profile -- [--seed 1] [--hawk 0.95] [--games 3]
// Plays full rules-vs-rules matches headless and times each engine phase, plus nav routing,
// the type-ahead (suggest) and fog-of-war snapshot paths that run per client per tick.
import { performance } from 'node:perf_hooks';
import { Game, OceanNav, warmNav } from '@coldlaunch/engine';
import { AiOpponent, makeProvider, type AiHost } from '@coldlaunch/ai';
import { loadLandMask, SEA_AREAS } from '@coldlaunch/data';
import { suggest, nextOrders, type Command, type Side } from '@coldlaunch/shared';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};

type Stat = { n: number; total: number; max: number; samples: number[] };
const stats = new Map<string, Stat>();
function rec(name: string, ms: number) {
  let s = stats.get(name);
  if (!s) stats.set(name, (s = { n: 0, total: 0, max: 0, samples: [] }));
  s.n++; s.total += ms; if (ms > s.max) s.max = ms;
  if (s.samples.length < 200_000) s.samples.push(ms);
}
function timed<T>(name: string, fn: () => T): T {
  const t0 = performance.now();
  try { return fn(); } finally { rec(name, performance.now() - t0); }
}

// Wrap Game's private phase methods so step() reports per-phase timings.
const proto = Game.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const phase of ['processRoutes', 'fireOrders', 'moveUnits', 'updateMissiles', 'combat', 'updateIntel', 'crisis', 'checkEnd']) {
  const orig = proto[phase];
  proto[phase] = function (this: unknown, ...a: unknown[]) {
    const t0 = performance.now();
    try { return orig.apply(this, a); } finally { rec(`step.${phase}`, performance.now() - t0); }
  };
}
const origRoute = OceanNav.prototype.route; // direct (unsliced) routes, e.g. tests/tools
OceanNav.prototype.route = function (a, b) {
  const t0 = performance.now();
  try { return origRoute.call(this, a, b); } finally { rec('nav.route', performance.now() - t0); }
};

const navProto = OceanNav.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const m of ['finish', 'expand']) {
  const orig = navProto[m];
  navProto[m] = function (this: unknown, ...a: unknown[]) {
    const t0 = performance.now();
    try { return orig.apply(this, a); } finally { rec(`nav.${m}`, performance.now() - t0); }
  };
}
const t0 = performance.now();
const navBuild = new OceanNav(loadLandMask());
rec('nav.build (once per process)', performance.now() - t0);
void navBuild;
warmNav(); // what the server does at start-up

const games = parseInt(arg('--games', '3'), 10);
const seed0 = parseInt(arg('--seed', '1'), 10);
const hawk = parseFloat(arg('--hawk', '0.95'));
let ticks = 0;

for (let g = 0; g < games; g++) {
  const game = new Game(seed0 + g);
  game.s.speed = 30;
  const listeners = new Set<(g: Game) => void>();
  const host: AiHost = {
    game,
    submit: (side: Side, cmd: Command) => timed('apply', () => game.apply(side, cmd)),
    onTick: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  new AiOpponent(host, 'USA', makeProvider('rules'), { personality: 0.4, cadenceSec: 60 }).attach();
  new AiOpponent(host, 'USSR', makeProvider('rules'), { personality: hawk, cadenceSec: 60 }).attach();
  const world = game.staticWorld();
  const maxTicks = (12 * 3600) / (0.1 * game.s.speed);
  for (let i = 0; i < maxTicks && !game.s.over; i++, ticks++) {
    const routing = !!game.s.routeQueue?.length;
    timed(routing ? 'step (while routing)' : 'step (total)', () => game.step());
    timed('ai.onTick (rules)', () => { for (const fn of listeners) fn(game); });
    // every ~10 game-minutes, order a random ship to a random sea area (exercises sliced routing)
    if (i % 200 === 0) {
      const ships = game.s.units.filter((u) => ['carrier', 'ssbn', 'ssn'].includes(u.kind) && u.status !== 'destroyed');
      if (ships.length) {
        const u = ships[(i / 200) % ships.length];
        const sea = SEA_AREAS[(i / 200 * 7) % SEA_AREAS.length];
        timed('apply.move (player latency)', () => game.apply(u.side, { op: 'move', unit: u.id, to: sea.name }));
      }
    }
    // a server sends 5 Hz snapshots to every client: USA, USSR, spectator
    if (i % 2 === 0) {
      for (const role of ['USA', 'USSR', 'SPECTATOR'] as const) {
        const snap = timed(`snapshot.${role}`, () => game.snapshot(role));
        timed(`json.${role}`, () => JSON.stringify({ t: 'snap', snap }));
      }
    }
    // type-ahead runs on each keystroke on the client; sample it every 50 ticks
    if (i % 50 === 0) {
      const snap = game.snapshot('USA');
      for (const input of ['', 'launch icbm-', 'launch icbm-minot at ', 'move cvbg-midway to sea', 'scramble ']) {
        timed('suggest', () => suggest(input, { snap, world, role: 'USA', where: 'gui' }));
      }
      timed('nextOrders', () => nextOrders({ snap, world, role: 'USA', where: 'gui' }));
    }
  }
  console.log(`game ${g + 1}: ${game.s.over?.reason ?? 'time limit'}  T+${(game.s.t / 3600).toFixed(2)}h  missiles ${game.s.missiles.length}  detonations ${game.s.detonations.length}`);
}

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};
const rows = [...stats.entries()].sort((a, b) => b[1].total - a[1].total);
console.log(`\n${ticks} ticks simulated. Tick budget at 10 Hz = 100 ms; target engine work < 5 ms p99.\n`);
console.log('path'.padEnd(30) + 'calls'.padStart(9) + 'total ms'.padStart(11) + 'mean µs'.padStart(10) + 'p99 µs'.padStart(10) + 'max ms'.padStart(9));
for (const [name, s] of rows) {
  console.log(
    name.padEnd(30) + String(s.n).padStart(9) + s.total.toFixed(1).padStart(11) +
    ((s.total / s.n) * 1000).toFixed(1).padStart(10) + (pct(s.samples, 99) * 1000).toFixed(1).padStart(10) + s.max.toFixed(2).padStart(9),
  );
}
