// Minimal double-buffered terminal renderer: cell grid → diff → ANSI writes.

export type RGB = [number, number, number];

export function hex(h: string): RGB {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function dim(c: RGB, f: number): RGB {
  return [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)];
}

const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? '') ||
  ['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'kitty', 'Hyper', 'Tabby', 'alacritty'].includes(process.env.TERM_PROGRAM ?? '') ||
  /kitty|alacritty|ghostty|wezterm/i.test(process.env.TERM ?? '');

/** Map RGB → xterm-256 index (6x6x6 cube + greys). */
function to256(c: RGB): number {
  const [r, g, b] = c;
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function fgCode(c: RGB) {
  return TRUECOLOR ? `38;2;${c[0]};${c[1]};${c[2]}` : `38;5;${to256(c)}`;
}
function bgCode(c: RGB) {
  return TRUECOLOR ? `48;2;${c[0]};${c[1]};${c[2]}` : `48;5;${to256(c)}`;
}

const BLACK: RGB = [0, 0, 0];

export class Screen {
  w = 0;
  h = 0;
  ch: string[] = [];
  fg: RGB[] = [];
  bg: RGB[] = [];
  bold: Uint8Array = new Uint8Array(0);
  private prev: string[] = [];
  private out = process.stdout;
  cursor: { x: number; y: number } | null = null;

  constructor() {
    this.resize();
  }

  resize() {
    this.w = Math.max(20, this.out.columns || 100);
    this.h = Math.max(10, this.out.rows || 30);
    const n = this.w * this.h;
    this.ch = new Array(n).fill(' ');
    this.fg = new Array(n).fill(BLACK);
    this.bg = new Array(n).fill(BLACK);
    this.bold = new Uint8Array(n);
    this.prev = new Array(n).fill('');
  }

  clear() {
    this.ch.fill(' ');
    this.fg.fill(BLACK);
    this.bg.fill(BLACK);
    this.bold.fill(0);
  }

  put(x: number, y: number, s: string, fg: RGB, bg: RGB = BLACK, bold = false) {
    if (y < 0 || y >= this.h) return;
    let i = 0;
    for (const chr of s) {
      const xx = x + i++;
      if (xx < 0) continue;
      if (xx >= this.w) break;
      const k = y * this.w + xx;
      this.ch[k] = chr;
      this.fg[k] = fg;
      this.bg[k] = bg;
      this.bold[k] = bold ? 1 : 0;
    }
  }

  fill(x: number, y: number, w: number, h: number, bg: RGB) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
      const k = yy * this.w + xx;
      this.ch[k] = ' ';
      this.bg[k] = bg;
    }
  }

  box(x: number, y: number, w: number, h: number, color: RGB, title?: string, titleColor?: RGB) {
    if (w < 2 || h < 2) return;
    this.put(x, y, '┌' + '─'.repeat(w - 2) + '┐', color);
    for (let yy = y + 1; yy < y + h - 1; yy++) {
      this.put(x, yy, '│', color);
      this.put(x + w - 1, yy, '│', color);
    }
    this.put(x, y + h - 1, '└' + '─'.repeat(w - 2) + '┘', color);
    if (title) this.put(x + 2, y, ` ${title} `, titleColor ?? color, BLACK, true);
  }

  flush() {
    let buf = '\x1b[?25l';
    let lastFg = '', lastBg = '', lastBold = -1;
    let cx = -1, cy = -1;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const k = y * this.w + x;
        const f = this.fg[k], b = this.bg[k];
        const key = `${this.ch[k]}\u0000${f[0]},${f[1]},${f[2]}\u0000${b[0]},${b[1]},${b[2]}\u0000${this.bold[k]}`;
        if (this.prev[k] === key) continue;
        this.prev[k] = key;
        if (cy !== y || cx !== x) buf += `\x1b[${y + 1};${x + 1}H`;
        const fc = fgCode(f), bc = bgCode(b);
        if (this.bold[k] !== lastBold) { buf += this.bold[k] ? '\x1b[1m' : '\x1b[22m'; lastBold = this.bold[k]; }
        if (fc !== lastFg) { buf += `\x1b[${fc}m`; lastFg = fc; }
        if (bc !== lastBg) { buf += `\x1b[${bc}m`; lastBg = bc; }
        buf += this.ch[k];
        cx = x + 1;
        cy = y;
      }
    }
    if (this.cursor) buf += `\x1b[${this.cursor.y + 1};${this.cursor.x + 1}H\x1b[?25h`;
    this.out.write(buf);
  }

  enter() {
    this.out.write('\x1b[?1049h\x1b[2J\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  }

  mouse(on: boolean) {
    this.out.write(on ? '\x1b[?1000h\x1b[?1002h\x1b[?1006h' : '\x1b[?1000l\x1b[?1002l\x1b[?1006l');
  }

  leave() {
    this.out.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[0m\x1b[?25h\x1b[?1049l');
  }

  invalidate() {
    this.prev.fill('');
  }
}
