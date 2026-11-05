// One input layer: keyboard, touch and gamepad all feed the same values.
export interface InputState {
  pitch: number;   // -1 dive .. +1 pull up
  roll: number;    // -1 left .. +1 right
  brake: number;   // 0..1
  anyPress: boolean; // edge-triggered "start / restart"
  source: 'keyboard' | 'touch' | 'gamepad';
}

const DEAD = 0.15;
const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

export class Input {
  state: InputState = { pitch: 0, roll: 0, brake: 0, anyPress: false, source: 'keyboard' };
  private keys = new Set<string>();
  private pressed = false;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stickVec = { x: 0, y: 0 };
  private brakeIds = new Set<number>();
  private padButtonsPrev: boolean[] = [];
  private stickEl: HTMLElement;
  private knobEl: HTMLElement;
  invertPitch = false;

  constructor(target: HTMLElement | Document = document) {
    this.stickEl = document.getElementById('stick')!;
    this.knobEl = document.getElementById('knob')!;
    addEventListener('keydown', (e) => {
      if (!e.repeat) this.pressed = true;
      this.keys.add(e.code);
      this.state.source = 'keyboard';
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    const opts = { passive: false } as AddEventListenerOptions;
    target.addEventListener('touchstart', (e: any) => {
      e.preventDefault();
      this.state.source = 'touch';
      this.pressed = true;
      for (const t of (Array.from((e as TouchEvent).changedTouches) as Touch[])) {
        if (t.clientX < innerWidth * 0.5 && this.stickId === null) {
          this.stickId = t.identifier;
          this.stickOrigin = { x: t.clientX, y: t.clientY };
          this.stickVec = { x: 0, y: 0 };
          this.showStick(true);
        } else {
          this.brakeIds.add(t.identifier);
        }
      }
    }, opts);
    target.addEventListener('touchmove', (e: any) => {
      e.preventDefault();
      for (const t of (Array.from((e as TouchEvent).changedTouches) as Touch[])) {
        if (t.identifier === this.stickId) {
          const R = 60;
          let x = (t.clientX - this.stickOrigin.x) / R, y = (t.clientY - this.stickOrigin.y) / R;
          const len = Math.hypot(x, y);
          if (len > 1) { x /= len; y /= len; }
          this.stickVec = { x, y };
          this.knobEl.style.transform = `translate(${x * R}px, ${y * R}px)`;
        }
      }
    }, opts);
    const end = (e: any) => {
      e.preventDefault();
      for (const t of (Array.from((e as TouchEvent).changedTouches) as Touch[])) {
        if (t.identifier === this.stickId) { this.stickId = null; this.stickVec = { x: 0, y: 0 }; this.showStick(false); }
        this.brakeIds.delete(t.identifier);
      }
    };
    target.addEventListener('touchend', end, opts);
    target.addEventListener('touchcancel', end, opts);
    target.addEventListener('mousedown', () => { this.pressed = true; });
  }

  private showStick(on: boolean) {
    this.stickEl.style.display = on ? 'block' : 'none';
    this.stickEl.style.left = `${this.stickOrigin.x}px`;
    this.stickEl.style.top = `${this.stickOrigin.y}px`;
    this.knobEl.style.transform = 'translate(0px, 0px)';
  }

  poll(): InputState {
    const k = this.keys;
    let pitch = 0, roll = 0, brake = 0;
    // keyboard: W / Up = nose down (dive), S / Down = pull up (flight-sim style)
    if (k.has('KeyW') || k.has('ArrowUp')) pitch -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) pitch += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) roll -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) roll += 1;
    if (k.has('Space') || k.has('ShiftLeft') || k.has('ShiftRight')) brake = 1;

    // touch: stick up = dive, down = pull up
    if (this.stickId !== null) { pitch += this.stickVec.y; roll += this.stickVec.x; }
    if (this.brakeIds.size) brake = 1;

    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      const ax = dz(gp.axes[0] ?? 0), ay = dz(gp.axes[1] ?? 0);
      if (ax || ay) this.state.source = 'gamepad';
      roll += ax; pitch += ay;
      const rt = gp.buttons[7]?.value ?? 0, lt = gp.buttons[6]?.value ?? 0;
      const a = gp.buttons[0]?.pressed ? 1 : 0;
      brake = Math.max(brake, rt, lt, a);
      gp.buttons.forEach((b, i) => {
        if (b.pressed && !this.padButtonsPrev[i]) { this.pressed = true; this.state.source = 'gamepad'; }
        this.padButtonsPrev[i] = b.pressed;
      });
      break; // first connected pad only
    }

    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    this.state.pitch = clamp(this.invertPitch ? -pitch : pitch);
    this.state.roll = clamp(roll);
    this.state.brake = Math.min(1, brake);
    this.state.anyPress = this.pressed;
    this.pressed = false;
    return this.state;
  }
}
