// Repro for "USA/USSR flickers after accepting an invite": one screen that is already in a match
// (opened from a share link with ?role=…) accepts an invite → connect() is called again on the same client.
// Counts how often the viewer role of incoming snapshots changes. A healthy client never alternates.
import { GameClient, type Role } from '@coldlaunch/shared';

const origin = process.argv[2] ?? 'http://127.0.0.1:8787';
const create = () => fetch(`${origin}/api/match`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ opponent: 'human', side: 'USA' }) }).then((r) => r.json() as Promise<{ url: string; code: string }>);
const m = await create();
const host = new GameClient('gui');
host.identity = { name: 'host', player: 'player-host-1' };
await host.connect(m.url);
host.startMatch(); // matches open in a lobby; the host starts the clock
await new Promise((r) => setTimeout(r, 300));

const phone = new GameClient('gui');
phone.identity = { name: 'phone', player: 'player-phone-1' };
const seen: Role[] = [];
phone.on('snap', (s) => { if (seen[seen.length - 1] !== s.viewer) seen.push(s.viewer); });
await phone.connect(`${m.url}?role=SPECTATOR`); // e.g. opened the spectator / TV link first
await new Promise((r) => setTimeout(r, 1000));
await phone.connect(m.url); // accepts the invite on the same page
await new Promise((r) => setTimeout(r, 3000));
const flips = seen.length - 1;
console.log(`viewer sequence: ${seen.slice(0, 12).join(' → ')}${seen.length > 12 ? ' …' : ''}`);
console.log(flips > 1 ? `FLICKER: viewer changed ${flips} times in 3 s` : `OK: viewer changed ${flips} time(s), final ${phone.role}`);
host.close(); phone.close();
process.exit(flips > 1 ? 1 : 0);
