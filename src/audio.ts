// Procedural wind and whoosh sounds (no audio files needed).
export class WindAudio {
  private ctx: AudioContext | null = null;
  private gain!: GainNode;
  private filter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  muted = false;

  start() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'bandpass'; this.filter.Q.value = 0.7; this.filter.frequency.value = 400;
    this.gain = ctx.createGain(); this.gain.gain.value = 0;
    src.connect(this.filter).connect(this.gain).connect(ctx.destination);
    src.start();
  }

  update(speed: number, mist: number, active: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, Math.max(0, (speed - 10) / 60));
    const vol = this.muted || !active ? 0 : 0.08 + s * 0.5 + mist * 0.15;
    this.gain.gain.setTargetAtTime(vol, t, 0.15);
    this.filter.frequency.setTargetAtTime(250 + s * 1400, t, 0.2);
  }

  whoosh(strength = 1) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.5;
    f.frequency.setValueAtTime(600, t); f.frequency.exponentialRampToValueAtTime(2400, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.6 * strength, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t, Math.random()); src.stop(t + 0.5);
  }

  thud() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.3);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.45);
  }

  /** Little pea-shooter pop. Enemy shots are lower. */
  pew(enemy = false) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square';
    const f0 = enemy ? 520 : 900;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + 0.07);
    const g = ctx.createGain(); g.gain.setValueAtTime(enemy ? 0.05 : 0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.09);
  }

  /** Space laser: a punchy zap (a falling saw and a square an octave down, plus a click of noise). Enemy bolts are lower. */
  laser(enemy = false) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const f0 = (enemy ? 900 : 1500) * (0.95 + Math.random() * 0.1);
    const out = ctx.createGain(); out.gain.setValueAtTime(enemy ? 0.05 : 0.065, t); out.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(5000, t); f.frequency.exponentialRampToValueAtTime(600, t + 0.16);
    f.connect(out).connect(ctx.destination);
    for (const [type, mul] of [['sawtooth', 1], ['square', 0.5]] as const) {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0 * mul, t); o.frequency.exponentialRampToValueAtTime(f0 * mul * 0.12, t + 0.16);
      o.connect(f); o.start(t); o.stop(t + 0.19);
    }
    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.25, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    n.connect(ng).connect(f); n.start(t, Math.random()); n.stop(t + 0.04);
  }

  /** An explosion: a deep thump and a roaring crackle, quieter and duller the further off it is. */
  boom(size = 1, dist = 0) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const near = Math.min(1, 60 / Math.max(dist, 20)) * Math.min(1.3, size);
    if (near < 0.04) return;
    const len = 0.9 + size * 0.6;
    const out = ctx.createGain(); out.gain.value = 0.55 * near;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900 + 2600 * near, t); lp.frequency.exponentialRampToValueAtTime(120, t + len);
    lp.connect(out).connect(ctx.destination);
    const n = ctx.createBufferSource(); n.buffer = this.noise; n.playbackRate.value = 0.6;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(1, t); ng.gain.exponentialRampToValueAtTime(0.001, t + len);
    n.connect(ng).connect(lp); n.start(t, Math.random()); n.stop(t + len);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.6);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    o.connect(og).connect(out); o.start(t); o.stop(t + 0.75);
  }

  /** A bolt on your shields: a bright metallic crackle. */
  shieldHit() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(320, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.25);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.14, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.32);
    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.5, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    n.connect(hp).connect(ng).connect(ctx.destination); n.start(t, Math.random()); n.stop(t + 0.24);
  }

  private eng: { o1: OscillatorNode; o2: OscillatorNode; lp: BiquadFilterNode; g: GainNode; ng: GainNode; nf: BiquadFilterNode } | null = null;
  /** Space fighter engine: a low two-oscillator drone that climbs with the throttle and roars on boost,
   *  dropping to a hush when you cut the engines to drift. `on` false fades it out. */
  engine(on: boolean, throttle: number, boost: number, drift: number) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (!this.eng) {
      const g = ctx.createGain(); g.gain.value = 0;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
      const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.detune.value = 14;
      o1.connect(lp); o2.connect(lp); lp.connect(g).connect(ctx.destination);
      const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true;
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.Q.value = 0.8;
      const ng = ctx.createGain(); ng.gain.value = 0;
      n.connect(nf).connect(ng).connect(ctx.destination);
      o1.start(); o2.start(); n.start();
      this.eng = { o1, o2, lp, g, ng, nf };
    }
    const e = this.eng, live = on && !this.muted ? 1 : 0;
    const cut = 1 - 0.75 * drift;
    const f = 42 + throttle * 30 + boost * 26;
    e.o1.frequency.setTargetAtTime(f, t, 0.15); e.o2.frequency.setTargetAtTime(f * 1.5, t, 0.15);
    e.lp.frequency.setTargetAtTime(180 + throttle * 300 + boost * 900, t, 0.12);
    e.g.gain.setTargetAtTime(live * (0.07 + boost * 0.07) * cut, t, 0.12);
    e.nf.frequency.setTargetAtTime(500 + boost * 1400, t, 0.15);
    e.ng.gain.setTargetAtTime(live * (0.02 + boost * 0.16) * cut, t, 0.1);
  }

  /** Dart launch: a rising whoosh-chirp. */
  dart() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(300, t); o.frequency.exponentialRampToValueAtTime(1100, t + 0.25);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.32);
  }

  /** Radar / lock beep. */
  beep(freq = 1200, len = 0.06, vol = 0.07) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + len + 0.01);
  }
}
