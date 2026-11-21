// End-to-end check against a running Worker: npm run smoke -w @coldlaunch/cloud [-- http://127.0.0.1:8787]
// Creates a match, joins two players and a spectator, checks seats, fog of war and command latency.
import { GameClient, type Snapshot } from '@coldlaunch/shared';

const origin = process.argv[2] ?? 'http://127.0.0.1:8787';
const ok = (cond: unknown, msg: string) => { if (!cond) { console.error('FAIL', msg); process.exit(1); } console.log('ok  ', msg); };

const created = await fetch(`${origin}/api/match`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ opponent: 'human', side: 'USA', speed: 20, name: 'raven-42' }),
}).then((r) => r.json() as Promise<{ code: string; url: string; host: string }>);
ok(/^[2-9A-Z]{5}$/.test(created.code), `match created: ${created.code} (${created.url}) host ${created.host}`);

const join = async (name: string, player: string, role?: 'USA' | 'USSR' | 'SPECTATOR') => {
  const c = new GameClient('gui');
  c.identity = { name, player, tag: undefined };
  await c.connect(`${created.url}${role ? `?role=${role}` : ''}`);
  await new Promise((r) => setTimeout(r, 300));
  return c;
};
const usa = await join('raven-42', 'player-usa-1');
const usa2 = await join('raven-42', 'player-usa-1', 'USA'); // same player, second screen
const ussr = await join('viper-07', 'player-ussr-1');
const thief = await join('ghost-99', 'player-x', 'USA'); // seat taken → bounced
const spec = await join('tv', 'player-tv', 'SPECTATOR');
ok(usa.role === 'USA' && usa2.role === 'USA', 'host gets USA on two screens');
ok(ussr.role === 'USSR', 'friend gets USSR by default');
ok(thief.role === 'SPECTATOR', `third player asking for USA is seated as ${thief.role}`);
ok(spec.role === 'SPECTATOR', 'spectator joins');
ok(usa.roster.length >= 5, `roster has ${usa.roster.length} entries`);

const before = usa.snap!.t;
await new Promise((r) => setTimeout(r, 1500));
ok(usa.snap!.t > before, `clock runs in the Durable Object (T+${usa.snap!.t.toFixed(0)}s)`);
const fogOk = (s: Snapshot) => s.units.every((u) => u.side === 'USA') && !JSON.stringify(s).includes('ssbn-k219');
ok(fogOk(usa.snap!), 'USA snapshot is fog-filtered');
ok(spec.snap!.units.some((u) => u.side === 'USSR') && spec.snap!.units.some((u) => u.side === 'USA'), 'spectator sees both sides');

const lat: number[] = [];
for (let i = 0; i < 20; i++) {
  const t0 = performance.now();
  const r = await usa.cmd({ op: 'defcon', level: 5 });
  lat.push(performance.now() - t0);
  if (!r.ok) ok(false, `command failed: ${r.msg}`);
}
lat.sort((a, b) => a - b);
ok(lat[18] < 100, `command round-trip p50 ${lat[10].toFixed(1)} ms, p95 ${lat[18].toFixed(1)} ms (budget 100 ms)`);
const t0 = performance.now();
const mv = await usa.cmd({ op: 'move', unit: 'cvbg-midway', to: 'barents sea' });
ok(mv.ok && performance.now() - t0 < 100, `long ship order replies in ${(performance.now() - t0).toFixed(1)} ms: ${mv.msg}`);
const denied = await spec.cmd({ op: 'defcon', level: 4 });
ok(!denied.ok, `spectator orders refused: ${denied.msg}`);
await new Promise((r) => setTimeout(r, 3000));
const mid = usa.snap!.units.find((u) => u.id === 'cvbg-midway');
ok(mid?.route?.length, `route computed in the background across ticks (${mid?.route?.length} waypoints)`);
const st = await fetch(`${origin}/api/match/${created.code.toLowerCase()}`).then((r) => r.json() as Promise<{ players: number; spectators: number }>);
ok(st.players === 3 && st.spectators === 2, `lobby status: ${st.players} player screens, ${st.spectators} spectators`);
// advisor relay: a "phone" without a key asks; the USA "PC" holding a key (simulated) runs the AI call
const pc = new GameClient('gui');
pc.identity = { name: 'raven-42', player: 'player-usa-1', caps: ['ai'] };
let jobSeen = '';
pc.on('aiJob', (job) => {
  jobSeen = `${job.purpose}/${job.side}`;
  pc.aiResult({ t: 'aiResult', id: job.id, calls: [{ name: 'set_defcon', args: { level: 4 } }], text: 'RAISE READINESS ONE STEP', inTok: 3000, outTok: 40 });
});
await pc.connect(`${created.url}?role=USA`);
const phone = new GameClient('gui');
phone.identity = { name: 'raven-42', player: 'player-usa-1' };
await phone.connect(`${created.url}?role=USA`);
const plan = await phone.ask('get the bombers ready');
ok('cmds' in plan && plan.cmds.length === 1 && jobSeen === 'advisor/USA', `advisor ran on the PC that holds the key (${jobSeen}): ${'summary' in plan ? plan.summary : JSON.stringify(plan)}`);
const nokey = await ussr.ask('what should I do');
ok(!('cmds' in nokey) && /NO AI KEY/.test(nokey.msg), 'side without any AI-capable screen gets a clear "add your key" message');
pc.close(); phone.close();

const inv = await fetch(`${origin}/api/invite/K7M2Q`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: created.code, from: 'raven-42', fromTag: 'ABCDE' }) }).then((r) => r.json() as Promise<{ ok: boolean }>);
ok(inv.ok, 'friend invite accepted');
for (const c of [usa, usa2, ussr, thief, spec]) c.close();
console.log('\nALL CHECKS PASSED');
process.exit(0);
