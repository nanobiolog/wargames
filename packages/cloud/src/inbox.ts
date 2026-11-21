// One tiny Durable Object per friend tag: a browser keeps a hibernating WebSocket open to its own
// inbox, and friends POST invites ("join match K7M2Q") to it. Costs nothing while idle.
import { DurableObject } from 'cloudflare:workers';

export interface Invite {
  from: string; // callsign
  fromTag: string;
  code: string; // match code
  at: number;
}

export class Inbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // keep-alive pings are answered by the runtime without waking this object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (this.ctx.getWebSockets().length >= 8) return new Response('too many screens', { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    // deliver invites that arrived while offline (last 10 minutes)
    const pending = ((await this.ctx.storage.get<Invite[]>('pending')) ?? []).filter((i) => Date.now() - i.at < 600_000);
    for (const i of pending) server.send(JSON.stringify({ t: 'invite', invite: i }));
    await this.ctx.storage.delete('pending');
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Deliver an invite to every open screen of this tag, or keep it briefly. Returns true if someone is online. */
  async invite(inv: Invite): Promise<boolean> {
    const socks = this.ctx.getWebSockets();
    const msg = JSON.stringify({ t: 'invite', invite: inv });
    for (const ws of socks) { try { ws.send(msg); } catch { /* closed */ } }
    if (!socks.length) {
      const pending = ((await this.ctx.storage.get<Invite[]>('pending')) ?? []).slice(-9);
      pending.push(inv);
      await this.ctx.storage.put('pending', pending);
    }
    return socks.length > 0;
  }

  /** Is anyone with this tag online right now? */
  async online(): Promise<boolean> {
    return this.ctx.getWebSockets().length > 0;
  }

  async webSocketMessage() {
    // clients only ever send keep-alive pings (auto-answered above)
  }

  async webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch { /* already closed */ }
  }
}
