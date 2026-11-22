import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameClient, makeLink, parseLink } from '@coldlaunch/shared';
import { Game, GameServer } from '@coldlaunch/engine';
import { AiOpponent, toolCallToCommand, GAME_TOOLS, situationReport, type AiHost } from '@coldlaunch/ai';

describe('links', () => {
  it('round-trips session links', () => {
    const l = makeLink('127.0.0.1', 7700, 'abc123', 'USSR');
    expect(parseLink(l)).toEqual({ host: '127.0.0.1', port: 7700, token: 'abc123', role: 'USSR' });
    expect(parseLink('nonsense')).toBeNull();
  });
});

describe('AI tool mapping', () => {
  it('maps every tool to a valid command', () => {
    const samples: Record<string, Record<string, unknown>> = {
      set_defcon: { level: 3 }, launch_missiles: { from: 'icbm-minot', target: 'moscow', count: 2 }, scramble_bombers: { base: 'afb-loring' },
      bomber_strike: { group: 'bmr-loring-1', target: 'moscow' }, recall_bombers: { group: 'bmr-loring-1' }, move_unit: { unit: 'ssn-memphis', destination: 'barents sea' },
      hotline_message: { text: 'we seek calm' }, hold: {}, air_sortie: { from: 'cvbg-midway', mission: 'recon', to: 'sea of japan' }, cruise_missiles: { from: 'cvbg-midway', target: 'sag-minsk' },
    };
    for (const t of GAME_TOOLS) expect(toolCallToCommand({ name: t.name, args: samples[t.name] })).not.toBeNull();
    expect(toolCallToCommand({ name: 'nuke_everything', args: {} })).toBeNull();
  });
  it('situation report never leaks hidden enemy submarines', () => {
    const g = new Game(9);
    for (let i = 0; i < 50; i++) g.step();
    const rep = situationReport('USA', g.snapshot('USA'), g.staticWorld(), [], []);
    expect(rep).toContain('icbm-minot');
    expect(rep).not.toContain('ssbn-k219');
  });
});

describe('rule AI', () => {
  it('retaliates when attacked', () => {
    const game = new Game(11);
    game.s.speed = 30;
    const ls = new Set<(g: Game) => void>();
    const host: AiHost = { game, submit: (s, c) => game.apply(s, c), onTick: (f) => { ls.add(f); return () => ls.delete(f); } };
    new AiOpponent(host, 'USSR', 'rules', { personality: 0.2, cadenceSec: 30 }).attach();
    for (const lvl of [4, 3, 2, 1]) {
      for (let i = 0; i < 40; i++) { game.step(); for (const f of ls) f(game); }
      game.apply('USA', { op: 'defcon', level: lvl });
    }
    game.apply('USA', { op: 'launch', from: 'icbm-minot', target: 'kozelsk', count: 2 });
    for (let i = 0; i < 1500; i++) { game.step(); for (const f of ls) f(game); }
    expect(game.s.missiles.some((m) => m.side === 'USSR') || game.s.score.USSR.warheadsLaunched > 0).toBe(true);
  });
});

describe('server ⇄ client', () => {
  it('serves fog-filtered snapshots, commands, focus sync and the web display', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cl-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>wall</title>');
    const server = new GameServer({ port: 7799, game: new Game(3), playerSide: 'USA', staticDir: dir });
    await server.start();
    try {
      const a = new GameClient('tui');
      const b = new GameClient('gui');
      await a.connect(server.link('USA'));
      await b.connect(server.link('USA'));
      await new Promise((r) => setTimeout(r, 400));
      expect(a.snap?.viewer).toBe('USA');
      expect(a.snap?.units.every((u) => u.side === 'USA')).toBe(true);
      const r = await a.cmd({ op: 'defcon', level: 2 });
      expect(r.ok).toBe(false); // one step at a time
      expect((await a.cmd({ op: 'defcon', level: 4 })).ok).toBe(true);
      const got = new Promise((res) => b.on('focus', (f: any) => res(f.focus.label)));
      a.focus({ lat: 47.9, lon: -97.4, label: 'GRAND FORKS' });
      expect(await got).toBe('GRAND FORKS');
      const bad = new GameClient('other');
      await expect(bad.connect(makeLink('127.0.0.1', 7799, 'wrongtoken'))).rejects.toThrow();
      const html = await (await fetch(server.webLink('USA'))).text();
      expect(html).toContain('wall');
      expect((await fetch('http://127.0.0.1:7799/../../etc/passwd')).status).toBe(404);
      a.close(); b.close();
    } finally {
      server.stop();
    }
  });
});
