// Long-running check for CPU limits: one player, heartbeat every 20 s (like the web display),
// for N seconds. Fails if the match resets, disconnects or its clock stalls.
// npx tsx packages/cloud/scripts/soak.ts https://<host> [seconds]
import { GameClient } from '@coldlaunch/shared';

const origin = process.argv[2] ?? 'http://127.0.0.1:8787';
const secs = +(process.argv[3] ?? 90);
const m = await fetch(`${origin}/api/match`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opponent: 'rules', speed: 10 }) }).then((r) => r.json() as Promise<{ url: string; code: string }>);
const c = new GameClient('gui');
c.identity = { name: 'soak', player: 'player-soak-1' };
let welcomes = 0, drops = 0, lastT = -1, backwards = 0;
c.on('welcome', () => welcomes++);
c.on('status', (s) => { if (s === 'disconnected') drops++; });
c.on('snap', (s) => { if (s.t < lastT) backwards++; lastT = s.t; });
await c.connect(m.url);
while (!c.snap) await new Promise((r) => setTimeout(r, 50));
const hb = setInterval(() => c.ping(), 20_000);
const t0 = Date.now(), g0 = c.snap!.t;
for (let i = 1; i <= secs / 10; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  const rate = (lastT - g0) / ((Date.now() - t0) / 1000);
  console.log(`${i * 10}s  game T+${lastT.toFixed(0)}s  rate x${rate.toFixed(1)}  welcomes ${welcomes} drops ${drops} backwards ${backwards}`);
}
clearInterval(hb);
const rate = (lastT - g0) / ((Date.now() - t0) / 1000);
const ok = welcomes === 1 && drops === 0 && backwards === 0 && rate > 8;
console.log(ok ? `SOAK OK — match ${m.code} ran ${secs}s at x${rate.toFixed(1)} with no resets` : 'SOAK FAILED');
c.close();
process.exit(ok ? 0 : 1);
