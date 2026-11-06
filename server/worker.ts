// Glide! online server for Cloudflare: one Worker that serves the game's files and runs the rooms.
//
//   GET /room/<CODE>?role=host   open a room (WebSocket). The host is player p0.
//   GET /room/<CODE>             join a room (WebSocket). Joiners get p1, p2, ...
//   anything else                the built game from ./dist (Workers static assets, free and unmetered)
//
// Each room is one Durable Object, found by its code. It relays game messages between the players in
// the room exactly like the host's browser used to over PeerJS: a message with `to` goes to that one
// player, anything else goes to everyone else in the room. The server stamps `from` itself, so nobody
// can pretend to be another player. Because everything goes over a plain WebSocket to Cloudflare's
// edge, there is no NAT traversal, no STUN and no TURN: if a player can load a web page, they can play.
//
// Control messages the server sends (all start with "_"):
//   _ready {id}       you're in; this is your player id
//   _join {id}        (to the host) a player connected
//   _leave {id}       (to the host) a player left; (to everyone) id "p0" means the host left, room closed
//   _taken            (to a would-be host) that code is already in use, pick another
//   _noroom           (to a joiner) no open room with that code
//   _full             (to a joiner) the room is at the server's hard cap
// The host can send {t:"_kick", id} to drop a player.

import { DurableObject } from 'cloudflare:workers';

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}

const MAX_SOCKETS = 12; // the game itself turns players away past 8; this is a hard backstop
const MAX_MSG = 16 * 1024; // game messages are a few hundred bytes; drop anything silly

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/([A-Z0-9]{3,8})$/);
    if (m) {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket expected', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    if (url.pathname === '/health') return new Response('ok');
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

type Tag = { id: string };

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered by Cloudflare without waking the room, so an idle lobby costs nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private sockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN && this.tag(ws));
  }
  private tag(ws: WebSocket): Tag | null { return ws.deserializeAttachment() as Tag | null; }
  private byId(id: string) { return this.sockets().find((ws) => this.tag(ws)?.id === id); }

  async fetch(req: Request): Promise<Response> {
    const isHost = new URL(req.url).searchParams.get('role') === 'host';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const others = this.sockets().filter((ws) => ws !== server);
    const hostHere = others.some((ws) => this.tag(ws)?.id === 'p0');

    const refuse = (t: string) => { server.send(JSON.stringify({ t })); server.close(4000, t); };
    if (isHost && hostHere) refuse('_taken');
    else if (!isHost && !hostHere) refuse('_noroom');
    else if (others.length >= MAX_SOCKETS) refuse('_full');
    else {
      let id = 'p0';
      if (!isHost) {
        let next = ((await this.ctx.storage.get<number>('next')) ?? 1);
        id = `p${next++}`;
        await this.ctx.storage.put('next', next);
      } else await this.ctx.storage.put('next', 1); // a fresh room
      server.serializeAttachment({ id } satisfies Tag);
      server.send(JSON.stringify({ t: '_ready', id }));
      if (!isHost) this.byId('p0')?.send(JSON.stringify({ t: '_join', id }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const me = this.tag(ws);
    if (!me || typeof raw !== 'string' || raw.length > MAX_MSG) return;
    let m: { t?: unknown; to?: unknown; from?: unknown; id?: unknown };
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === '_kick') { if (me.id === 'p0' && typeof m.id === 'string') this.byId(m.id)?.close(4001, 'kicked'); return; }
    if (m.t.startsWith('_')) return;
    m.from = me.id;
    const out = JSON.stringify(m);
    if (typeof m.to === 'string') { this.byId(m.to)?.send(out); return; }
    for (const s of this.sockets()) if (s !== ws) s.send(out);
  }

  async webSocketClose(ws: WebSocket) { this.gone(ws); }
  async webSocketError(ws: WebSocket) { this.gone(ws); }

  private gone(ws: WebSocket) {
    const me = this.tag(ws);
    if (!me) return;
    ws.serializeAttachment(null);
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    const rest = this.sockets().filter((s) => s !== ws);
    if (me.id === 'p0') {
      // host left: the room is over
      void this.ctx.storage.deleteAll();
      for (const s of rest) { s.send(JSON.stringify({ t: '_leave', id: 'p0' })); s.close(4002, 'host left'); }
    } else {
      rest.find((s) => this.tag(s)?.id === 'p0')?.send(JSON.stringify({ t: '_leave', id: me.id }));
    }
  }
}
