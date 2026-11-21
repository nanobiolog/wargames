// Determinism baseline: plays rules-vs-rules games with scripted ship moves and prints the state hash
// at checkpoints. A refactor that must not change gameplay has to reproduce these hashes exactly.
// npx tsx packages/cli/src/baseline.ts > before.txt  (then diff against after)
import { Game } from '@coldlaunch/engine';
import { AiOpponent, makeProvider, type AiHost } from '@coldlaunch/ai';
import { SEA_AREAS } from '@coldlaunch/data';

for (const seed of [1, 2, 3, 4, 5, 6]) {
  const game = new Game(seed);
  game.s.speed = 30;
  const listeners = new Set<(g: Game) => void>();
  const host: AiHost = { game, submit: (side, cmd) => game.apply(side, cmd), onTick: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  new AiOpponent(host, 'USA', makeProvider('rules'), { personality: seed % 2 ? 0.4 : 0.9, cadenceSec: 60 }).attach();
  new AiOpponent(host, 'USSR', makeProvider('rules'), { personality: 0.95, cadenceSec: 60 }).attach();
  // rules AI calls Date.now() for cadence; pin it so runs are comparable
  let fake = 1_700_000_000_000;
  const realNow = Date.now;
  Date.now = () => fake;
  const marks: string[] = [];
  for (let i = 1; i <= 9000; i++) {
    fake += 100;
    if (i % 300 === 0) {
      const ships = game.s.units.filter((u) => ['carrier', 'ssbn', 'ssn'].includes(u.kind) && u.status !== 'destroyed');
      const u = ships[(i / 300) % Math.max(1, ships.length)];
      if (u) game.apply(u.side, { op: 'move', unit: u.id, to: SEA_AREAS[(i / 300 * 5) % SEA_AREAS.length].name });
    }
    game.step();
    for (const fn of listeners) fn(game);
    if (i % 1500 === 0) marks.push(`${i}:${game.hash()}:${game.s.events.length}:${JSON.stringify(game.snapshot('USA')).length}`);
  }
  Date.now = realNow;
  console.log(`seed ${seed} ${marks.join(' ')} over=${game.s.over?.reason ?? '-'}`);
}
process.exit(0);
