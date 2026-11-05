import type { FlightInput } from './bird';

// One input layer: keyboard, touch and gamepad all feed the same values.
export interface InputState extends FlightInput {
  anyPress: boolean; // edge-triggered "start / restart"
  source: 'keyboard' | 'touch' | 'gamepad';
}

const DEAD = 0.15;
const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

interface VStick { id: number | null; ox: number; oy: number; x: number; y: number; t0: number; el: HTMLElement; knob: HTMLElement }

export class Input {
  state: InputState = { pitch: 0, roll: 0, yaw: 0, tuck: 0, brake: 0, flap: false, trick: null, anyPress: false, source: 'keyboard' };
  private keys = new Set<string>();
  private pressed = false;
  private flap = false;
  private trick: FlightInput['trick'] = null;
  private padPrev: boolean[] = [];
  private left: VStick;
  private right: VStick;
  invertPitch = false;

  constructor(target: HTMLElement | Document = document) {
    const mk = (s: string, k: string): VStick => ({ id: null, ox: 0, oy: 0, x: 0, y: 0, t0: 0, el: document.getElementById(s)!, knob: document.getElementById(k)! });
    this.left = mk('stick', 'knob');
    this.right = mk('stick2', 'knob2');

    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      this.state.source = 'keyboard';
      if (!e.repeat) {
        this.pressed = true;
        if (e.code === 'Space') this.flap = true;
        if (e.code === 'KeyQ') this.trick = 'rollL';
        if (e.code === 'KeyE') this.trick = 'rollR';
      }
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    const opts = { passive: false } as AddEventListenerOptions;
    const touches = (e: Event) => Array.from((e as TouchEvent).changedTouches) as Touch[];
    target.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.state.source = 'touch';
      this.pressed = true;
      for (const t of touches(e)) {
        const s = t.clientX < innerWidth * 0.5 ? this.left : this.right;
        if (s.id !== null) continue;
        Object.assign(s, { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0, t0: performance.now() });
        this.show(s, true);
      }
    }, opts);
    target.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of touches(e)) for (const s of [this.left, this.right]) {
        if (s.id !== t.identifier) continue;
        const R = 60;
        let x = (t.clientX - s.ox) / R, y = (t.clientY - s.oy) / R;
        const len = Math.hypot(x, y);
        if (len > 1) { x /= len; y /= len; }
        s.x = x; s.y = y;
        s.knob.style.transform = `translate(${x * R}px, ${y * R}px)`;
      }
    }, opts);
    const end = (e: Event) => {
      e.preventDefault();
      for (const t of touches(e)) for (const s of [this.left, this.right]) {
        if (s.id !== t.identifier) continue;
        if (s === this.right) {
          // right side gestures: quick tap = flap, quick sideways swipe = snap roll
          const dt = performance.now() - s.t0;
          const dx = t.clientX - s.ox, dy = t.clientY - s.oy;
          if (dt < 230 && Math.hypot(dx, dy) < 18) this.flap = true;
          else if (dt < 320 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) this.trick = dx < 0 ? 'rollL' : 'rollR';
        }
        s.id = null; s.x = 0; s.y = 0;
        this.show(s, false);
      }
    };
    target.addEventListener('touchend', end, opts);
    target.addEventListener('touchcancel', end, opts);
    target.addEventListener('mousedown', () => { this.pressed = true; });
  }

  private show(s: VStick, on: boolean) {
    s.el.style.display = on ? 'block' : 'none';
    s.el.style.left = `${s.ox}px`;
    s.el.style.top = `${s.oy}px`;
    s.knob.style.transform = 'translate(0px, 0px)';
  }

  poll(): InputState {
    const k = this.keys;
    let pitch = 0, roll = 0, yaw = 0, tuck = 0, brake = 0;
    // keyboard: W = nose down (dive), S = pull up (flight-sim style)
    if (k.has('KeyW')) pitch -= 1;
    if (k.has('KeyS')) pitch += 1;
    if (k.has('KeyA')) roll -= 0.9; // keys bank and hold; Q/E (or full stick) roll all the way round
    if (k.has('KeyD')) roll += 0.9;
    if (k.has('ArrowLeft')) yaw -= 1;
    if (k.has('ArrowRight')) yaw += 1;
    if (k.has('ArrowUp') || k.has('ShiftLeft') || k.has('ShiftRight')) tuck = 1;
    if (k.has('ArrowDown') || k.has('KeyC')) brake = 1;

    // touch: left stick pitch/roll, right stick yaw + tuck (down) / flare (up)
    if (this.left.id !== null) { pitch += this.left.y; roll += this.left.x; }
    if (this.right.id !== null && performance.now() - this.right.t0 > 120) {
      yaw += this.right.x;
      tuck = Math.max(tuck, this.right.y); brake = Math.max(brake, -this.right.y);
    }

    // gamepad: left stick flies, right stick yaws (x) and tucks/flares (y)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      const lx = dz(gp.axes[0] ?? 0), ly = dz(gp.axes[1] ?? 0);
      const rx = dz(gp.axes[2] ?? 0), ry = dz(gp.axes[3] ?? 0);
      if (lx || ly || rx || ry) this.state.source = 'gamepad';
      roll += lx; pitch += ly; yaw += rx;
      tuck = Math.max(tuck, ry, gp.buttons[7]?.value ?? 0);
      brake = Math.max(brake, -ry, gp.buttons[6]?.value ?? 0);
      gp.buttons.forEach((b, i) => {
        if (b.pressed && !this.padPrev[i]) {
          this.pressed = true; this.state.source = 'gamepad';
          if (i === 0) this.flap = true;
          if (i === 4) this.trick = 'rollL';
          if (i === 5) this.trick = 'rollR';
        }
        this.padPrev[i] = b.pressed;
      });
      break; // first connected pad only
    }

    const st = this.state;
    st.pitch = clamp1(this.invertPitch ? -pitch : pitch);
    st.roll = clamp1(roll); st.yaw = clamp1(yaw);
    st.tuck = Math.min(1, tuck); st.brake = Math.min(1, brake);
    st.flap = this.flap; st.trick = this.trick; st.anyPress = this.pressed;
    this.flap = false; this.trick = null; this.pressed = false;
    return st;
  }
}
