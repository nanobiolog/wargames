// Edge entry point: match lobby API, WebSocket routing to the match's Durable Object, friend
// invites, and the web wall display (static assets, served before this code runs).
import { normalizeCode, shortCode, cleanCallsign } from '@coldlaunch/shared';
import { SCENARIOS, scenarioList } from '@coldlaunch/data';
import './geo.ts';
import type { CreateOptions } from './match.ts';
import type { Invite } from './inbox.ts';

export { MatchRoom } from './match.ts';
export { Inbox } from './inbox.ts';

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const TAG = /^[2-9A-HJ-NP-Z]{5}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // ---- matches
    if (path === '/api/match' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const scenario = typeof body.scenario === 'string' && SCENARIOS[body.scenario] ? body.scenario : '1983';
      const sc = SCENARIOS[scenario];
      const side = sc.factions.find((f) => f.playable && f.id === body.side)?.id ?? sc.defaultSides[0];
      const opts: CreateOptions = {
        scenario,
        opponent: (['human', 'rules', 'byok'] as const).find((o) => o === body.opponent) ?? 'human',
        hostSide: side,
        speed: typeof body.speed === 'number' ? body.speed : undefined,
        personality: typeof body.personality === 'number' ? body.personality : undefined,
        host: cleanCallsign(typeof body.name === 'string' ? body.name : undefined) ?? undefined,
        hostPlayer: typeof body.player === 'string' && /^[\w-]{6,40}$/.test(body.player) ? body.player : undefined,
        endMode: body.endMode === 'classic' ? 'classic' : 'open',
      };
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = shortCode();
        const info = await env.MATCH.getByName(code).init(code, opts, url.origin);
        if (info) return json({ ...info, url: `${url.origin}/m/${code}` }, 201);
      }
      return json({ error: 'could not allocate a match code, try again' }, 503);
    }

    let m = path.match(/^\/api\/match\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const code = normalizeCode(m[1]);
      if (!code) return json({ error: 'invalid code' }, 400);
      const st = await env.MATCH.getByName(code).status();
      return st ? json(st) : json({ error: 'no such match' }, 404);
    }

    m = path.match(/^\/m\/([^/]+)\/ws$/);
    if (m) {
      const code = normalizeCode(m[1]);
      if (!code) return new Response('invalid code', { status: 400 });
      return env.MATCH.getByName(code).fetch(req);
    }

    // share links: https://host/m/K7M2Q?role=USA → the web display, joined to that match
    m = path.match(/^\/m\/([^/]+)\/?$/);
    if (m) {
      const code = normalizeCode(m[1]);
      if (!code) return new Response('invalid match code', { status: 400 });
      const q = new URLSearchParams(url.search);
      q.set('m', code);
      return Response.redirect(`${url.origin}/?${q}`, 302);
    }

    // ---- friends: each browser listens on its own tag's inbox
    m = path.match(/^\/api\/inbox\/([^/]+)\/ws$/);
    if (m) {
      if (!TAG.test(m[1])) return new Response('invalid tag', { status: 400 });
      return env.INBOX.getByName(m[1]).fetch(req);
    }

    m = path.match(/^\/api\/invite\/([^/]+)$/);
    if (m && req.method === 'POST') {
      const tag = m[1].toUpperCase();
      if (!TAG.test(tag)) return json({ error: 'invalid friend tag' }, 400);
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const code = normalizeCode(String(b.code ?? ''));
      const fromTag = String(b.fromTag ?? '').toUpperCase();
      if (!code || !TAG.test(fromTag)) return json({ error: 'need code and fromTag' }, 400);
      const inv: Invite = { from: cleanCallsign(String(b.from ?? '')) ?? fromTag, fromTag, code, at: Date.now() };
      const online = await env.INBOX.getByName(tag).invite(inv);
      return json({ ok: true, online });
    }

    if (path === '/api/friends' && req.method === 'GET') {
      const tags = (url.searchParams.get('tags') ?? '').toUpperCase().split(',').filter((t) => TAG.test(t)).slice(0, 50);
      const status = await Promise.all(tags.map(async (t) => [t, await env.INBOX.getByName(t).online()] as const));
      return json(Object.fromEntries(status));
    }

    if (path === '/api/scenarios') return new Response(JSON.stringify(scenarioList()), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } });
    if (path === '/api/health') return json({ ok: true });
    if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
