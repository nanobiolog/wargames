// End-to-end check of the match room: lobby, crews sharing a nation by branch, branch permissions,
// resigning to spectator, host controls. npx tsx packages/cloud/scripts/room-smoke.ts [origin]
import { GameClient, type LobbyState } from '@coldlaunch/shared';

const origin = process.argv[2] ?? 'http://127.0.0.1:8787';
const ok = (cond: unknown, msg: string) => { if (!cond) { console.error('FAIL', msg); process.exit(1); } console.log('ok  ', msg); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const m = await fetch(`${origin}/api/match`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scenario: 'modern', side: 'USA', opponent: 'human', name: 'raven-42', player: 'p-room-host', speed: 30 }),
}).then((r) => r.json() as Promise<{ code: string; url: string }>);
const join = async (name: string, player: string, role?: string) => {
  const c = new GameClient('gui');
  c.identity = { name, player };
  await c.connect(`${m.url}${role ? `?role=${role}` : ''}`);
  await wait(400);
  return c;
};
const host = await join('raven-42', 'p-room-host');
const lobby = () => host.lobby as LobbyState;
ok(lobby()?.phase === 'lobby' && lobby().youAreHost, `match ${m.code} opens in its lobby, you are host`);
const t0 = host.snap!.t;
await wait(1200);
ok(host.snap!.t === t0, 'clock does not run before START');
const friend = await join('viper-07', 'p-room-friend');
ok(friend.role === 'CHN' && !friend.lobby?.youAreHost, `friend lands on ${friend.role}, not host`);
const navy = await join('kestrel-11', 'p-room-navy');
navy.takeSeat('USA', 'navy');
await wait(500);
ok(navy.role === 'USA' && navy.lobby?.you.branch === 'navy', 'a third player shares the USA as NAVY');
const usaCrew = lobby().nations.find((n) => n.id === 'USA')!.crew.map((c) => `${c.name}:${c.branch}`).join(' ');
ok(/RAVEN-42:commander/.test(usaCrew) && /KESTREL-11:navy/.test(usaCrew), `USA crew: ${usaCrew}`);
const thief = await join('ghost-99', 'p-room-thief');
const before = thief.role;
thief.takeSeat('USA', 'navy');
await wait(500);
ok(thief.role === before, `USA navy is taken, ghost stays ${thief.role}`);
friend.startMatch();
await wait(500);
ok(lobby().phase === 'lobby', 'only the host can start');
host.configure({ speed: 20, endMode: 'open' });
await wait(400);
ok(lobby().options.speed === 20, 'host changes settings in the lobby');
host.startMatch();
await wait(1500);
ok(lobby().phase === 'running' && host.snap!.t > 0, `host starts: running, T+${host.snap!.t.toFixed(0)}s`);
const d1 = await navy.cmd({ op: 'defcon', level: 4 });
ok(!d1.ok && /COMMANDER/.test(d1.msg), `navy may not set DEFCON: ${d1.msg}`);
const s1 = await host.cmd({ op: 'sortie', from: 'm-csg-reagan', mission: 'recon', to: 'east china sea' });
ok(!s1.ok && /NAVY IS COMMANDED BY KESTREL-11/.test(s1.msg), `commander can't fly the navy's jets: ${s1.msg}`);
const s2 = await navy.cmd({ op: 'sortie', from: 'm-csg-reagan', mission: 'recon', to: 'east china sea' });
ok(s2.ok, `navy flies its carrier recon: ${s2.msg}`);
const s3 = await host.cmd({ op: 'sortie', from: 'm-int-kadena', mission: 'drone', to: 'east china sea' });
ok(s3.ok, `commander covers the unfilled air force: ${s3.msg}`);
const r = await friend.cmd({ op: 'resign' });
ok(r.ok, `China resigns: ${r.msg}`);
await wait(800);
ok(friend.role === 'SPECTATOR', 'China\'s player now watches as a spectator');
ok(host.snap!.out?.includes('CHN') && lobby().nations.find((n) => n.id === 'CHN')!.out, 'everyone sees China is out; the war goes on');
host.endMatch();
await wait(600);
ok(host.snap!.over && lobby().phase === 'over', `host ends the match: ${host.snap!.over?.reason}`);
for (const c of [host, friend, navy, thief]) c.close();
console.log('\nMATCH ROOM CHECKS PASSED');
process.exit(0);
