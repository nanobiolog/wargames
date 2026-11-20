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

// Combining marks (drawn above / below the base letter). Grid units, y < 0 is above the cap height.
const MARKS: Record<string, string> = {
  '\u0300': '1,-1.6 2.5,-0.5', // grave
  '\u0301': '1.5,-0.5 3,-1.6', // acute
  '\u0302': '1,-0.5 2,-1.5 3,-0.5', // circumflex
  '\u0303': '0.5,-0.6 1.3,-1.3 2.7,-0.7 3.5,-1.4', // tilde
  '\u0304': '0.8,-0.9 3.2,-0.9', // macron
  '\u0306': '1,-1.5 1.4,-0.6 2.6,-0.6 3,-1.5', // breve (Ğ)
  '\u0307': '1.8,-1.2 2.2,-1.2 2.2,-0.6 1.8,-0.6 1.8,-1.2', // dot above (İ)
  '\u0308': '1,-1.2 1,-0.6|3,-1.2 3,-0.6', // diaeresis (Ö Ü)
  '\u030A': '1.5,-1.7 2.5,-1.7 2.5,-0.6 1.5,-0.6 1.5,-1.7', // ring (Å)
  '\u030B': '1,-0.5 2,-1.6|2.4,-0.5 3.4,-1.6', // double acute (Ő)
  '\u030C': '1,-1.5 2,-0.5 3,-1.5', // caron (Š Č Ž)
  '\u031B': '4,0.2 4.7,-0.6', // horn (Ơ Ư)
  '\u0323': '1.8,6.8 2.2,6.8 2.2,7.3 1.8,7.3 1.8,6.8', // dot below
  '\u0326': '2,6.7 1.5,7.6', // comma below (Ș Ț)
  '\u0327': '2,6 2.5,6.7 1.4,7.5', // cedilla (Ç Ş)
  '\u0328': '3.2,6 2.5,6.8 3.5,7.5', // ogonek (Ą Ę)
  '\u0331': '0.8,7 3.2,7', // macron below
};
const BELOW = new Set(['\u0323', '\u0326', '\u0327', '\u0328', '\u0331']);

// Letters that do not decompose, plus transliteration for scripts the stroke font does not draw.
const SPECIAL: Record<string, string> = {
  'ı': 'I', 'ß': 'SS', 'ẞ': 'SS', 'Æ': 'AE', 'æ': 'AE', 'Œ': 'OE', 'œ': 'OE', 'Þ': 'TH', 'þ': 'TH', 'ĸ': 'K', 'ŉ': "'N",
  '‘': "'", '’': "'", '‚': ',', '“': '"', '”': '"', '„': '"', '′': "'", '″': '"', '×': 'X', '−': '-',
};
const CYRILLIC: Record<string, string> = {
  А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'E', Ж: 'ZH', З: 'Z', И: 'I', Й: 'Y', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O',
  П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'KH', Ц: 'TS', Ч: 'CH', Ш: 'SH', Щ: 'SHCH', Ъ: '', Ы: 'Y', Ь: '', Э: 'E',
  Ю: 'YU', Я: 'YA', Є: 'YE', І: 'I', Ї: 'YI', Ґ: 'G',
};
const GREEK: Record<string, string> = {
  Α: 'A', Β: 'V', Γ: 'G', Δ: 'D', Ε: 'E', Ζ: 'Z', Η: 'I', Θ: 'TH', Ι: 'I', Κ: 'K', Λ: 'L', Μ: 'M', Ν: 'N', Ξ: 'X', Ο: 'O', Π: 'P',
  Ρ: 'R', Σ: 'S', Τ: 'T', Υ: 'Y', Φ: 'F', Χ: 'CH', Ψ: 'PS', Ω: 'O',
};
// Base letters with an extra stroke instead of a combining mark.
const STROKED: Record<string, [string, string]> = {
  Ø: ['O', '4,0 0,6'], Ł: ['L', '-0.3,4 2,2.4'], Đ: ['D', '-0.6,3 1.6,3'], Ð: ['D', '-0.6,3 1.6,3'], Ħ: ['H', '-0.5,1.5 4.5,1.5'], Ŧ: ['T', '1,3 3,3'],
};

/** One drawable cell: a base glyph plus extra strokes (accents). */
interface Cell { ch: string; extra: string[] }

/** Normalise any text into drawable cells (uppercase, accents split off, other scripts transliterated). */
export function cells(text: string): Cell[] {
  const out: Cell[] = [];
  const src = text.replace(/[—–]/g, '-').replace(/…/g, '...').replace(/·/g, '-');
  for (const raw of src) {
    if (/\p{Cf}|\p{Cc}/u.test(raw)) continue; // invisible direction marks etc.
    const sp = SPECIAL[raw];
    if (sp !== undefined) { for (const c of sp) out.push({ ch: c, extra: [] }); continue; }
    const up = raw.toUpperCase();
    const st = STROKED[up];
    if (st) { out.push({ ch: st[0], extra: [st[1]] }); continue; }
    const tr = CYRILLIC[up] ?? GREEK[up];
    if (tr !== undefined) { for (const c of tr) out.push({ ch: c, extra: [] }); continue; }
    const [base, ...marks] = up.normalize('NFD');
    const extra: string[] = [];
    let above = 0;
    for (const m of marks) {
      const shape = MARKS[m];
      if (!shape) continue;
      if (BELOW.has(m)) extra.push(shape);
      else {
        // stack multiple accents (Vietnamese ằ, ố …)
        const dy = above * -1.3;
        extra.push(dy ? shape.split('|').map((poly) => poly.split(' ').map((xy) => { const [x, y] = xy.split(',').map(Number); return `${x},${y + dy}`; }).join(' ')).join('|') : shape);
        above++;
      }
    }
    out.push({ ch: base ?? up, extra });
  }
  return out;
}

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
  const s = size / 6;
  const cs = seven ? [...text].map((ch) => ({ ch, extra: [] as string[] })) : cells(text);
  const width = (cs.length * ADVANCE - 2) * s;
  let x0 = -width * align;
  const y0 = -size / 2;
  const emit = (polys: Poly[]) => {
    for (const poly of polys) {
      for (let i = 1; i < poly.length; i++) {
        out.push(x0 + poly[i - 1][0] * s, y0 + poly[i - 1][1] * s, x0 + poly[i][0] * s, y0 + poly[i][1] * s);
      }
    }
  };
  for (const c of cs) {
    emit(glyph(c.ch, seven));
    for (const e of c.extra) emit(parse(e));
    x0 += ADVANCE * s;
  }
  return out;
}

export function textWidth(text: string, size: number) {
  return (cells(text).length * ADVANCE - 2) * (size / 6);
}

export const hasGlyph = (ch: string) => ch === ' ' || G[ch.toUpperCase()] !== undefined;
