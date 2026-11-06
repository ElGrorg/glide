import Peer, { type DataConnection, type PeerOptions } from 'peerjs';

// Online play over WebRTC, peer to peer. One player hosts a room and the others connect straight to them
// (a star: everything goes through the host, who relays it on). PeerJS's free public server only
// introduces the browsers to each other. After that the game data flows directly between players.
// PeerJS also brings STUN and free TURN relays, so players behind awkward home or mobile NATs can
// still reach the host.
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
  /** Host: a player's connection dropped. Client: the host went away (id = 'p0'). */
  onLeave: (id: string) => void = () => {};
  /** Host: a new player connected (before their hello). */
  onJoin: (id: string) => void = () => {};
  get open() { return !!this.peer && (this.isHost || this.conns.size > 0); }
  get peerCount() { return this.conns.size; }

  /** Open a room. Resolves with the room code once the signalling server has registered it. */
  host(): Promise<string> {
    this.close();
    this.isHost = true; this.myId = 'p0';
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

  /** Send to everyone in the room (or, with m.to, one player). */
  send(m: NetMsg) {
    m.from = this.myId;
    if (this.isHost) {
      if (m.to) this.conns.get(m.to)?.send(m);
      else for (const c of this.conns.values()) c.send(m);
    } else this.conns.get('p0')?.send(m);
  }

  /** Host only: assign an id (the host gives each joiner theirs in the welcome message). */
  setMyId(id: string) { this.myId = id; }

  kick(id: string) { this.conns.get(id)?.close(); this.conns.delete(id); }

  close() {
    for (const c of this.conns.values()) { try { c.close(); } catch { /* ignore */ } }
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
