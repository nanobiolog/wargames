import { z } from 'zod';
import type { GameEvent, Role, Side, Snapshot, StaticWorld } from './types.ts';

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
  /** to: one faction id; omitted = every other faction */
  z.object({ op: z.literal('hotline'), text: z.string().min(1).max(600), to: z.string().max(40).optional() }),
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
    /** faction id ('USA', 'USSR', 'CHN', …) or 'SPECTATOR' */
    role: z.string().regex(/^[A-Z]{2,12}$/).optional(),
    client: z.enum(['tui', 'gui', 'mcp', 'ai', 'other']),
    /** display name / callsign shown to other players (online matches) */
    name: z.string().max(40).optional(),
    /** stable per-device player id (random, kept in the browser); lets one player use several tabs/screens */
    player: z.string().regex(/^[\w-]{6,40}$/).optional(),
    /** friend tag (5 chars) for invites */
    tag: z.string().regex(/^[2-9A-Z]{5}$/).optional(),
    /** 'ai': this client holds the player's own AI key and can run AI calls for its side */
    caps: z.array(z.enum(['ai'])).max(4).optional(),
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
  /** answer to an aiJob: the LLM result from a browser that holds the player's key */
  z.object({
    t: z.literal('aiResult'), id: z.string().max(40),
    calls: z.array(z.object({ name: z.string().max(40), args: z.record(z.string(), z.unknown()) })).max(16).optional(),
    text: z.string().max(4000).optional(),
    inTok: z.number().int().min(0).optional(),
    outTok: z.number().int().min(0).optional(),
    error: z.string().max(400).optional(),
  }),
  z.object({ t: z.literal('chat'), text: z.string().min(1).max(300) }),
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

/** One connected client, as shown in the lobby / roster. */
export interface RosterEntry {
  name: string;
  role: Role;
  kind: string;
  ai: boolean; // can run AI calls with its own key
  you?: boolean;
}

export interface MatchInfo {
  code: string;
  scenario: string;
  opponent: string; // 'human' | 'rules' | 'byok:claude-haiku-5-5' ...
  created: number;
  host?: string; // callsign of the creator
}

/** Work for a browser that holds the player's own AI key (online matches). */
export interface AiJob {
  id: string;
  purpose: 'advisor' | 'opponent';
  side: Side;
  /** provider:model the player chose, e.g. claude:claude-haiku-5-5 */
  model: string;
  system: string;
  user: string;
  tools: unknown[];
}

export type ServerMsg =
  | { t: 'welcome'; role: Role; world: StaticWorld; link: string; aiOpponent?: string; match?: MatchInfo; you?: string }
  | { t: 'roster'; players: RosterEntry[] }
  | { t: 'aiJob'; job: AiJob }
  | { t: 'chat'; from: string; role: Role; text: string }
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

export interface ParsedLink {
  host: string;
  port: number;
  token: string;
  role?: Role;
  /** online match (Cloudflare): token is the 5-char match code, served over https/wss */
  online?: boolean;
  secure?: boolean;
}

/** https://host/m/K7M2Q?role=USA  (online match link) */
export function makeMatchLink(origin: string, code: string, role?: Role): string {
  return `${origin.replace(/\/$/, '')}/m/${code}${role ? `?role=${role}` : ''}`;
}

/** WebSocket URL for a parsed link. */
export function wsUrl(p: ParsedLink): string {
  if (p.online) {
    const defPort = p.secure ? 443 : 80;
    return `${p.secure ? 'wss' : 'ws'}://${p.host}${p.port === defPort ? '' : `:${p.port}`}/m/${p.token}/ws`;
  }
  return `ws://${p.host}:${p.port}/`;
}

export function parseLink(link: string): ParsedLink | null {
  const online = link.trim().match(/^(https?):\/\/([^:/?#]+)(?::(\d+))?\/m\/([2-9A-Za-z]{5})\/?(?:\?(?:.*&)?role=([A-Z]{2,12}))?/);
  if (online) {
    const secure = online[1] === 'https';
    return {
      host: online[2], port: online[3] ? +online[3] : secure ? 443 : 80, token: online[4].toUpperCase(),
      role: online[5] as Role | undefined, online: true, secure,
    };
  }
  const m = link.trim().match(/^(?:coldlaunch|http|ws):\/\/([^:/]+):(\d+)\/(?:s\/|\?token=)([\w-]+)(?:[?&]role=([A-Z]{2,12}))?/);
  if (!m) return null;
  return { host: m[1], port: +m[2], token: m[3], role: m[4] as Role | undefined };
}
