// End-to-end check of a five-faction online match: npx tsx packages/cloud/scripts/modern-smoke.ts [origin]
import { GameClient } from '@coldlaunch/shared';

const origin = process.argv[2] ?? 'http://127.0.0.1:8787';
const ok = (cond: unknown, msg: string) => { if (!cond) { console.error('FAIL', msg); process.exit(1); } console.log('ok  ', msg); };
const list = await fetch(`${origin}/api/scenarios`).then((r) => r.json() as Promise<{ id: string; factions: { id: string }[] }[]>);
ok(list.some((s) => s.id === 'modern' && s.factions.length === 5), `scenario list: ${list.map((s) => `${s.id}(${s.factions.length})`).join(', ')}`);
const m = await fetch(`${origin}/api/match`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: 'modern', side: 'USA', opponent: 'human', name: 'raven-42', speed: 20 }) })
  .then((r) => r.json() as Promise<{ code: string; url: string; scenario: string }>);
ok(m.code, `modern match ${m.code} (${m.scenario})`);
const join = async (name: string, player: string, role?: string) => {
  const c = new GameClient('gui');
  c.identity = { name, player };
  await c.connect(`${m.url}${role ? `?role=${role}` : ''}`);
  await new Promise((r) => setTimeout(r, 400));
  return c;
};
const host = await join('raven-42', 'p-host');
host.startMatch(); // matches open in a lobby; the host starts the clock
await new Promise((r) => setTimeout(r, 300));
ok(host.role === 'USA' && host.world?.factions?.length === 5, `host commands ${host.role}; world has ${host.world?.factions?.map((f) => f.id).join(' ')}`);
const friend = await join('viper-07', 'p-friend');
ok(friend.role === 'CHN', `friend gets the scenario's main adversary: ${friend.role}`);
const third = await join('ghost-99', 'p-third', 'IND');
ok(third.role === 'IND', `a third player picks India: ${third.role}`);
const ai = host.roster.filter((p) => p.kind === 'ai').map((p) => p.role).sort();
ok(JSON.stringify(ai) === JSON.stringify(['EUR', 'RUS']), `AI covers the empty seats: ${ai.join(', ')}`);
await new Promise((r) => setTimeout(r, 1500));
const s = host.snap!;
ok(s.units.some((u) => u.side === 'EUR') && !s.units.some((u) => u.side === 'RUS'), 'USA sees its own and allied (EUR) forces, not Russia\'s');
ok(Object.keys(s.defcon).length === 5, `DEFCON known for ${Object.keys(s.defcon).join(' ')}`);
const r = await host.cmd({ op: 'sortie', from: 'm-csg-reagan', mission: 'recon', to: 'east china sea' });
ok(r.ok, `carrier recon order: ${r.msg}`);
const h = await host.cmd({ op: 'hotline', to: 'CHN', text: 'we seek calm in the straits' });
ok(h.ok, 'hotline to one nation');
for (const c of [host, friend, third]) c.close();
console.log('\nMODERN MATCH CHECKS PASSED');
process.exit(0);
