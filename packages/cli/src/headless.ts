// Headless match: npm run sim -- --usa rules --ussr rules --seed 1 [--hawk 0.9]
import { Game } from '@coldlaunch/engine';
import { AiOpponent, makeProvider, type AiHost } from '@coldlaunch/ai';
import type { Command, Side } from '@coldlaunch/shared';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const seed = parseInt(arg('--seed', '1'), 10);
const game = new Game(seed);
game.s.speed = 30;
const listeners = new Set<(g: Game) => void>();
const host: AiHost = {
  game,
  submit: (side: Side, cmd: Command, source = 'ai') => game.apply(side, cmd),
  onTick: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
};
const hawk = parseFloat(arg('--hawk', '0.95'));
new AiOpponent(host, 'USA', makeProvider(arg('--usa', 'rules')), { personality: 0.4, cadenceSec: 60 }).attach();
new AiOpponent(host, 'USSR', makeProvider(arg('--ussr', 'rules')), { personality: hawk, cadenceSec: 60 }).attach();

const maxTicks = 12 * 3600 / (0.1 * game.s.speed);
let i = 0;
let lastEv = 0;
const tick = async () => {
  for (let k = 0; k < 200 && i < maxTicks && !game.s.over; k++, i++) {
    game.step();
    for (const fn of listeners) fn(game);
  }
  for (const e of game.s.events.slice(lastEv)) {
    if (['defcon', 'launch', 'impact', 'end', 'hotline', 'alert'].includes(e.kind)) {
      console.log(`${new Date(Date.UTC(1983, 10, 8, 21) + e.t * 1000).toISOString().slice(11, 19)} ${e.kind.padEnd(8)} ${e.text}`);
    }
  }
  lastEv = game.s.events.length;
  if (game.s.over || i >= maxTicks) {
    const sc = game.s.score;
    console.log('\n=== RESULT ===');
    console.log(game.s.over ? `${game.s.over.reason} (winner: ${game.s.over.winner})` : 'time limit');
    console.log(`T+${(game.s.t / 3600).toFixed(2)} h, detonations ${game.s.detonations.length}`);
    console.log(`USA  killed ${(sc.USA.killed / 1000).toFixed(1)}M of ${(sc.USA.popStart / 1000).toFixed(0)}M, warheads launched ${sc.USA.warheadsLaunched}`);
    console.log(`USSR killed ${(sc.USSR.killed / 1000).toFixed(1)}M of ${(sc.USSR.popStart / 1000).toFixed(0)}M, warheads launched ${sc.USSR.warheadsLaunched}`);
    console.log(`state hash ${game.hash()}`);
    process.exit(0);
  }
  setImmediate(tick);
};
tick();
