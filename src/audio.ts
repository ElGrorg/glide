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

  /** Radar / lock beep. */
  beep(freq = 1200, len = 0.06, vol = 0.07) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + len + 0.01);
  }
}
