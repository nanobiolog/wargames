import { z } from 'zod';
import type { GameEvent, Role, Snapshot, StaticWorld } from './types.ts';

export const DEFAULT_PORT = 7700;

// ------------------------------------------------------------------ commands
// The same commands are issued by the terminal, the GUI, the MCP server and AI opponents.

const ref = z.string().min(1).max(80);

export const CommandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('defcon'), level: z.number().int().min(1).max(5) }),
  z.object({ op: z.literal('launch'), from: ref, target: ref, count: z.number().int().min(1).max(50).optional() }),
  z.object({ op: z.literal('move'), unit: ref, to: ref }),
  z.object({ op: z.literal('scramble'), base: ref, count: z.number().int().min(1).max(40).optional(), to: ref.optional() }),
  z.object({ op: z.literal('strike'), unit: ref, target: ref }),
  z.object({ op: z.literal('recall'), unit: ref }),
  z.object({ op: z.literal('speed'), value: z.number().min(0.5).max(120) }),
  z.object({ op: z.literal('pause'), value: z.boolean().optional() }),
  z.object({ op: z.literal('hotline'), text: z.string().min(1).max(600) }),
  z.object({ op: z.literal('hold'), note: z.string().max(300).optional() }),
]);
export type Command = z.infer<typeof CommandSchema>;

// ------------------------------------------------------------------ messages

export const FocusSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  zoom: z.number().optional(),
  label: z.string().optional(),
  unit: z.string().optional(),
});
export type Focus = z.infer<typeof FocusSchema>;

export const ClientMsgSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    token: z.string(),
    role: z.enum(['USA', 'USSR', 'SPECTATOR']).optional(),
    client: z.enum(['tui', 'gui', 'mcp', 'ai', 'other']),
  }),
  z.object({ t: z.literal('cmd'), id: z.string().optional(), cmd: CommandSchema }),
  z.object({ t: z.literal('focus'), focus: FocusSchema }),
  z.object({ t: z.literal('ask'), id: z.string().optional(), text: z.string().min(1).max(1000) }),
  z.object({ t: z.literal('plan'), id: z.string(), cmds: z.array(CommandSchema).nullable() }),
  z.object({ t: z.literal('save'), name: z.string().regex(/^[\w-]{1,40}$/) }),
  z.object({ t: z.literal('load'), name: z.string().regex(/^[\w-]{1,40}$/) }),
  z.object({ t: z.literal('newgame'), seed: z.number().int().optional() }),
  z.object({ t: z.literal('share'), enable: z.boolean().optional() }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

export interface ShareInfo {
  lan: boolean; // reachable from other devices
  host: string;
  port: number;
  links: { label: string; url: string; kind: 'web' | 'terminal' }[];
}

export interface PlanProposal {
  id: string;
  summary: string;
  cmds: Command[];
}

export type ServerMsg =
  | { t: 'welcome'; role: Role; world: StaticWorld; link: string; aiOpponent?: string }
  | { t: 'snap'; snap: Snapshot }
  | { t: 'events'; events: GameEvent[] }
  | { t: 'result'; id?: string; ok: boolean; msg: string }
  | { t: 'focus'; focus: Focus; from: string }
  | { t: 'plan'; plan: PlanProposal; askId?: string } // advisor proposal waiting for confirmation
  | { t: 'planPreview'; plan: PlanProposal | null }
  | { t: 'share'; info: ShareInfo }
  | { t: 'error'; msg: string }
  | { t: 'pong' };

/** coldlaunch://host:port/s/<token>?role=USA  ⇄  ws://host:port/?token=... */
export function makeLink(host: string, port: number, token: string, role?: Role): string {
  return `coldlaunch://${host}:${port}/s/${token}${role ? `?role=${role}` : ''}`;
}

export function parseLink(link: string): { host: string; port: number; token: string; role?: Role } | null {
  const m = link.trim().match(/^(?:coldlaunch|http|ws):\/\/([^:/]+):(\d+)\/(?:s\/|\?token=)([\w-]+)(?:[?&]role=(USA|USSR|SPECTATOR))?/);
  if (!m) return null;
  return { host: m[1], port: +m[2], token: m[3], role: m[4] as Role | undefined };
}
