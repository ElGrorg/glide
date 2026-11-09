// Glide! online server for Cloudflare: one Worker that serves the game's files and runs the rooms.
//
//   GET /room/<CODE>?role=host   open a room (WebSocket). The host is player p0.
//   GET /room/<CODE>             join a room (WebSocket). Joiners get p1, p2, ...
//   GET /rooms                   the open public rooms, as JSON (the in-game room browser)
//   GET /race/<course>/top       a time trial course's leaderboard (top 20, plus your own row with ?me=<pid>)
//   GET /race/<course>/ghost/<pid>   one racer's best run, to fly against as a ghost
//   POST /race/<course>          {secret, name, ms, splits, ghost}: a finished run (kept if it's your best)
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
// The host can send {t:"_kick", id} to drop a player, and {t:"_meta", public, name, phase, arena}
// to list the room in the browser (public) or hide it (private, join by code only).
//
// Public rooms are listed by one Lobby Durable Object. Each room tells it about itself whenever its
// player count or settings change, and re-reports every couple of minutes while it's open, so a room
// whose host vanished drops off the list by itself.

import { DurableObject } from 'cloudflare:workers';

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  LOBBY: DurableObjectNamespace<Lobby>;
  BOARDS: DurableObjectNamespace<Leaderboard>;
  ASSETS: Fetcher;
}

const MAX_SOCKETS = 12; // the game itself turns players away past 8; this is a hard backstop
const MAX_MSG = 16 * 1024; // game messages are a few hundred bytes; drop anything silly
const MAX_PLAYERS = 8; // shown in the room browser (the game's own cap)
const REPORT_MS = 2 * 60_000; // an open public room re-reports this often
const EXPIRE_MS = 5 * 60_000; // the lobby forgets a room it hasn't heard from in this long

export type RoomInfo = { code: string; name: string; players: number; max: number; phase: string; arena: number; at: number };
type Meta = { code: string; public: boolean; name: string; phase: string; arena: number };
const cleanName = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, 16) || 'Bird';
const lobby = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName('lobby'));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/([A-Z0-9]{3,8})$/);
    if (m) {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket expected', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    if (url.pathname === '/rooms') {
      return Response.json(await lobby(env).list(), { headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
    }
    const rm = url.pathname.match(/^\/race\/([a-z0-9-]{1,32})(\/top|\/ghost\/[0-9a-f]{16})?$/);
    if (rm) {
      const board = env.BOARDS.get(env.BOARDS.idFromName(rm[1]));
      const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
      if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
      if (rm[2] === '/top' && req.method === 'GET') return Response.json(await board.top(url.searchParams.get('me') || ''), { headers: cors });
      if (rm[2]?.startsWith('/ghost/') && req.method === 'GET') {
        const g = await board.ghost(rm[2].slice(7));
        return g ? new Response(g, { headers: { ...cors, 'Content-Type': 'text/plain' } }) : new Response('no ghost', { status: 404, headers: cors });
      }
      if (!rm[2] && req.method === 'POST') {
        const body = await req.text();
        if (body.length > MAX_RUN) return Response.json({ error: 'too big' }, { status: 413, headers: cors });
        let run: unknown;
        try { run = JSON.parse(body); } catch { return Response.json({ error: 'bad json' }, { status: 400, headers: cors }); }
        const res = await board.submit(run as RunIn);
        return Response.json(res, { status: 'error' in res ? 400 : 200, headers: cors });
      }
      return new Response('not found', { status: 404, headers: cors });
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
    const url = new URL(req.url);
    const isHost = url.searchParams.get('role') === 'host';
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
      } else {
        // a fresh room
        await this.ctx.storage.put('next', 1);
        const code = url.pathname.split('/').pop() || '';
        await this.ctx.storage.put('meta', { code, public: url.searchParams.get('public') === '1', name: cleanName(url.searchParams.get('name')), phase: 'lobby', arena: -1 } satisfies Meta);
      }
      server.serializeAttachment({ id } satisfies Tag);
      server.send(JSON.stringify({ t: '_ready', id }));
      if (!isHost) this.byId('p0')?.send(JSON.stringify({ t: '_join', id }));
      this.ctx.waitUntil(this.report());
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
    if (m.t === '_meta') { if (me.id === 'p0') await this.setMeta(m as Record<string, unknown>); return; }
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
      this.ctx.waitUntil(this.unlist().then(() => this.ctx.storage.deleteAll()));
      for (const s of rest) { s.send(JSON.stringify({ t: '_leave', id: 'p0' })); s.close(4002, 'host left'); }
    } else {
      rest.find((s) => this.tag(s)?.id === 'p0')?.send(JSON.stringify({ t: '_leave', id: me.id }));
      this.ctx.waitUntil(this.report());
    }
  }

  // ---------- room browser ----------

  private async setMeta(m: Record<string, unknown>) {
    const meta = await this.ctx.storage.get<Meta>('meta');
    if (!meta) return;
    if (typeof m.public === 'boolean') meta.public = m.public;
    if (m.name !== undefined) meta.name = cleanName(m.name);
    if (m.phase === 'lobby' || m.phase === 'playing') meta.phase = m.phase;
    if (typeof m.arena === 'number') meta.arena = Math.round(m.arena);
    await this.ctx.storage.put('meta', meta);
    await this.report();
  }

  /** Tell the lobby how this room stands (or take it off the list), and keep re-reporting while public. */
  private async report() {
    const meta = await this.ctx.storage.get<Meta>('meta');
    const hostHere = this.sockets().some((ws) => this.tag(ws)?.id === 'p0');
    if (!meta || !hostHere || !meta.public) { await this.unlist(); return; }
    await lobby(this.env).put({ code: meta.code, name: meta.name, players: this.sockets().length, max: MAX_PLAYERS, phase: meta.phase, arena: meta.arena, at: Date.now() });
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + REPORT_MS);
  }

  private async unlist() {
    const meta = await this.ctx.storage.get<Meta>('meta');
    if (meta) await lobby(this.env).remove(meta.code);
    await this.ctx.storage.deleteAlarm();
  }

  async alarm() { await this.report(); }
}

/** The list of open public rooms (one instance for the whole game). */
export class Lobby extends DurableObject<Env> {
  async put(info: RoomInfo) { await this.ctx.storage.put(`r:${info.code}`, info); }
  async remove(code: string) { await this.ctx.storage.delete(`r:${code}`); }
  async list(): Promise<RoomInfo[]> {
    const now = Date.now();
    const rooms = [...(await this.ctx.storage.list<RoomInfo>({ prefix: 'r:' })).values()];
    const stale = rooms.filter((r) => now - r.at > EXPIRE_MS).map((r) => `r:${r.code}`);
    if (stale.length) await this.ctx.storage.delete(stale);
    return rooms.filter((r) => now - r.at <= EXPIRE_MS)
      .sort((a, b) => (a.phase === b.phase ? b.players - a.players : a.phase === 'lobby' ? -1 : 1))
      .slice(0, 50);
  }
}

// ---------- Time trial leaderboards: one Durable Object per course (and course version) ----------
// Each racer keeps one row: their best run, with its splits and its ghost (the recorded flight, base64).
// A racer is known by a secret their browser made; the board only stores and shows a hash of it, so nobody
// can post as someone else. Times are checked for sanity (the splits add up, the ghost is about as long as the
// time), not replayed: it's a friendly board, not a tournament.
const MAX_RUN = 160 * 1024;      // a 2 minute ghost is ~32 KB of base64
const TOP_N = 20;
const KEEP_GHOSTS = 100;         // ghosts are kept for the top 100; slower rows keep just their time
type RunIn = { secret?: unknown; name?: unknown; ms?: unknown; splits?: unknown; ghost?: unknown };
type Row = { pid: string; name: string; ms: number; splits: string; at: number };
const GHOST_BYTES = 20, GHOST_HZ = 10;

async function pidOf(secret: string) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Leaderboard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS runs (pid TEXT PRIMARY KEY, name TEXT NOT NULL, ms INTEGER NOT NULL,
      splits TEXT NOT NULL, at INTEGER NOT NULL, ghost TEXT)`);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS runs_ms ON runs (ms)');
  }
  private rank(ms: number) { return (this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE ms < ?', ms).one().n) + 1; }
  private total() { return this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM runs').one().n; }
  private out(r: Row, rank: number) { return { pid: r.pid, name: r.name, ms: r.ms, splits: JSON.parse(r.splits), at: r.at, rank }; }

  async top(me: string) {
    const rows = this.ctx.storage.sql.exec<Row>('SELECT pid, name, ms, splits, at FROM runs ORDER BY ms, at LIMIT ?', TOP_N).toArray();
    const entries = rows.map((r, i) => this.out(r, i + 1));
    let mine = null;
    if (/^[0-9a-f]{16}$/.test(me)) {
      const r = this.ctx.storage.sql.exec<Row>('SELECT pid, name, ms, splits, at FROM runs WHERE pid = ?', me).toArray()[0];
      if (r) mine = this.out(r, this.rank(r.ms));
    }
    return { entries, total: this.total(), me: mine };
  }

  async ghost(pid: string) {
    return this.ctx.storage.sql.exec<{ ghost: string | null }>('SELECT ghost FROM runs WHERE pid = ?', pid).toArray()[0]?.ghost ?? null;
  }

  async submit(run: RunIn): Promise<{ best: boolean; rank: number; total: number } | { error: string }> {
    const { secret, ms, splits, ghost } = run;
    if (typeof secret !== 'string' || !/^[0-9a-f]{32}$/.test(secret)) return { error: 'bad racer id' };
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 15_000 || ms > 30 * 60_000) return { error: 'bad time' };
    if (!Array.isArray(splits) || splits.length < 1 || splits.length > 16 || splits[splits.length - 1] !== ms
      || splits.some((s, i) => !Number.isInteger(s) || s <= 0 || (i > 0 && s <= splits[i - 1]))) return { error: 'bad splits' };
    if (typeof ghost !== 'string' || ghost.length > MAX_RUN || !/^[A-Za-z0-9+/]*={0,2}$/.test(ghost)) return { error: 'bad ghost' };
    const samples = Math.floor((ghost.length * 3) / 4 / GHOST_BYTES);
    if (Math.abs(samples - (ms / 1000) * GHOST_HZ) > 6) return { error: 'ghost and time disagree' };
    const pid = await pidOf(secret);
    const name = cleanName(run.name);
    const old = this.ctx.storage.sql.exec<{ ms: number }>('SELECT ms FROM runs WHERE pid = ?', pid).toArray()[0];
    const best = !old || ms < old.ms;
    if (best) {
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO runs (pid, name, ms, splits, at, ghost) VALUES (?, ?, ?, ?, ?, ?)',
        pid, name, ms, JSON.stringify(splits), Date.now(), ghost);
      // only the top runs keep their ghosts (storage stays small however many people race)
      this.ctx.storage.sql.exec('UPDATE runs SET ghost = NULL WHERE ghost IS NOT NULL AND pid NOT IN (SELECT pid FROM runs ORDER BY ms LIMIT ?)', KEEP_GHOSTS);
    } else if (old) {
      this.ctx.storage.sql.exec('UPDATE runs SET name = ? WHERE pid = ?', name, pid); // a new name still sticks
    }
    const mine = best ? ms : old!.ms;
    return { best, rank: this.rank(mine), total: this.total() };
  }
}
