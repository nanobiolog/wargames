import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cells, hasGlyph, textSegments } from '../src/font.ts';

describe('vector font', () => {
  it('draws Turkish letters with accents instead of "?"', () => {
    const c = cells('Muğla Kırşehir İzmir Çankırı Gümüşhane Elâzığ');
    expect(c.every((x) => hasGlyph(x.ch))).toBe(true);
    const g = cells('Ğ')[0];
    expect(g.ch).toBe('G');
    expect(g.extra.length).toBe(1); // breve
    expect(cells('İ')[0].extra.length).toBe(1); // dot above
    expect(cells('Ş')[0].extra.length).toBe(1); // cedilla
    expect(cells('ı')[0]).toEqual({ ch: 'I', extra: [] });
  });
  it('handles stacked marks, stroked letters and other scripts', () => {
    expect(cells('ằ')[0].extra.length).toBe(2);
    expect(cells('Łódź').map((c) => c.ch).join('')).toBe('LODZ');
    expect(cells('Øresund')[0].extra.length).toBe(1);
    expect(cells('Straße').map((c) => c.ch).join('')).toBe('STRASSE');
    expect(cells('Москва').map((c) => c.ch).join('')).toBe('MOSKVA');
    expect(cells('a‎b').length).toBe(2); // invisible direction mark dropped
  });
  it('every character in the gazetteer has a glyph', () => {
    const places: [string][] = JSON.parse(readFileSync(new URL('../../data/geo/places.json', import.meta.url), 'utf8'));
    const missing = new Set<string>();
    for (const [name] of places) for (const c of cells(name)) if (!hasGlyph(c.ch)) missing.add(c.ch);
    expect([...missing]).toEqual([]);
    expect(textSegments('Iğdır', 10).length).toBeGreaterThan(0);
  });
});
