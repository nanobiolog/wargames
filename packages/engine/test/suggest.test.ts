import { describe, expect, it } from 'vitest';
import { suggest, helpLines, COMMANDS, type SuggestCtx } from '@coldlaunch/shared';
import { Game } from '@coldlaunch/engine';

const g = new Game(1);
for (let i = 0; i < 30; i++) g.step();
const ctx: SuggestCtx = { snap: g.snapshot('USA'), world: g.staticWorld(), role: 'USA', where: 'tui' };

describe('type-ahead suggestions', () => {
  it('completes verbs', () => {
    const s = suggest('lau', ctx);
    expect(s.ghost).toBe('nch ');
    expect(s.hint).toContain('launch <silo|ssbn> at <target>');
  });
  it('suggests own launchers, then the keyword, then enemy targets', () => {
    expect(suggest('launch icbm-w', ctx).ghost).toBe('arren ');
    expect(suggest('launch icbm-warren', ctx).ghost).toBe(' at ');
    expect(suggest('launch icbm-warren ', ctx).ghost).toBe('at ');
    const t = suggest('launch icbm-warren at ', ctx);
    expect(t.candidates[0]).toMatch(/^icbm-/); // enemy silo fields first
    expect(suggest('launch icbm-warren at mosc', ctx).ghost).toBe('ow');
  });
  it('handles multi-word places and the next keyword', () => {
    expect(suggest('move cvbg-midway to sea of j', ctx).ghost).toBe('apan');
    expect(suggest('scramble afb-lor', ctx).ghost).toBe('ing');
  });
  it('never offers enemy units as launchers or hidden submarines as targets', () => {
    expect(suggest('launch ', ctx).candidates.every((c) => !c.includes('dombarovsky'))).toBe(true);
    expect(suggest('launch icbm-minot at k2', ctx).candidates).not.toContain('ssbn-k219');
  });
  it('proposes next orders on an empty line', () => {
    const s = suggest('', ctx);
    expect(s.candidates.length).toBeGreaterThan(0);
    expect(s.ghost).toBe(s.candidates[0]);
  });
  it('completes command names after help', () => {
    expect(suggest('help la', ctx).ghost).toBe('unch');
  });
  it('help covers every command', () => {
    const all = helpLines('tui').join('\n');
    for (const c of COMMANDS.filter((x) => x.scope !== 'gui')) expect(all).toContain(c.syntax);
    expect(helpLines('tui', 'launch')[0]).toContain('irreversible');
  });
});
