#!/usr/bin/env node
/**
 * MCP server: lets an AI coding tool (Claude Code, Gemini CLI, ...) command your side of a running
 * STRATCOM // COLD LAUNCH session. Everything it does shows up live in the terminal and on the wall display.
 *
 * Link discovery: --link <coldlaunch://...>  |  COLDLAUNCH_LINK  |  ~/.coldlaunch/session.json (written by `npm start`)
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GameClient, KIND_LABEL, fmtLatLon, type Command, type Unit, type Contact } from '@coldlaunch/shared';
import { situationReport } from '@coldlaunch/ai';

function findLink(): string | null {
  const i = process.argv.indexOf('--link');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (process.env.COLDLAUNCH_LINK) return process.env.COLDLAUNCH_LINK;
  const f = join(homedir(), '.coldlaunch', 'session.json');
  if (existsSync(f)) {
    try { return JSON.parse(readFileSync(f, 'utf8')).link ?? null; } catch { /* ignore */ }
  }
  return null;
}

const client = new GameClient('mcp');
let connecting: Promise<void> | null = null;

async function ensure(): Promise<GameClient> {
  if (client.connected) return client;
  const link = findLink();
  if (!link) throw new Error('No running game found. Start one with `npm start` (it writes ~/.coldlaunch/session.json) or pass --link.');
  connecting ??= client.connect(link).finally(() => (connecting = null));
  await connecting;
  // wait for the first snapshot
  for (let i = 0; i < 40 && !client.snap; i++) await new Promise((r) => setTimeout(r, 50));
  return client;
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const err = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

async function run(cmd: Command) {
  const c = await ensure();
  const r = await c.cmd(cmd);
  return r.ok ? text(r.msg) : err(r.msg);
}

function unitText(u: Unit | Contact): string {
  const x = u as Unit;
  const parts = [`${u.id} — ${u.name}`, `${KIND_LABEL[u.kind]} · ${u.cls} · ${u.side} · ${u.status} · ${fmtLatLon(u)}`];
  if (x.missiles !== undefined) parts.push(`missiles ${x.missiles}${x.missilesMax ? '/' + x.missilesMax : ''} × ${x.warheads ?? 1} RV × ${x.yieldKt} kt, range ${x.rangeKm} km`);
  if (x.aircraft !== undefined) parts.push(`aircraft ${x.aircraft}${x.fuel !== undefined ? `, fuel ${Math.round(x.fuel * 100)}%` : ''}${x.target ? `, target ${x.target}` : ''}`);
  if (x.interceptors !== undefined) parts.push(`interceptors ${x.interceptors}`);
  return parts.join('\n  ');
}

const server = new McpServer({ name: 'coldlaunch', version: '0.1.0' });

server.registerTool('get_situation', {
  title: 'Situation report',
  description: 'Fog-of-war situation report for your side: DEFCON levels, forces, known enemy units, inbound missiles, recent events and hotline traffic. Call this first.',
}, async () => {
  const c = await ensure();
  if (!c.snap) return err('no snapshot yet');
  const role = c.role === 'SPECTATOR' ? 'USA' : c.role!;
  return text(situationReport(role, c.snap, c.world, c.events.slice(-60), []));
});

server.registerTool('list_units', {
  title: 'List units',
  description: 'List your units (or known enemy contacts with enemy=true), optionally filtered by kind: silo, airbase, afb_int, bomber, radar, abm, command, navalbase, carrier, ssbn, ssn.',
  inputSchema: { kind: z.string().optional(), enemy: z.boolean().optional() },
}, async ({ kind, enemy }) => {
  const c = await ensure();
  const pool: (Unit | Contact)[] = enemy ? c.snap?.contacts ?? [] : c.snap?.units ?? [];
  const list = pool.filter((u) => !kind || u.kind === kind);
  return text(list.map(unitText).join('\n') || 'none');
});

server.registerTool('get_unit', {
  title: 'Unit details',
  description: 'Details of one unit or contact by id.',
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const c = await ensure();
  const u = [...(c.snap?.units ?? []), ...(c.snap?.contacts ?? [])].find((x) => x.id === id.toLowerCase());
  return u ? text(unitText(u)) : err(`unknown unit ${id}`);
});

server.registerTool('set_defcon', {
  title: 'Set DEFCON',
  description: 'Change readiness. Escalation is one level at a time (~90 game seconds apart); launches need DEFCON 1, bombers DEFCON 3.',
  inputSchema: { level: z.number().int().min(1).max(5) },
}, async ({ level }) => run({ op: 'defcon', level }));

server.registerTool('launch_missiles', {
  title: 'Launch ballistic missiles',
  description: 'IRREVERSIBLE. Fire missiles from one of your ICBM fields or SSBNs at a target (enemy unit id, city name, or "lat,lon"). Requires confirm=true and DEFCON 1. Only do this when the human player explicitly ordered it.',
  inputSchema: { from: z.string(), target: z.string(), count: z.number().int().min(1).max(50).optional(), confirm: z.boolean() },
  annotations: { destructiveHint: true },
}, async ({ from, target, count, confirm }) => {
  if (!confirm) return err('launch not sent: set confirm=true after the player has explicitly approved this launch');
  return run({ op: 'launch', from, target, count });
});

server.registerTool('scramble_bombers', {
  title: 'Scramble bombers',
  description: 'Launch bombers from one of your bomber bases to a holding orbit (they wait for a go-code).',
  inputSchema: { base: z.string(), count: z.number().int().min(1).max(40).optional(), orbit: z.string().optional() },
}, async ({ base, count, orbit }) => run({ op: 'scramble', base, count, to: orbit }));

server.registerTool('bomber_strike', {
  title: 'Bomber go-code',
  description: 'Send an airborne bomber group to attack a target. Requires confirm=true and DEFCON 1.',
  inputSchema: { group: z.string(), target: z.string(), confirm: z.boolean() },
  annotations: { destructiveHint: true },
}, async ({ group, target, confirm }) => {
  if (!confirm) return err('go-code not sent: set confirm=true after the player has explicitly approved this strike');
  return run({ op: 'strike', unit: group, target });
});

server.registerTool('recall_bombers', {
  title: 'Recall bombers',
  description: 'Recall an airborne bomber group to base.',
  inputSchema: { group: z.string() },
}, async ({ group }) => run({ op: 'recall', unit: group }));

server.registerTool('move_unit', {
  title: 'Move unit',
  description: 'Move a fleet, submarine or airborne bomber group to a sea area, place name or "lat,lon". Ships route around land.',
  inputSchema: { unit: z.string(), destination: z.string() },
}, async ({ unit, destination }) => run({ op: 'move', unit, to: destination }));

server.registerTool('hotline_send', {
  title: 'Hotline message',
  description: 'Send a message to the opposing side over the direct communications link.',
  inputSchema: { text: z.string().min(1).max(600) },
}, async ({ text: t }) => run({ op: 'hotline', text: t }));

server.registerTool('focus_map', {
  title: 'Focus map',
  description: 'Fly the terminal map and the wall display to a unit id, a place name or coordinates.',
  inputSchema: { unit: z.string().optional(), lat: z.number().optional(), lon: z.number().optional(), zoom: z.number().optional(), label: z.string().optional() },
}, async ({ unit, lat, lon, zoom, label }) => {
  const c = await ensure();
  let p: { lat: number; lon: number; name?: string } | undefined;
  if (unit) {
    const u = [...(c.snap?.units ?? []), ...(c.snap?.contacts ?? [])].find((x) => x.id === unit.toLowerCase());
    if (u) p = { lat: u.lat, lon: u.lon, name: u.name };
    else {
      const city = c.world?.cities.find((x) => x.name.toLowerCase().startsWith(unit.toLowerCase()));
      if (city) p = { lat: city.lat, lon: city.lon, name: city.name };
    }
  } else if (lat !== undefined && lon !== undefined) p = { lat, lon };
  if (!p) return err('give a known unit id / city, or lat+lon');
  c.focus({ lat: p.lat, lon: p.lon, zoom: zoom ?? 20, unit: unit?.toLowerCase(), label: label ?? p.name });
  return text(`displays focused on ${p.name ?? fmtLatLon(p)}`);
});

server.registerTool('set_speed', {
  title: 'Time compression',
  description: 'Set time compression (1-60) or pause/resume the simulation.',
  inputSchema: { speed: z.number().min(0.5).max(120).optional(), paused: z.boolean().optional() },
}, async ({ speed, paused }) => {
  if (speed !== undefined) await run({ op: 'speed', value: speed });
  if (paused !== undefined) return run({ op: 'pause', value: paused });
  return text(`speed ${speed}`);
});

await server.connect(new StdioServerTransport());
