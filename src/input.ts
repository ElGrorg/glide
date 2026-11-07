// One input layer: keyboard, touch and gamepad all feed the same values.
export interface InputState {
  pitch: number;   // -1 dive .. +1 pull up
  roll: number;    // -1 left .. +1 right (a bank angle, or a roll *rate* in the flight layout)
  yaw: number;     // -1 left .. +1 right: rudder, flat turn without banking (flight layout)
  rollRate: boolean; // true: roll is rate-controlled (flight sim), false: stick sets the bank directly
  brake: number;   // 0..1
  tuck: number;    // 0..1: hold both bumpers (or Q+E) to fold the wings and dive
  fire: boolean;   // held: pea shooter
  dart: boolean;   // edge-triggered: fire a homing dart at your locked target
  aimX: number;    // -1..1 targeting reticle offset from your nose (right stick, mouse or right thumb)
  aimY: number;    // -1..1, + = down the screen
  anyPress: boolean; // edge-triggered "start / restart"
  trick: 'rollL' | 'rollR' | null; // edge-triggered barrel-roll request
  source: 'keyboard' | 'touch' | 'gamepad';
  /** Menu navigation, edge-triggered: x/y = -1/0/1 (d-pad, arrows, stick flick), ok = Enter/Space/A/Start, back = Esc/B. */
  nav: { x: number; y: number; ok: boolean; back: boolean; menu: boolean };
}

const DEAD = 0.15;
const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));
/** Soft response curve: fine control near the middle, full deflection at the edge. */
const expo = (v: number) => Math.sign(v) * (0.35 * Math.abs(v) + 0.65 * v * v);

export type PadScheme = 'flight' | 'classic' | 'wings';
const SCHEMES: PadScheme[] = ['flight', 'classic', 'wings'];

export class Input {
  state: InputState = { pitch: 0, roll: 0, yaw: 0, rollRate: true, brake: 0, tuck: 0, fire: false, dart: false, aimX: 0, aimY: 0, anyPress: false, trick: null, source: 'keyboard', nav: { x: 0, y: 0, ok: false, back: false, menu: false } };
  private nav = { x: 0, y: 0, ok: false, back: false, menu: false };
  private stickNav = { x: 0, y: 0 };
  private trick: InputState['trick'] = null;
  private swipes = new Map<number, { x: number; y: number; t: number }>();
  private keys = new Set<string>();
  private pressed = false;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stickVec = { x: 0, y: 0 };
  // second touch stick (right side) in the flight layout
  private rStickId: number | null = null;
  private rStickOrigin = { x: 0, y: 0 };
  private rStickVec = { x: 0, y: 0 };
  private brakeIds = new Set<number>();
  private fireIds = new Set<number>();
  private mouseFire = false;
  private dartReq = false;
  private mouseAim: { x: number; y: number } | null = null;
  private padButtonsPrev: boolean[] = [];
  private stickEl: HTMLElement;
  private knobEl: HTMLElement;
  invertPitch = false;
  // A bumper (or Q/E) waits a moment before rolling, in case the other one follows: both = tuck.
  private pendingRoll: 'rollL' | 'rollR' | null = null;
  private pendingAt = 0;
  private queueRoll(r: 'rollL' | 'rollR') { this.pendingRoll = r; this.pendingAt = performance.now(); }
  /** Control layout: 'flight' (two sticks, flight-sim style, default), 'classic' (one stick) or 'wings' (one stick per wing). */
  padScheme: PadScheme = 'flight';
  onSchemeChange: ((s: PadScheme) => void) | null = null;
  /** Online matches pin everyone to the same layout (the default flight sticks), so nobody's saved
   *  layout or a stray press of Back / Share / Create gives them different controls. */
  lockScheme: PadScheme | null = null;
  get scheme(): PadScheme { return this.lockScheme ?? this.padScheme; }
  /** The pad we're reading (the one last used), for rumble. */
  activePad: Gamepad | null = null;
  private padIndex = -1;
  /** Per pad: each axis's resting value when we first saw it (trigger axes on non-standard pads rest at -1). */
  private padRest = new Map<string, number[]>();
  toggleScheme() {
    if (this.lockScheme) return;
    this.padScheme = SCHEMES[(SCHEMES.indexOf(this.padScheme) + 1) % SCHEMES.length];
    try { localStorage.setItem('glide.layout', this.padScheme); } catch { /* storage unavailable */ }
    this.onSchemeChange?.(this.padScheme);
  }

  constructor(target: HTMLElement | Document = document) {
    try { const v = localStorage.getItem('glide.layout') as PadScheme; if (SCHEMES.includes(v)) this.padScheme = v; } catch { /* ignore */ }
    this.stickEl = document.getElementById('stick')!;
    this.knobEl = document.getElementById('knob')!;
    const typing = (e: Event) => (e.target as HTMLElement | null)?.tagName === 'INPUT';
    addEventListener('keydown', (e) => {
      if (typing(e)) return; // typing a name or room code
      if (!e.repeat) {
        this.pressed = true;
        if (e.code === 'KeyV') this.toggleScheme();
        if (e.code === 'KeyR') this.dartReq = true;
        const c = e.code;
        if (c === 'ArrowLeft' || c === 'KeyA') this.nav.x = -1;
        if (c === 'ArrowRight' || c === 'KeyD') this.nav.x = 1;
        if (c === 'ArrowUp' || c === 'KeyW') this.nav.y = -1;
        if (c === 'ArrowDown' || c === 'KeyS') this.nav.y = 1;
        if (c === 'Enter' || c === 'Space') this.nav.ok = true;
        if (c === 'Escape' || c === 'Backspace') this.nav.back = true;
        if (c === 'Escape') this.nav.menu = true;
      }
      this.keys.add(e.code);
      this.state.source = 'keyboard';
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    const opts = { passive: false } as AddEventListenerOptions;
    // Menus, lobby and crash screens (and the rotate-your-phone card) handle their own touches: they scroll
    // and take taps, so don't block them or turn them into a flight stick.
    const onScreen = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('#overlay:not(.hidden), #rotate');
    target.addEventListener('touchstart', (e: any) => {
      if (typing(e)) return; // let the text box take focus
      if (onScreen(e)) {
        this.state.source = 'touch';
        // a tap on the screen itself (not on a button) still counts, e.g. "tap to fly again"
        if (!(e.target as HTMLElement).closest('[data-act], #rotate')) this.pressed = true;
        return;
      }
      e.preventDefault();
      this.state.source = 'touch';
      this.pressed = true;
      for (const t of (Array.from((e as TouchEvent).changedTouches) as Touch[])) {
        const hit = (id: string) => {
          const b = document.getElementById(id)?.getBoundingClientRect();
          return !!b && b.width > 0 && t.clientX >= b.left - 12 && t.clientX <= b.right + 12 && t.clientY >= b.top - 12 && t.clientY <= b.bottom + 12;
        };
        if (hit('dartBtn')) { this.dartReq = true; this.fireIds.add(-1 - t.identifier); }
        else if (hit('fire')) {
          this.fireIds.add(t.identifier);
        } else if (t.clientX < innerWidth * 0.5 && this.stickId === null) {
          this.stickId = t.identifier;
          this.stickOrigin = { x: t.clientX, y: t.clientY };
          this.stickVec = { x: 0, y: 0 };
          this.showStick(true);
        } else {
          if (this.scheme === 'flight') {
            if (this.rStickId === null) { this.rStickId = t.identifier; this.rStickOrigin = { x: t.clientX, y: t.clientY }; this.rStickVec = { x: 0, y: 0 }; }
          } else this.brakeIds.add(t.identifier);
          this.swipes.set(t.identifier, { x: t.clientX, y: t.clientY, t: performance.now() });
        }
      }
    }, opts);
    target.addEventListener('touchmove', (e: any) => {
      if (onScreen(e)) return; // let the menu scroll
      e.preventDefault();
      for (const t of (Array.from((e as TouchEvent).changedTouches) as Touch[])) {
        if (t.identifier === this.stickId) {
          const R = 60;
          let x = (t.clientX - this.stickOrigin.x) / R, y = (t.clientY - this.stickOrigin.y) / R;
          const len = Math.hypot(x, y);
          if (len > 1) { x /= len; y /= len; }
          this.stickVec = { x, y };
          this.knobEl.style.transform = `translate(${x * R}px, ${y * R}px)`;
        } else if (t.identifier === this.rStickId) {
          const R = 60;
          let x = (t.clientX - this.rStickOrigin.x) / R, y = (t.clientY - this.rStickOrigin.y) / R;
          const len = Math.hypot(x, y);
          if (len > 1) { x /= len; y /= len; }
          this.rStickVec = { x, y };
        }
      }
    }, opts);
    const end = (e: any) => {
      if (onScreen(e)) return;
      e.preventDefault();
      for (const t of (Array.from((e as TouchEvent).changedTouches) as Touch[])) {
        if (t.identifier === this.stickId) { this.stickId = null; this.stickVec = { x: 0, y: 0 }; this.showStick(false); }
        if (t.identifier === this.rStickId) { this.rStickId = null; this.rStickVec = { x: 0, y: 0 }; }
        this.brakeIds.delete(t.identifier);
        if (this.fireIds.delete(t.identifier)) continue;
        if (this.fireIds.delete(-1 - t.identifier)) continue;
        // quick sideways swipe on the right side = barrel roll
        const sw = this.swipes.get(t.identifier);
        this.swipes.delete(t.identifier);
        const flick = this.scheme === 'flight' ? 200 : 450; // the right stick drags slower than a flick
        if (sw && performance.now() - sw.t < flick) {
          const dx = t.clientX - sw.x, dy = t.clientY - sw.y;
          if (Math.max(Math.abs(dx), Math.abs(dy)) > (this.scheme === 'flight' ? 80 : 45)) {
            // (barrel roll removed: flicks no longer do anything)
          }
        }
      }
    };
    target.addEventListener('touchend', end, opts);
    target.addEventListener('touchcancel', end, opts);
    target.addEventListener('mousedown', (e: any) => {
      this.pressed = true;
      if ((e as MouseEvent).button === 0) this.mouseFire = true;
      if ((e as MouseEvent).button === 2) this.dartReq = true;
    });
    target.addEventListener('contextmenu', (e: any) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      // the mouse aims the reticle (relative to the middle of the screen)
      this.mouseAim = { x: (e.clientX / innerWidth) * 2 - 1, y: (e.clientY / innerHeight) * 2 - 1 };
      if (this.state.source !== 'touch') this.state.source = 'keyboard';
    });
    addEventListener('mouseout', (e) => { if (!(e as MouseEvent).relatedTarget) this.mouseAim = null; });
    addEventListener('mouseup', () => { this.mouseFire = false; });
  }

  private showStick(on: boolean) {
    this.stickEl.style.display = on ? 'block' : 'none';
    this.stickEl.style.left = `${this.stickOrigin.x}px`;
    this.stickEl.style.top = `${this.stickOrigin.y}px`;
    this.knobEl.style.transform = 'translate(0px, 0px)';
  }

  /** Which connected pad to read. Some controllers show up as several "gamepads" (a PlayStation pad on
   *  Linux or Android also lists its motion sensors and touchpad, whose tilt axes sit far off centre and
   *  used to read as a held stick). Prefer real pads with the browser's standard layout, and stick with the
   *  one the player last pressed a button on. */
  private pickPad(): Gamepad | null {
    const pads = (navigator.getGamepads ? Array.from(navigator.getGamepads()) : []).filter((p): p is Gamepad =>
      !!p && p.connected !== false && !/motion|sensor|accel|gyro|touch ?pad/i.test(p.id) && p.axes.length >= 2 && p.buttons.length >= 4);
    if (!pads.length) { this.padIndex = -1; return null; }
    for (const p of pads) {
      if (p.index !== this.padIndex && p.buttons.some((b) => b.pressed)) { this.padIndex = p.index; this.padButtonsPrev = p.buttons.map((b) => b.pressed); }
    }
    const cur = pads.find((p) => p.index === this.padIndex);
    if (cur) return cur;
    const best = pads.find((p) => p.mapping === 'standard') ?? pads[0];
    this.padIndex = best.index;
    this.padButtonsPrev = best.buttons.map((b) => b.pressed);
    return best;
  }

  /** Left X, left Y, right X, right Y. With the browser's standard mapping that's axes 0-3 on every pad.
   *  Without it (some PlayStation / generic pads, mostly in Firefox and on Linux) the triggers are often
   *  axes too, resting at -1, and they can sit where the right stick should be: holding a trigger, or just
   *  having one, rolled or pitched the bird. Trigger-like axes (resting far from centre) are skipped. */
  private sticks(gp: Gamepad): [number, number, number, number] {
    const a = gp.axes;
    if (gp.mapping === 'standard' || a.length <= 4) return [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0];
    const key = `${gp.index}:${gp.id}`;
    let rest = this.padRest.get(key);
    if (!rest) { rest = Array.from(a); this.padRest.set(key, rest); }
    const right: number[] = [];
    for (let i = 2; i < a.length && right.length < 2; i++) if (Math.abs(rest[i] ?? 0) < 0.5) right.push(a[i]);
    return [a[0], a[1], right[0] ?? 0, right[1] ?? 0];
  }

  poll(): InputState {
    const k = this.keys;
    let pitch = 0, roll = 0, yaw = 0, brake = 0, tuck = 0;
    let fire = this.mouseFire || [...this.fireIds].some((id) => id >= 0) || k.has('KeyF') || k.has('KeyJ') || k.has('Enter');
    // keyboard: W / Up = nose down (dive), S / Down = pull up (flight-sim style)
    if (k.has('KeyW') || k.has('ArrowUp')) pitch -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) pitch += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) roll -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) roll += 1;
    if (k.has('KeyZ')) yaw -= 1;
    if (k.has('KeyC')) yaw += 1;
    if (k.has('Space') || k.has('ShiftLeft') || k.has('ShiftRight')) brake = 1;

    // touch: stick up = dive, down = pull up
    if (this.stickId !== null) {
      pitch += expo(this.stickVec.y);
      if (this.scheme !== 'flight') roll += expo(this.stickVec.x);
    }
    if (this.brakeIds.size) brake = 1;
    let aimX = 0, aimY = 0;
    // flight layout: left thumb pitches, right thumb rolls
    if (this.rStickId !== null) roll += expo(dz(this.rStickVec.x));
    if (this.mouseAim && this.state.source === 'keyboard') { aimX = this.mouseAim.x * 1.6; aimY = this.mouseAim.y * 1.6; }

    // gamepad
    const gp = this.pickPad();
    this.activePad = gp;
    if (gp) {
      const [ax0, ay0, rx0, ry0] = this.sticks(gp);
      const ax = dz(ax0), ay = dz(ay0), rx = dz(rx0), ry = dz(ry0);
      if (ax || ay || rx || ry) this.state.source = 'gamepad';
      // a flick of the left stick also moves through menus
      const fx = Math.abs(ax) > 0.6 ? Math.sign(ax) : Math.abs(ax) < 0.3 ? 0 : this.stickNav.x;
      const fy = Math.abs(ay) > 0.6 ? Math.sign(ay) : Math.abs(ay) < 0.3 ? 0 : this.stickNav.y;
      if (fx && fx !== this.stickNav.x) this.nav.x = fx;
      if (fy && fy !== this.stickNav.y) this.nav.y = fy;
      this.stickNav = { x: fx, y: fy };
      if (this.scheme === 'flight') {
        // flight sticks: left stick ↑↓ pitches, right stick ←→ rolls (the bank holds)
        pitch += expo(ay); roll += expo(rx);
      } else if (this.scheme === 'wings') {
        // wing sticks: left stick Y is the left wing, right stick Y is the right wing.
        // Stick up lifts that wing. Both up = dive, both down = climb,
        // opposite = hard bank (right up + left down = sharp left).
        roll += (ry - ay) * 0.75;
        pitch += (ay + ry) * 0.6;
      } else {
        roll += expo(ax); pitch += expo(ay);
      }
      // RT or X fires the pea shooter; LT or A is the air-brake
      const rt = gp.buttons[7]?.value ?? 0, lt = gp.buttons[6]?.value ?? 0;
      const a = gp.buttons[0]?.pressed ? 1 : 0;
      brake = Math.max(brake, lt, a);
      fire ||= rt > 0.3 || !!gp.buttons[2]?.pressed;
      gp.buttons.forEach((b, i) => {
        if (b.pressed && !this.padButtonsPrev[i]) {
          this.pressed = true; this.state.source = 'gamepad';
          if (i === 8) this.toggleScheme();
          if (i === 3) this.dartReq = true;
          if (i === 14) this.nav.x = -1;
          if (i === 15) this.nav.x = 1;
          if (i === 12) this.nav.y = -1;
          if (i === 13) this.nav.y = 1;
          if (i === 0 || i === 9) this.nav.ok = true;
          if (i === 9) this.nav.menu = true;
          if (i === 1) this.nav.back = true;
        }
        this.padButtonsPrev[i] = b.pressed;
      });
    }

    // both bumpers (or Q+E) held = tuck; a lone bumper becomes a barrel roll after a short wait
    let both = k.has('KeyQ') && k.has('KeyE');
    if (gp) both ||= !!(gp.buttons[4]?.pressed && gp.buttons[5]?.pressed);
    if (both) this.pendingRoll = null;
    else if (this.pendingRoll && performance.now() - this.pendingAt > 90) { this.trick = this.pendingRoll; this.pendingRoll = null; }
    this.state.tuck = 0; // tuck removed: speed only comes from diving (both / tuck kept as no-ops)

    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    this.state.pitch = clamp(this.invertPitch ? -pitch : pitch);
    this.state.roll = clamp(roll);
    this.state.yaw = clamp(yaw);
    this.state.rollRate = this.scheme === 'flight';
    this.state.brake = Math.min(1, brake);
    this.state.fire = fire;
    this.state.dart = this.dartReq; this.dartReq = false;
    this.state.aimX = clamp(aimX); this.state.aimY = clamp(aimY);
    this.state.nav = this.nav;
    this.nav = { x: 0, y: 0, ok: false, back: false, menu: false };
    this.state.anyPress = this.pressed;
    this.pressed = false;
    this.state.trick = this.trick;
    this.trick = null;
    return this.state;
  }
}
