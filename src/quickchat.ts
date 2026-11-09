// Quick chat: preset lines on the d-pad, like a racing-car-football game you might know.
// Press a direction to open a category, then a direction again to send that line.
// Keyboard: 1-4 (1 = up, 2 = left, 3 = right, 4 = down). Touch: the CHAT button, then tap a line.
// Only preset lines are ever sent (by number), so nobody can type anything nasty.

/** Directions, in the order the wheel lays them out. */
export type Dir = 'up' | 'left' | 'right' | 'down';
export const DIRS: Dir[] = ['up', 'left', 'right', 'down'];
const GLYPH: Record<Dir, string> = { up: '▲', left: '◀', right: '▶', down: '▼' };
const KEY: Record<Dir, string> = { up: '1', left: '2', right: '3', down: '4' };

interface Category { name: string; lines: string[] }
/** One category per direction, four lines each, in DIRS order. */
export const CATEGORIES: Category[] = [
  { name: 'Info', lines: ['I got it!', 'Need backup!', 'Behind you!', 'Going low!'] },
  { name: 'Nice', lines: ['Nice shot!', 'What a dive!', 'Great flying!', 'Thanks!'] },
  { name: 'Banter', lines: ['Too slow!', 'Catch me if you can!', 'Calculated.', 'Enjoy the ground!'] },
  { name: 'Oops', lines: ['Whoops…', 'My bad!', 'What a save!', 'gg'] },
];
export const LINES = CATEGORIES.flatMap((c) => c.lines);
export const lineText = (i: number) => LINES[i] ?? '';
/** Banter and wind-ups (what a bot might fire back): the banter lines, plus a sarcastic "What a save!" */
export const BANTER = [8, 9, 10, 11, 14];
export const OOPS = [12, 13, 15];
export const NICE = [4, 5, 6, 7];

const OPEN_FOR = 2.6;  // s the wheel stays up without a second press
const SPAM_N = 4, SPAM_WINDOW = 5, SPAM_MUTE = 4; // more than 4 lines in 5 s mutes you for 4 s

export class QuickChat {
  /** The open category (index into CATEGORIES), or -1 when the wheel is closed. */
  cat = -1;
  /** true: the wheel is showing categories, waiting for the first press. */
  picking = false;
  private openT = 0;
  private sent: number[] = [];
  private muteUntil = 0;
  private el: HTMLElement;
  private shown = '';

  constructor() { this.el = document.getElementById('qc')!; }

  get open() { return this.picking || this.cat >= 0; }
  close() { this.cat = -1; this.picking = false; this.draw(); }

  /** A d-pad / number-key / tap press. Returns the line to send (0..15) or -1. */
  press(d: Dir, now: number): number {
    const k = DIRS.indexOf(d);
    if (this.cat < 0) { this.cat = k; this.picking = false; this.openT = now; this.draw(); return -1; }
    const line = this.cat * 4 + k;
    this.close();
    if (now < this.muteUntil) return -1;
    this.sent = this.sent.filter((s) => now - s < SPAM_WINDOW);
    if (this.sent.length >= SPAM_N) { this.muteUntil = now + SPAM_MUTE; this.sent = []; return -2; }
    this.sent.push(now);
    return line;
  }
  /** Touch: the CHAT button opens (or closes) the category wheel. */
  toggle(now: number) {
    if (this.open) this.close();
    else { this.picking = true; this.openT = now; this.draw(); }
  }
  /** Muted for spamming: seconds left. */
  muted(now: number) { return Math.max(0, this.muteUntil - now); }

  update(now: number, show: boolean, touch: boolean) {
    if (this.open && (!show || now - this.openT > (this.picking ? OPEN_FOR * 2 : OPEN_FOR))) this.close();
    this.el.classList.toggle('touch', touch);
  }

  private draw() {
    const key = `${this.cat}:${this.picking}`;
    if (key === this.shown) return;
    this.shown = key;
    if (!this.open) { this.el.classList.remove('on'); return; }
    const inCat = this.cat >= 0;
    const label = (i: number) => (inCat ? CATEGORIES[this.cat].lines[i] : CATEGORIES[i].name);
    this.el.innerHTML = `<b class="mid">${inCat ? CATEGORIES[this.cat].name : 'Chat'}</b>` + DIRS.map((d, i) =>
      `<div class="qd ${d}" id="qc-${d}"><kbd>${GLYPH[d]}<em>${KEY[d]}</em></kbd>${label(i)}</div>`).join('');
    this.el.classList.add('on');
  }
}

// ---------- Bots ----------
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
/** What an AI bird might say back to a line of yours (or -1 for nothing). */
export function botReply(line: number): number {
  if (BANTER.includes(line)) return Math.random() < 0.55 ? pick([...BANTER, 15]) : -1; // trash talk gets trash talk back
  if (NICE.includes(line)) return Math.random() < 0.4 ? pick([7, 10, 15]) : -1;          // "Thanks!" / "Calculated." / "gg"
  if (OOPS.includes(line)) return Math.random() < 0.4 ? pick([8, 11, 14]) : -1;          // no mercy
  return -1;
}
export const BOT_NAMES = ['Kestrel', 'Rook', 'Talon', 'Magpie', 'Shrike', 'Gull', 'Jay', 'Osprey', 'Crow', 'Swift', 'Hobby', 'Merlin'];
