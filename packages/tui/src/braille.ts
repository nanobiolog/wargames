// Braille "pixel" canvas: every terminal cell holds a 2x4 dot matrix (U+2800..U+28FF).
import type { RGB, Screen } from './screen.ts';

const BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export class BrailleCanvas {
  cw = 0; // cells
  ch = 0;
  pw = 0; // pixels
  ph = 0;
  dots = new Uint8Array(0);
  color: (RGB | null)[] = [];
  prio = new Uint8Array(0);

  resize(cw: number, ch: number) {
    this.cw = cw;
    this.ch = ch;
    this.pw = cw * 2;
    this.ph = ch * 4;
    this.dots = new Uint8Array(cw * ch);
    this.color = new Array(cw * ch).fill(null);
    this.prio = new Uint8Array(cw * ch);
  }

  clear() {
    this.dots.fill(0);
    this.color.fill(null);
    this.prio.fill(0);
  }

  set(x: number, y: number, c: RGB, prio = 1) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.pw || y >= this.ph) return;
    const k = (y >> 2) * this.cw + (x >> 1);
    this.dots[k] |= BITS[y & 3][x & 1];
    if (prio >= this.prio[k]) {
      this.prio[k] = prio;
      this.color[k] = c;
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: RGB, prio = 1) {
    // cheap reject when completely outside
    if ((x0 < 0 && x1 < 0) || (y0 < 0 && y1 < 0) || (x0 >= this.pw && x1 >= this.pw) || (y0 >= this.ph && y1 >= this.ph)) return;
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    if (dx > 4000 || -dy > 4000) return;
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c, prio);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  circle(cx: number, cy: number, r: number, c: RGB, prio = 1) {
    const n = Math.max(12, Math.min(180, Math.round(r * 1.5)));
    let px = cx + r, py = cy;
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      this.line(px, py, x, y, c, prio);
      px = x; py = y;
    }
  }

  /** Copy into the screen at cell offset (ox, oy). Cells with no dots are left untouched. */
  blit(scr: Screen, ox: number, oy: number) {
    for (let y = 0; y < this.ch; y++) {
      for (let x = 0; x < this.cw; x++) {
        const k = y * this.cw + x;
        const d = this.dots[k];
        if (!d) continue;
        scr.put(ox + x, oy + y, String.fromCharCode(0x2800 + d), this.color[k] ?? [80, 160, 255]);
      }
    }
  }
}
