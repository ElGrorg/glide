import Peer, { type DataConnection, type PeerOptions } from 'peerjs';

// Online play over WebRTC, peer to peer. One player hosts a room and the others connect straight to them
// (a star: everything goes through the host, who relays it on). PeerJS's free public server only
// introduces the browsers to each other. After that the game data flows directly between players.
// PeerJS also brings STUN and free TURN relays, so players behind awkward home or mobile NATs can
// still reach the host.
//
// Or, when the game is built for Cloudflare (npm run build:cloudflare, see CLOUDFLARE.md), it skips WebRTC
// and goes through a small relay server instead: every player holds one WebSocket to a Durable Object for
// the room, which forwards messages exactly the way the host's browser does here. That works on any
// network that can load a web page, with no NAT traversal or TURN to fail.
//   build time: VITE_RELAY=same-origin (the game and the relay on one Cloudflare Worker) or wss://...
//   page URL:   ?relay=wss://glide.you.workers.dev to try a relay, ?relay=peerjs to force PeerJS
//
// For testing, or your own servers, the page URL can override these:
//   ?signal=host:port[/path]   your own PeerJS server (npx peer --port 9000)
//   ?turn=turn:host:3478&tu=user&tp=pass   your own TURN relay (added to the defaults)

export type NetMsg = { t: string; from?: string; to?: string; [k: string]: unknown };

const ROOM_PREFIX = 'glide-arena-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups
export const makeCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
export const cleanCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function peerOptions(): PeerOptions {
  const q = new URLSearchParams(location.search);
  const o: PeerOptions = { debug: 1 };
  const sig = q.get('signal');
  if (sig) {
    const m = sig.match(/^([^:/]+)(?::(\d+))?(\/.*)?$/);
    if (m) { o.host = m[1]; o.port = Number(m[2] || 443); o.path = m[3] || '/'; o.secure = o.port === 443; }
  }
  const turn = q.get('turn');
  if (turn) {
    o.config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: turn, username: q.get('tu') || '', credential: q.get('tp') || '' },
        { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
      ],
    };
  }
  return o;
}

/** The relay server's base URL (ws:// or wss://), or '' to use PeerJS. */
function relayBase(): string {
  const q = new URLSearchParams(location.search).get('relay');
  const v = (q ?? (import.meta.env.VITE_RELAY as string | undefined) ?? '').trim();
  if (!v || v === 'peerjs') return '';
  if (v === 'same-origin') {
    if (!/^https?:$/.test(location.protocol)) return ''; // opened from a file: no server to talk to
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  }
  return v.replace(/^http/, 'ws').replace(/\/+$/, '');
}

export class Net {
  peer: Peer | null = null;
  isHost = false;
  code = '';
  /** This player's id in the room: the host is p0, everyone else p1, p2, ... */
  myId = '';
  /** Host: open connections by player id. Client: just the host. */
  private conns = new Map<string, DataConnection>();
  private nextId = 1;
  onMessage: (m: NetMsg) => void = () => {};
  /** Host: a player's connection dropped. Client: the host went away (id = 'p0'). Relay: our own link dropped (id = 'self'). */
  onLeave: (id: string) => void = () => {};
  /** Host: a new player connected (before their hello). */
  onJoin: (id: string) => void = () => {};
  /** Relay mode: the one WebSocket to the room server. */
  private ws: WebSocket | null = null;
  private pingTimer = 0;
  readonly relay = relayBase();
  get open() { return this.relay ? this.ws?.readyState === WebSocket.OPEN : !!this.peer && (this.isHost || this.conns.size > 0); }
  get peerCount() { return this.conns.size; }

  /** Open a room. Resolves with the room code once the signalling server has registered it. */
  host(): Promise<string> {
    this.close();
    this.isHost = true; this.myId = 'p0';
    if (this.relay) return this.relayHost();
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const code = makeCode();
        const peer = new Peer(ROOM_PREFIX + code, peerOptions());
        this.peer = peer;
        peer.on('open', () => { this.code = code; resolve(code); });
        peer.on('error', (err: any) => {
          if (err?.type === 'unavailable-id' && tries++ < 4) { peer.destroy(); attempt(); return; }
          if (!this.code) reject(new Error(describe(err)));
          else console.warn('peer error', err);
        });
        peer.on('disconnected', () => { if (this.peer === peer && !peer.destroyed) peer.reconnect(); }); // keep the room findable
        peer.on('connection', (conn) => {
          const id = `p${this.nextId++}`;
          conn.on('open', () => { this.conns.set(id, conn); this.onJoin(id); });
          conn.on('data', (d) => this.hostReceive(id, d as NetMsg));
          const gone = () => { if (this.conns.get(id) === conn) { this.conns.delete(id); this.onLeave(id); } };
          conn.on('close', gone); conn.on('error', gone);
          (conn as any).peerConnection?.addEventListener?.('connectionstatechange', () => {
            const st = (conn as any).peerConnection?.connectionState;
            if (st === 'failed' || st === 'closed') gone();
          });
        });
      };
      attempt();
    });
  }

  /** Join a room by its code. Resolves once connected to the host. */
  join(code: string): Promise<void> {
    this.close();
    this.isHost = false; this.code = cleanCode(code);
    if (this.relay) return this.relayJoin();
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerOptions());
      this.peer = peer;
      let done = false;
      const fail = (msg: string) => { if (!done) { done = true; reject(new Error(msg)); } else this.onLeave('p0'); };
      const timer = setTimeout(() => fail('Couldn\'t reach that room. Check the code, or the host\'s network may be blocking it.'), 15000);
      peer.on('error', (err: any) => {
        clearTimeout(timer);
        fail(err?.type === 'peer-unavailable' ? `No room called ${this.code}. Check the code.` : describe(err));
      });
      peer.on('open', () => {
        const conn = peer.connect(ROOM_PREFIX + this.code, { reliable: true, serialization: 'json' });
        conn.on('open', () => { clearTimeout(timer); done = true; this.conns.set('p0', conn); resolve(); });
        conn.on('data', (d) => this.onMessage(d as NetMsg));
        const gone = () => { if (done && this.conns.get('p0') === conn) { this.conns.delete('p0'); this.onLeave('p0'); } };
        conn.on('close', gone); conn.on('error', gone);
      });
    });
  }

  /** Host: messages from a client are handled here and passed on to everyone else (or one player, with `to`). */
  private hostReceive(id: string, m: NetMsg) {
    m.from = id;
    if (m.to && m.to !== 'p0') { this.conns.get(m.to)?.send(m); return; }
    if (!m.to) for (const [cid, c] of this.conns) if (cid !== id) c.send(m);
    this.onMessage(m);
  }

  // ---------- relay mode (Cloudflare Durable Object) ----------

  /** Connect a WebSocket to a room. Resolves with the first control message the server sends. */
  private relayOpen(code: string, host: boolean): Promise<{ ws: WebSocket; first: NetMsg }> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(`${this.relay}/room/${code}${host ? '?role=host' : ''}`); }
      catch { reject(new Error('Couldn\'t reach the game server.')); return; }
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; ws.close(); reject(new Error('The game server took too long to answer. Check your connection.')); } }, 12000);
      ws.onmessage = (e) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        let m: NetMsg; try { m = JSON.parse(String(e.data)); } catch { m = { t: '_bad' }; }
        resolve({ ws, first: m });
      };
      ws.onclose = ws.onerror = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Couldn\'t reach the game server. Check your connection, or this page may be blocking it.')); }
      };
    });
  }

  /** Wire up a connected room socket: game messages, join/leave notices, keep-alive pings. */
  private relayAttach(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data === 'pong') return;
      let m: NetMsg; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === '_join') { this.conns.set(String(m.id), null as unknown as DataConnection); this.onJoin(String(m.id)); return; }
      if (m.t === '_leave') { this.conns.delete(String(m.id)); this.onLeave(String(m.id)); return; }
      if (m.t.startsWith('_')) return;
      this.onMessage(m);
    };
    ws.onclose = ws.onerror = () => {
      if (this.ws !== ws) return; // we closed it ourselves
      this.ws = null; clearInterval(this.pingTimer);
      if (this.isHost) for (const id of [...this.conns.keys()]) this.onLeave(id); // our own link dropped
      this.conns.clear();
      this.onLeave('self');
    };
    // idle sockets get dropped by some networks; Cloudflare answers these pings without waking the room
    this.pingTimer = window.setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 20000);
  }

  private async relayHost(): Promise<string> {
    for (let tries = 0; tries < 5; tries++) {
      const code = makeCode();
      const { ws, first } = await this.relayOpen(code, true);
      if (first.t === '_taken') { ws.close(); continue; }
      if (first.t !== '_ready') { ws.close(); throw new Error('The game server refused the room.'); }
      this.code = code;
      this.relayAttach(ws);
      return code;
    }
    throw new Error('Couldn\'t find a free room code. Try again.');
  }

  private async relayJoin(): Promise<void> {
    const { ws, first } = await this.relayOpen(this.code, false);
    if (first.t === '_ready') { this.conns.set('p0', null as unknown as DataConnection); this.relayAttach(ws); return; }
    ws.close();
    if (first.t === '_noroom') throw new Error(`No room called ${this.code}. Check the code.`);
    if (first.t === '_full') throw new Error('That room is full.');
    throw new Error('The game server refused to join that room.');
  }

  /** Send to everyone in the room (or, with m.to, one player). */
  send(m: NetMsg) {
    m.from = this.myId;
    if (this.ws) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); return; }
    if (this.isHost) {
      if (m.to) this.conns.get(m.to)?.send(m);
      else for (const c of this.conns.values()) c.send(m);
    } else this.conns.get('p0')?.send(m);
  }

  /** Host only: assign an id (the host gives each joiner theirs in the welcome message). */
  setMyId(id: string) { this.myId = id; }

  kick(id: string) {
    if (this.ws) { this.send({ t: '_kick', id }); this.conns.delete(id); return; }
    this.conns.get(id)?.close(); this.conns.delete(id);
  }

  close() {
    if (this.ws) { const ws = this.ws; this.ws = null; clearInterval(this.pingTimer); try { ws.close(1000, 'bye'); } catch { /* ignore */ } }
    else for (const c of this.conns.values()) { try { c.close(); } catch { /* ignore */ } }
    this.conns.clear();
    this.peer?.destroy();
    this.peer = null; this.code = ''; this.nextId = 1;
  }
}

function describe(err: any): string {
  switch (err?.type) {
    case 'browser-incompatible': return window.top !== window.self
      ? 'Online play is blocked inside this embedded preview. Open the game on its own web page to play online.'
      : 'This browser can\'t do online play (no WebRTC).';
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
      return 'Couldn\'t reach the matchmaking server. Check your connection, or this page may be blocking it.';
    case 'webrtc': return 'The connection between players failed (a strict firewall can do this).';
    default: return err?.message || String(err);
  }
}
