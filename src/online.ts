import * as THREE from 'three';
import { Net, type NetMsg } from './net';
import type { BirdPalette, Glider } from './bird';
import { Dogfight, type DogfightEvent, type Enemy, type NetTarget, type Role } from './dogfight';
import { ARENA_R, terrainHeight, isSpace } from './world';
import { SPACE_R, clearSpawnY } from './space';

// Online arena: the game side of multiplayer.
// - Each player flies their own bird on their own machine (no input lag) and sends where it is ~20 times a second.
// - The host runs the AI birds (they chase whichever player is closest) and sends them out ~15 times a second.
// - Everyone draws everyone else a tenth of a second in the past, smoothly in between updates.
// - Hits: a pea that reaches you is judged on YOUR machine (everyone sees everyone's peas), a hit on an AI bird is
//   judged by whoever fired and confirmed by the host, and a dart at another player is flown on their machine,
//   so they can shake it exactly like a dart from an AI bird.

export interface MatchRules { seed: number; arena: number; bots: number; myDarts: boolean; enemyDarts: boolean; allies: boolean; /** space fighters in the fleet battle */ space?: boolean }
export interface PlayerInfo { id: string; name: string; kills: number; deaths: number; /** Team up: 0 or 1 */ team: number }

/** Team up: two teams. Everyone picks one in the lobby; teammates can't hurt each other. */
export const TEAM_NAMES = ['Red', 'Blue'];
export const TEAM_CSS = ['#ff6a5c', '#5aa8ff'];

const SEND_HZ = 20, AI_HZ = 15;
const INTERP_DELAY = 110; // ms behind real time we draw other birds
const DEFAULT_RTT = 120;   // ms, until a ping has measured the real round trip
export const PLAYER_PALETTES: BirdPalette[] = [
  { body: 0xd9733a, belly: 0xf2d7b0, wing: 0xb85a2b, tip: 0x5b3a26 }, // orange (same as single player)
  { body: 0x46a85a, belly: 0xe2f0d0, wing: 0x2f7d40, tip: 0x173d20 }, // green
  { body: 0x9a5cc8, belly: 0xeadcf5, wing: 0x7440a0, tip: 0x351d4d }, // purple
  { body: 0xe0c040, belly: 0xfaf3d0, wing: 0xb89a20, tip: 0x5a4a10 }, // yellow
  { body: 0xd04870, belly: 0xf8dbe4, wing: 0xa03050, tip: 0x4d1526 }, // pink
  { body: 0x30b0b8, belly: 0xd8f4f5, wing: 0x208088, tip: 0x0f3d40 }, // teal
  { body: 0xf0f0f0, belly: 0xffffff, wing: 0xc8c8c8, tip: 0x505050 }, // white
  { body: 0x8a6040, belly: 0xe8d8c8, wing: 0x6a4428, tip: 0x2d1d10 }, // brown
];
export const PLAYER_CSS = ['#ff9a5a', '#6fd884', '#c08cf0', '#ffe066', '#ff7aa0', '#5ee0e8', '#ffffff', '#c8986c'];
export const colorIndex = (id: string) => (Number(id.slice(1)) || 0) % PLAYER_PALETTES.length;

interface Snap { at: number; p: THREE.Vector3; q: THREE.Quaternion; v: THREE.Vector3; s: number; b: number }
interface Remote extends PlayerInfo {
  alive: boolean; buf: Snap[]; puppet: Enemy | null; target: NetTarget;
  /** whom their lock-on is on, and how far through (1 = locked) */
  lockOn: string; lockP: number;
  /** their health as they last reported it (a drop means they just took a hit) */
  hp: number;
  /** round trip to them in ms (measured with pings; 0 = not measured yet) */
  rtt: number;
}
interface AiPuppet { e: Enemy; buf: Snap[]; seen: number; target: string; lock: number; hp: number }

const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler();
const FWD = new THREE.Vector3(0, 0, -1);

export type OnlineEvent =
  | { type: 'lobby' }                                         // the roster or room status changed
  | { type: 'start'; rules: MatchRules; late: boolean }       // the host started (or you joined a match in progress)
  | { type: 'left'; reason: string }                          // you're out of the room
  | { type: 'feed'; text: string }                            // kill feed line
  | { type: 'scored' }                                        // you got credit for a kill
  | { type: 'wave'; wave: number; count: number; cleared: boolean }
  | { type: 'dartIn'; pos: THREE.Vector3; dir: THREE.Vector3; speed: number; by: string }
  | { type: 'hitConfirmed' };

export class Online {
  net = new Net();
  phase: 'off' | 'connecting' | 'lobby' | 'playing' = 'off';
  rules: MatchRules | null = null;
  name = 'Bird';
  kills = 0; deaths = 0;
  alive = false;
  /** your own health, sent with your state so the others see you smoke when you're hit */
  hp = 3;
  error = '';
  remotes = new Map<string, Remote>();
  private ai = new Map<string, AiPuppet>();
  private aiIds = new WeakMap<Enemy, string>();
  private nextAi = 1;
  private sendT = 0; private aiT = 0; private pingT = 0;
  private events: OnlineEvent[] = [];
  /** Host: AI-bird targets, one per other player (handed to Dogfight.targets). */
  targets: NetTarget[] = [];
  /** Your team (Team up). In the lobby you pick it; the host has the final say and sends it back in the roster. */
  team = 0;
  /** The host's Players setting as the lobby sees it (clients learn it from the roster, before the match starts). */
  lobbyAllies = false;

  constructor(private dogfight: Dogfight) {
    this.net.onMessage = (m) => this.receive(m);
    this.net.onLeave = (id) => this.playerLeft(id);
    dogfight.onShot = (f, v, owner) => {
      if (this.phase !== 'playing') return;
      this.net.send({ t: 'shot', f: arr(f), v: arr(v), o: owner === 'me' ? undefined : owner === 'ai' ? 'ai' : owner });
    };
  }

  get active() { return this.phase !== 'off'; }
  get isHost() { return this.net.isHost; }
  get myId() { return this.net.myId; }
  get code() { return this.net.code; }
  /** Everyone in the room, you first. */
  roster(): PlayerInfo[] {
    return [{ id: this.myId, name: this.name, kills: this.kills, deaths: this.deaths, team: this.team }, ...[...this.remotes.values()].sort((a, b) => (a.id < b.id ? -1 : 1))];
  }
  /** Is the match (or the lobby, before it starts) played in teams? */
  get teams() { return this.phase === 'playing' ? !!this.rules?.allies : this.lobbyAllies; }
  teamOf(id: string) { return id === this.myId ? this.team : this.remotes.get(id)?.team ?? -1; }
  /** On your team (Team up only): no lock-on, peas pass through, their shots can't hurt you. */
  isAlly(id: string) { return this.teams && id !== 'ai' && id !== this.myId && this.teamOf(id) === this.team; }
  /** Pick your team. Clients ask the host, who sends the roster back with it. */
  pickTeam(team: number) {
    this.team = team ? 1 : 0;
    if (this.isHost) this.sendRoster(); else this.net.send({ t: 'team', to: 'p0', team: this.team });
    this.events.push({ type: 'lobby' });
  }
  /** Host: switch Team up on or off in the lobby, so everyone sees the team picker. */
  setTeams(on: boolean) { this.lobbyAllies = on; if (this.isHost && this.phase !== 'off') this.sendRoster(); }
  nameOf(id: string) { return id === this.myId ? 'you' : id === 'ai' ? 'a wild bird' : this.remotes.get(id)?.name ?? 'someone'; }
  drain() { const e = this.events; this.events = []; return e; }

  // ---------- room setup ----------
  /** Listed in the room browser (relay servers only); private rooms are joined by code. */
  isPublic = true;

  async host(name: string, isPublic = true, teams = false) {
    this.reset(); this.name = name; this.lobbyAllies = teams; this.phase = 'connecting'; this.isPublic = isPublic;
    try { await this.net.host({ name, public: isPublic }); this.phase = 'lobby'; }
    catch (err) { this.fail((err as Error).message); return; }
    this.net.onJoin = () => { /* waits for their hello */ };
    this.events.push({ type: 'lobby' });
  }

  async join(code: string, name: string) {
    this.reset(); this.name = name; this.phase = 'connecting';
    try { await this.net.join(code); }
    catch (err) { this.fail((err as Error).message); return; }
    this.net.send({ t: 'hello', name });
    this.events.push({ type: 'lobby' });
  }

  /** Host: start the match for everyone. */
  start(rules: MatchRules) {
    if (!this.isHost) return;
    this.rules = rules;
    this.phase = 'playing';
    this.sendRoster(); // everyone's team, as it stands at the start
    this.net.send({ t: 'start', rules });
    this.net.meta({ phase: 'playing', arena: rules.space ? 99 : rules.arena }); // (99 = space, for the room list)
    this.events.push({ type: 'start', rules, late: false });
  }

  /** Host: list or hide the room in the browser. */
  setPublic(on: boolean) { this.isPublic = on; if (this.isHost) this.net.meta({ public: on }); }

  leave(reason = '') {
    if (this.phase === 'off') return;
    try { this.net.send({ t: 'bye' }); } catch { /* ignore */ }
    this.net.close();
    this.reset();
    if (reason) this.events.push({ type: 'left', reason });
  }

  private fail(msg: string) { this.net.close(); this.reset(); this.error = msg; this.events.push({ type: 'left', reason: msg }); }

  private reset() {
    for (const r of this.remotes.values()) if (r.puppet) r.puppet.alive = false;
    this.remotes.clear(); this.ai.clear(); this.targets.length = 0;
    this.phase = 'off'; this.rules = null; this.team = 0; this.lobbyAllies = false; this.kills = 0; this.deaths = 0; this.alive = false; this.error = '';
    this.dogfight.targets = [];
  }

  private remote(id: string, name = 'Bird'): Remote {
    let r = this.remotes.get(id);
    if (!r) {
      r = {
        id, name, kills: 0, deaths: 0, team: 0, alive: false, buf: [], puppet: null, lockOn: '', lockP: 0, hp: 3, rtt: 0,
        target: { id, pos: new THREE.Vector3(), vel: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), speed: 34, brake: 0, trick: null, active: false, inCloud: false },
      };
      this.remotes.set(id, r);
      this.targets.push(r.target);
    }
    return r;
  }

  private playerLeft(id: string) {
    if (id === 'self') { this.leave(); this.events.push({ type: 'left', reason: 'Lost the connection to the game server.' }); return; }
    if (id === 'p0' && !this.isHost) { this.leave(); this.events.push({ type: 'left', reason: 'The host left the room.' }); return; }
    const r = this.remotes.get(id);
    if (!r) return;
    if (r.puppet) { r.puppet.alive = false; r.puppet.dying = 99; }
    this.remotes.delete(id);
    this.targets.splice(this.targets.indexOf(r.target), 1);
    this.events.push({ type: 'feed', text: `${r.name} left` });
    if (this.isHost) this.sendRoster();
    this.events.push({ type: 'lobby' });
  }

  private sendRoster() {
    this.net.send({ t: 'roster', allies: this.phase === 'playing' ? !!this.rules?.allies : this.lobbyAllies,
      players: this.roster().map(({ id, name, kills, deaths, team }) => ({ id, name, kills, deaths, team })) });
  }

  // ---------- messages ----------
  private receive(m: NetMsg) {
    const from = m.from ?? '';
    switch (m.t) {
      case 'hello': { // host: someone new
        if (!this.isHost) return;
        if (this.remotes.size >= 7) { this.net.send({ t: 'full', to: from }); setTimeout(() => this.net.kick(from), 500); return; }
        const r = this.remote(from, clip(String(m.name ?? 'Bird')));
        r.name = clip(String(m.name ?? 'Bird'));
        // put them on the smaller team; they can switch in the lobby
        const sizes = [0, 0]; for (const p of this.roster()) if (p.id !== from) sizes[p.team ? 1 : 0]++;
        r.team = sizes[1] < sizes[0] ? 1 : 0;
        this.net.send({ t: 'welcome', to: from, you: from, team: r.team, rules: this.phase === 'playing' ? this.rules : null });
        this.sendRoster();
        this.events.push({ type: 'feed', text: `${r.name} joined` }, { type: 'lobby' });
        break;
      }
      case 'welcome': // client: you're in
        this.net.setMyId(String(m.you));
        this.team = Number(m.team) ? 1 : 0;
        this.phase = 'lobby';
        if (m.rules) { this.rules = m.rules as MatchRules; this.phase = 'playing'; this.events.push({ type: 'start', rules: this.rules, late: true }); }
        this.events.push({ type: 'lobby' });
        break;
      case 'full': this.leave(); this.events.push({ type: 'left', reason: 'That room is full (8 players).' }); break;
      case 'roster': {
        const list = m.players as PlayerInfo[];
        if (!this.isHost) this.lobbyAllies = !!m.allies;
        for (const p of list) {
          const team = Number(p.team) ? 1 : 0;
          if (p.id === this.myId) this.team = team;
          else { const r = this.remote(p.id, p.name); r.name = p.name; r.team = team; }
        }
        for (const id of [...this.remotes.keys()]) if (!list.some((p) => p.id === id)) this.playerLeft(id);
        this.events.push({ type: 'lobby' });
        break;
      }
      case 'start':
        this.rules = m.rules as MatchRules; this.phase = 'playing';
        this.events.push({ type: 'start', rules: this.rules, late: false });
        break;
      case 'team': { // host: a player picked a team
        if (!this.isHost) return;
        const r = this.remotes.get(from);
        if (r) { r.team = Number(m.team) ? 1 : 0; this.sendRoster(); this.events.push({ type: 'lobby' }); }
        break;
      }
      case 'bye': this.playerLeft(from); break;
      case 'st': this.onState(from, m); break;
      case 'ai': this.onAi(m); break;
      case 'shot': {
        if (this.phase !== 'playing') return;
        const owner = typeof m.o === 'string' ? m.o : from;
        // they aimed at where they drew you: INTERP_DELAY in the past, plus your update's trip to them and
        // this shot's trip back. Judge the pea against where you were then, so what they saw is what they get.
        const rtt = this.remotes.get(from)?.rtt || DEFAULT_RTT;
        this.dogfight.addPea(vec(m.f), vec(m.v), owner, INTERP_DELAY + rtt);
        break;
      }
      case 'pg': this.net.send({ t: 'po', to: from, ts: m.ts }); break;
      case 'po': {
        const r = this.remotes.get(from), sample = performance.now() - Number(m.ts);
        if (r && sample >= 0 && sample < 3000) r.rtt = r.rtt ? r.rtt * 0.8 + sample * 0.2 : sample;
        break;
      }
      case 'dart': // a dart has been fired at you: it flies here, against your own bird
        if (m.to === this.myId && this.alive) this.events.push({ type: 'dartIn', pos: vec(m.p), dir: vec(m.d), speed: Number(m.s), by: typeof m.by === 'string' ? m.by : from });
        break;
      case 'hit': { // host: another player hit one of the AI birds
        if (!this.isHost) return;
        const e = this.findAi(String(m.id));
        if (e) {
          const out: DogfightEvent[] = [];
          this.dogfight.damage(e, m.w === 'dart' ? 99 : 1, from, out);
          for (const ev of out) if (ev.type === 'kill') this.aiKilled(ev.enemy, from, ev.ground);
          this.net.send({ t: 'hitok', to: from });
        }
        break;
      }
      case 'hitok': this.events.push({ type: 'hitConfirmed' }); break;
      case 'kill': { // an AI bird went down
        const a = this.ai.get(String(m.id));
        if (a && a.e.alive) { a.e.alive = false; a.e.dying = 0.001; }
        this.feedKill(String(m.by), 'a wild bird', !!m.g);
        break;
      }
      case 'down': { // a player went down
        const r = this.remotes.get(from);
        if (r) {
          r.alive = false; r.target.active = false; r.deaths = Number(m.d ?? r.deaths + 1);
          if (r.puppet?.alive) { r.puppet.alive = false; r.puppet.dying = 0.001; }
          this.feedKill(String(m.by ?? ''), r.name, false, String(m.how ?? ''));
        }
        break;
      }
      case 'wave':
        if (!this.isHost) { this.dogfight.wave = Number(m.wave); this.events.push({ type: 'wave', wave: Number(m.wave), count: Number(m.count), cleared: !!m.cleared }); }
        break;
    }
  }

  private feedKill(by: string, victim: string, ground: boolean, how = '') {
    if (by === this.myId) { this.kills++; this.events.push({ type: 'scored' }); }
    const killer = by && by !== 'ai' ? this.nameOf(by) : '';
    const v = victim === this.name ? 'you' : victim;
    const text = killer
      ? `${cap(killer)} ${how === 'dart' ? 'darted' : ground ? 'drove' : 'downed'} ${v}${ground ? ' into the ground' : ''}`
      : how === 'crash' ? `${cap(v)} crashed` : `${cap(v)} ${v === 'you' ? 'were' : 'was'} shot down by a wild bird`;
    this.events.push({ type: 'feed', text });
  }

  private onState(from: string, m: NetMsg) {
    const r = this.remotes.get(from) ?? this.remote(from);
    r.kills = Number(m.k ?? r.kills); r.deaths = Number(m.d ?? r.deaths);
    r.lockOn = String(m.lk ?? ''); r.lockP = Number(m.lp ?? 0);
    const alive = !!m.a;
    const hp = m.h === undefined ? 3 : Number(m.h);
    // they took a hit (their own machine decides that): everyone sees the feathers fly
    if (alive && r.alive && hp < r.hp && r.puppet?.alive) this.dogfight.hurtFx(r.puppet);
    r.hp = hp;
    if (r.puppet) r.puppet.hp = Math.max(0, hp);
    const snap: Snap = { at: performance.now(), p: vec(m.p), q: quat(m.q), v: vec(m.v), s: Number(m.s), b: Number(m.b) };
    if (alive && !r.alive) r.buf.length = 0; // fresh spawn: don't slide over from where they died
    r.alive = alive;
    r.buf.push(snap); if (r.buf.length > 12) r.buf.shift();
    const tg = r.target;
    tg.pos.copy(snap.p); tg.vel.copy(snap.v); tg.speed = snap.s; tg.brake = snap.b; tg.inCloud = !!m.c;
    tg.dir.copy(FWD).applyQuaternion(snap.q);
    tg.active = alive && this.phase === 'playing';
  }

  private onAi(m: NetMsg) {
    if (this.isHost || this.phase !== 'playing') return;
    const now = performance.now();
    for (const row of m.l as unknown[][]) {
      const [id, role, x, y, z, qx, qy, qz, qw, s, alive, tgt, lock, hp, maxHp] = row as [string, Role, number, number, number, number, number, number, number, number, number, string, number, number?, number?];
      let a = this.ai.get(id);
      if (!a || !this.dogfight.enemies.includes(a.e)) {
        if (!alive) continue;
        a = { e: this.dogfight.addPuppet('ai', id, role), buf: [], seen: now, target: '', lock: 0, hp: hp ?? 3 };
        a.e.pos.set(x, y, z);
        this.ai.set(id, a);
      }
      a.seen = now; a.target = tgt; a.lock = lock;
      a.e.role = role;
      if (hp !== undefined) {
        // the host says it took a hit: puff it here too
        if (alive && a.e.alive && hp < a.hp) this.dogfight.hurtFx(a.e);
        a.hp = hp; a.e.hp = Math.max(0, hp); if (maxHp) a.e.maxHp = maxHp;
      }
      if (!alive) { if (a.e.alive) { a.e.alive = false; a.e.dying = 0.001; } continue; }
      a.buf.push({ at: now, p: new THREE.Vector3(x, y, z), q: new THREE.Quaternion(qx, qy, qz, qw), v: new THREE.Vector3(), s, b: 0 });
      if (a.buf.length > 12) a.buf.shift();
    }
  }

  private findAi(id: string) { return this.dogfight.enemies.find((e) => !e.remote && this.aiId(e) === id) ?? null; }
  private aiId(e: Enemy) { let id = this.aiIds.get(e); if (!id) { id = `a${this.nextAi++}`; this.aiIds.set(e, id); } return id; }

  /** Host: an AI bird went down (to anyone). Tell the room who gets the credit. */
  aiKilled(e: Enemy, by: string, ground: boolean) {
    const who = by === 'me' ? this.myId : by || '';
    this.net.send({ t: 'kill', id: this.aiId(e), by: who, g: ground });
    this.feedKill(who, 'a wild bird', ground);
  }

  /** You went down. `by` = whoever last hit you (player id, 'ai' or ''). */
  downed(by: string, how: 'pea' | 'dart' | 'crash') {
    this.deaths++; this.alive = false;
    this.net.send({ t: 'down', by, how, d: this.deaths });
  }

  /** You hit something another machine owns. */
  netHit(e: Enemy, weapon: 'pea' | 'dart') {
    if (e.remote === 'ai') this.net.send({ t: 'hit', to: 'p0', id: e.netId, w: weapon });
  }

  sendDart(to: string, pos: THREE.Vector3, dir: THREE.Vector3, speed: number, by = this.myId) {
    if (to === 'me' || to === this.myId) return;
    this.net.send({ t: 'dart', to, p: arr(pos), d: arr(dir), s: speed, by });
  }

  waveEvent(wave: number, count: number, cleared: boolean) { if (this.isHost) this.net.send({ t: 'wave', wave, count, cleared }); }

  /** A random spot near the rim, facing the middle, well up off the ground. */
  spawnPoint(): { x: number; y: number; z: number; heading: number } {
    // spread players round the rim by player number, so nobody spawns on top of anyone else
    // Team up: each team starts on its own side of the arena
    const a = this.teams
      ? this.team * Math.PI + ((colorIndex(this.myId) / PLAYER_PALETTES.length) - 0.5) * 1.6 + (Math.random() - 0.5) * 0.3
      : (colorIndex(this.myId) / PLAYER_PALETTES.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    if (isSpace()) {
      const r = SPACE_R * (0.55 + Math.random() * 0.15);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      return { x, y: clearSpawnY(x, z, new THREE.Vector3(-x / r, 0, -z / r)), z, heading: Math.atan2(x, z) };
    }
    const r = ARENA_R * (0.55 + Math.random() * 0.15);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    let ground = 0;
    for (let d = -60; d <= 160; d += 20) ground = Math.max(ground, terrainHeight(x - (x / r) * d, z - (z / r) * d));
    return { x, y: ground + 55, z, heading: Math.atan2(x, z) };
  }

  // ---------- every frame ----------
  /** Before the dogfight update: move everyone else's birds. */
  preUpdate() {
    if (this.phase !== 'playing') return;
    const now = performance.now(), at = now - INTERP_DELAY;
    for (const r of this.remotes.values()) {
      const alive = r.alive && r.buf.length > 0;
      if (alive && (!r.puppet || !r.puppet.alive || !this.dogfight.enemies.includes(r.puppet))) {
        if (r.puppet && this.dogfight.enemies.includes(r.puppet)) r.puppet.dying = 99;
        r.puppet = this.dogfight.addPuppet('human', r.id, 'hunter', PLAYER_PALETTES[colorIndex(r.id)]);
        r.puppet.hp = r.hp; r.puppet.maxHp = 3;
      }
      if (r.puppet) r.puppet.friendly = this.isAlly(r.id);
      if (alive && r.puppet) interp(r.puppet, r.buf, at);
    }
    for (const [id, a] of this.ai) {
      if (!this.dogfight.enemies.includes(a.e)) { this.ai.delete(id); continue; }
      if (now - a.seen > 3000 && a.e.alive) { a.e.alive = false; a.e.dying = 99; }
      if (a.e.alive && a.buf.length) interp(a.e, a.buf, at);
    }
    this.dogfight.targets = this.isHost ? this.targets : [];
  }

  /** After the dogfight update: warnings about other machines' birds, then send our state. */
  postUpdate(dt: number, g: Glider, quat: THREE.Quaternion, inCloud: boolean) {
    if (this.phase !== 'playing') return;
    const df = this.dogfight;
    // AI birds (on the host's machine) and other players locking on to you
    for (const a of this.ai.values()) {
      if (!a.e.alive || a.target !== this.myId) continue;
      if (a.lock > 0) df.dartLockProgress = Math.max(df.dartLockProgress, a.lock);
      tailCheck(df, a.e, g);
    }
    for (const r of this.remotes.values()) {
      if (!r.alive || !r.puppet?.alive || this.isAlly(r.id)) continue;
      if (r.lockOn === this.myId && r.lockP > 0) df.dartLockProgress = Math.max(df.dartLockProgress, r.lockP);
      tailCheck(df, r.puppet, g);
    }

    this.pingT -= dt;
    if (this.pingT <= 0) { this.pingT = 1; this.net.send({ t: 'pg', ts: Math.round(performance.now()) }); }
    this.sendT -= dt;
    if (this.sendT <= 0) {
      this.sendT = 1 / SEND_HZ;
      const lockE = df.locked ?? df.locking;
      this.net.send({
        t: 'st', p: arr(g.pos), q: [quat.x, quat.y, quat.z, quat.w].map(r4), v: arr(g.vel), s: r2(g.speed), b: r2(g.brake),
        a: this.alive ? 1 : 0, h: this.hp, c: inCloud ? 1 : 0, k: this.kills, d: this.deaths,
        lk: lockE?.remote === 'human' ? lockE.netId : '', lp: df.locked ? 1 : r2(df.lockT),
      });
    }
    if (this.isHost) {
      this.aiT -= dt;
      if (this.aiT <= 0) {
        this.aiT = 1 / AI_HZ;
        const l: unknown[] = [];
        for (const e of df.enemies) {
          if (e.remote) continue;
          if (!e.alive && e.dying > 0.5) continue;
          const q = e.mesh.quaternion;
          l.push([this.aiId(e), e.role, r2(e.pos.x), r2(e.pos.y), r2(e.pos.z), r4(q.x), r4(q.y), r4(q.z), r4(q.w), r2(e.speed), e.alive ? 1 : 0,
            e.targetId === 'me' ? this.myId : e.targetId, r2(e.dartLock / 1.6), Math.max(0, e.hp), e.maxHp]);
        }
        this.net.send({ t: 'ai', l });
      }
    }
  }
}

/** Draw a bird where it was INTERP_DELAY ago, between the two updates either side (or a little past the last). */
function interp(e: Enemy, buf: Snap[], at: number) {
  let a = buf[0], b = buf[buf.length - 1];
  for (let i = buf.length - 1; i > 0; i--) if (buf[i - 1].at <= at) { a = buf[i - 1]; b = buf[i]; break; }
  if (at >= b.at || a === b) {
    // past the newest update: carry on along its last heading for a moment
    const ahead = Math.min(0.25, (at - b.at) / 1000);
    const vel = b.v.lengthSq() > 0 ? b.v : tmpV.copy(FWD).applyQuaternion(b.q).multiplyScalar(b.s);
    e.pos.copy(b.p).addScaledVector(vel, Math.max(0, ahead));
    e.quat.copy(b.q); e.speed = b.s;
    if (isSpace()) e.sv.copy(b.v);
  } else {
    const k = THREE.MathUtils.clamp((at - a.at) / Math.max(1, b.at - a.at), 0, 1);
    e.pos.lerpVectors(a.p, b.p, k);
    e.quat.slerpQuaternions(a.q, b.q, k);
    e.speed = a.s + (b.s - a.s) * k;
    if (isSpace()) e.sv.lerpVectors(a.v, b.v, k);
  }
  e.dir.copy(FWD).applyQuaternion(e.quat);
  tmpE.setFromQuaternion(tmpQ.copy(e.quat), 'YXZ');
  e.heading = tmpE.y; e.roll = -tmpE.z;
}

/** Someone behind you with their nose on you: light up the tail warning. */
function tailCheck(df: Dogfight, e: Enemy, g: Glider) {
  const to = tmpV.copy(g.pos).sub(e.pos); const dist = to.length();
  if (dist > 150 || dist < 1) return;
  to.divideScalar(dist);
  if (g.dir.dot(to) < 0.3) return; // not behind you
  const aim = THREE.MathUtils.clamp(1 - e.dir.angleTo(to) / 0.4, 0, 1);
  df.tailThreat = Math.max(df.tailThreat, Math.max(0.35, aim));
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const arr = (v: THREE.Vector3) => [r2(v.x), r2(v.y), r2(v.z)];
const vec = (a: unknown) => { const v = (a as number[]) ?? [0, 0, 0]; return new THREE.Vector3(+v[0] || 0, +v[1] || 0, +v[2] || 0); };
const quat = (a: unknown) => { const v = (a as number[]) ?? [0, 0, 0, 1]; return new THREE.Quaternion(+v[0] || 0, +v[1] || 0, +v[2] || 0, +v[3] || 1).normalize(); };
const clip = (s: string) => s.replace(/[<>&"]/g, '').trim().slice(0, 16) || 'Bird';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
