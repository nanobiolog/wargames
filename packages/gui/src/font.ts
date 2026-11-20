// Single-stroke vector font (4x6 grid) and 7-segment digits — drawn as glowing line segments.

const G: Record<string, string> = {
  A: '0,6 0,2 2,0 4,2 4,6|0,3.5 4,3.5', B: '0,0 0,6 3,6 4,5 4,4 3,3 0,3|0,0 3,0 4,1 4,2 3,3', C: '4,0 1,0 0,1 0,5 1,6 4,6',
  D: '0,0 0,6 2,6 4,4 4,2 2,0 0,0', E: '4,0 0,0 0,6 4,6|0,3 3,3', F: '4,0 0,0 0,6|0,3 3,3', G: '4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3 2,3',
  H: '0,0 0,6|4,0 4,6|0,3 4,3', I: '1,0 3,0|2,0 2,6|1,6 3,6', J: '4,0 4,5 3,6 1,6 0,5', K: '0,0 0,6|4,0 0,4|1,3 4,6', L: '0,0 0,6 4,6',
  M: '0,6 0,0 2,3 4,0 4,6', N: '0,6 0,0 4,6 4,0', O: '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0', P: '0,6 0,0 3,0 4,1 4,2 3,3 0,3',
  Q: '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|2,4 4,6', R: '0,6 0,0 3,0 4,1 4,2 3,3 0,3|2,3 4,6', S: '4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5',
  T: '0,0 4,0|2,0 2,6', U: '0,0 0,5 1,6 3,6 4,5 4,0', V: '0,0 2,6 4,0', W: '0,0 1,6 2,3 3,6 4,0', X: '0,0 4,6|4,0 0,6', Y: '0,0 2,3 4,0|2,3 2,6',
  Z: '0,0 4,0 0,6 4,6',
  '0': '1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|4,1 0,5', '1': '1,1 2,0 2,6|1,6 3,6', '2': '0,1 1,0 3,0 4,1 4,2 0,6 4,6',
  '3': '0,1 1,0 3,0 4,1 4,2 3,3 4,4 4,5 3,6 1,6 0,5|1,3 3,3', '4': '3,6 3,0 0,4 4,4', '5': '4,0 0,0 0,3 3,3 4,4 4,5 3,6 0,6',
  '6': '3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,4 3,3 0,3', '7': '0,0 4,0 1,6', '8': '1,0 3,0 4,1 4,2 3,3 1,3 0,2 0,1 1,0|1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3',
  '9': '4,3 1,3 0,2 0,1 1,0 3,0 4,1 4,5 3,6 1,6',
  '.': '2,5.5 2,6', ',': '2,5 1.5,6.5', '-': '1,3 3,3', ':': '2,1.5 2,2|2,4 2,4.5', ';': '2,1.5 2,2|2,4.5 1.5,6', '/': '4,0 0,6',
  '(': '3,0 2,1 2,5 3,6', ')': '1,0 2,1 2,5 1,6', "'": '2,0 2,1.5', '"': '1,0 1,1.5|3,0 3,1.5', '+': '2,1.5 2,4.5|0.5,3 3.5,3',
  '°': '1,0 2,0 2,1 1,1 1,0', '#': '1,0 1,6|3,0 3,6|0,2 4,2|0,4 4,4', _: '0,6 4,6', '?': '0,1 1,0 3,0 4,1 4,2 2,3 2,4|2,5.5 2,6',
  '!': '2,0 2,4|2,5.5 2,6', '>': '0,0 4,3 0,6', '<': '4,0 0,3 4,6', '=': '0,2 4,2|0,4 4,4', '*': '2,1 2,5|0.5,2 3.5,4|3.5,2 0.5,4',
  '%': '0,6 4,0|0,0 1,0 1,1 0,1 0,0|3,5 4,5 4,6 3,6 3,5', '[': '3,0 1,0 1,6 3,6', ']': '1,0 3,0 3,6 1,6', '→': '0,3 4,3|2,1 4,3 2,5',
  '&': '4,6 1,2 1,1 2,0 3,1 3,2 0,4 0,5 1,6 2,6 4,4', '@': '3,4 3,2 1,2 1,4 3,4 4,3 4,1 3,0 1,0 0,1 0,5 1,6 4,6', '|': '2,0 2,6',
  '■': '0.5,1 3.5,1 3.5,5 0.5,5 0.5,1|0.5,2 3.5,2|0.5,3 3.5,3|0.5,4 3.5,4', '▲': '0,6 2,1 4,6 0,6', '►': '0,0 4,3 0,6 0,0', '✱': '2,0 2,6|0,3 4,3|0.5,1 3.5,5|3.5,1 0.5,5',
};

const SEG: Record<string, string> = { a: '0,0 4,0', b: '4,0 4,3', c: '4,3 4,6', d: '0,6 4,6', e: '0,3 0,6', f: '0,0 0,3', g: '0,3 4,3' };
const SEVEN: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '',
};

type Poly = [number, number][];
const cache = new Map<string, Poly[]>();

function parse(src: string): Poly[] {
  if (!src) return [];
  return src.split('|').map((p) => p.trim().split(/\s+/).map((xy) => xy.split(',').map(Number) as [number, number]));
}

export function glyph(ch: string, seven = false): Poly[] {
  const key = (seven ? '7' : 'g') + ch;
  let g = cache.get(key);
  if (!g) {
    if (seven && SEVEN[ch] !== undefined) g = SEVEN[ch].split('').map((s) => parse(SEG[s])[0]);
    else g = parse(G[ch.toUpperCase()] ?? (ch === ' ' ? '' : G['?']));
    cache.set(key, g);
  }
  return g;
}

export const ADVANCE = 6; // grid units per character

/**
 * Emit the strokes of a text string as px-space segments relative to an anchor.
 * size = cap height in px. align: 0 left, 0.5 centre, 1 right.
 */
export function textSegments(text: string, size: number, align = 0, seven = false, out: number[] = []): number[] {
  text = text.replace(/[—–]/g, '-').replace(/…/g, '...').replace(/·/g, '-');
  const s = size / 6;
  const width = (text.length * ADVANCE - 2) * s;
  let x0 = -width * align;
  const y0 = -size / 2;
  for (const ch of text) {
    for (const poly of glyph(ch, seven)) {
      for (let i = 1; i < poly.length; i++) {
        out.push(x0 + poly[i - 1][0] * s, y0 + poly[i - 1][1] * s, x0 + poly[i][0] * s, y0 + poly[i][1] * s);
      }
    }
    x0 += ADVANCE * s;
  }
  return out;
}

export function textWidth(text: string, size: number) {
  text = text.replace(/…/g, '...');
  return (text.length * ADVANCE - 2) * (size / 6);
}
