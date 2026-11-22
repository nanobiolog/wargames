import type { Command } from './protocol.ts';

export type ParseResult =
  | { kind: 'cmd'; cmd: Command }
  | { kind: 'error'; msg: string }
  | { kind: 'none' };

/** Help text for game commands (UI-local commands are documented by each client). */
export const GAME_COMMAND_HELP: [string, string][] = [
  ['defcon <1-5>', 'set readiness (launches need DEFCON 1, bombers DEFCON 3)'],
  ['launch <unit> at <target> [x N]', 'fire N missiles from a silo field or SSBN'],
  ['scramble <base> [N] [to <place>]', 'launch bombers to a fail-safe orbit'],
  ['strike <bomber> at <target>', 'send go-code to an airborne bomber group'],
  ['recall <bomber>', 'recall a bomber group to base'],
  ['move <unit> to <place>', 'move a fleet / submarine / bomber group'],
  ['hotline <message>', 'send a message to the other side'],
  ['speed <x>', 'set time compression'],
  ['pause | resume', 'pause or resume the clock'],
];

const strip = (s: string) => s.trim().replace(/^["']|["']$/g, '');

/**
 * Parse one terminal line into a game command.
 * Returns kind 'none' when the verb is not a game command (the client may treat it as
 * a local UI command or send it to the AI advisor).
 */
export function parseCommandLine(line: string): ParseResult {
  const raw = line.trim();
  if (!raw) return { kind: 'none' };
  const [verbRaw, ...rest] = raw.split(/\s+/);
  const verb = verbRaw.toLowerCase();
  const args = rest.join(' ');
  switch (verb) {
    case 'defcon': {
      const n = parseInt(args, 10);
      if (!(n >= 1 && n <= 5)) return { kind: 'error', msg: 'usage: defcon <1-5>' };
      return { kind: 'cmd', cmd: { op: 'defcon', level: n } };
    }
    case 'launch':
    case 'fire': {
      const m = args.match(/^(\S+)\s+(?:at|->|on)\s+(.+?)(?:\s+x\s*(\d+))?$/i);
      if (!m) return { kind: 'error', msg: 'usage: launch <unit> at <target> [x N]' };
      return { kind: 'cmd', cmd: { op: 'launch', from: m[1], target: strip(m[2]), count: m[3] ? +m[3] : undefined } };
    }
    case 'scramble': {
      const m = args.match(/^(\S+)(?:\s+(\d+))?(?:\s+to\s+(.+))?$/i);
      if (!m) return { kind: 'error', msg: 'usage: scramble <base> [N] [to <place>]' };
      return { kind: 'cmd', cmd: { op: 'scramble', base: m[1], count: m[2] ? +m[2] : undefined, to: m[3] ? strip(m[3]) : undefined } };
    }
    case 'strike':
    case 'go': {
      const m = args.match(/^(\S+)\s+(?:at|->|on)\s+(.+)$/i);
      if (!m) return { kind: 'error', msg: 'usage: strike <bomber> at <target>' };
      return { kind: 'cmd', cmd: { op: 'strike', unit: m[1], target: strip(m[2]) } };
    }
    case 'sortie':
    case 'recon':
    case 'cap':
    case 'airstrike': {
      // sortie <carrier|base> <recon|cap|strike> [to|at|over <place>] [x N]  ·  recon <carrier> [to] <place>  ·  cap <carrier> [over <place>]  ·  airstrike <carrier> at <target>
      let rest = args;
      let mission = verb === 'airstrike' ? 'strike' : verb === 'sortie' ? '' : verb;
      const cnt = rest.match(/\s+x\s*(\d+)\s*$/i);
      if (cnt) rest = rest.slice(0, cnt.index);
      const parts = rest.trim().split(/\s+/);
      const from = parts.shift();
      if (!mission) mission = (parts.shift() ?? '').toLowerCase();
      if (!from || !['recon', 'cap', 'strike'].includes(mission)) return { kind: 'error', msg: 'usage: sortie <carrier|fighter base> <recon|cap|strike> [to <place>] [x N]' };
      if (/^(to|at|over|on|->)$/i.test(parts[0] ?? '')) parts.shift();
      const to = parts.length ? strip(parts.join(' ')) : undefined;
      if (mission === 'strike' && !to) return { kind: 'error', msg: 'usage: airstrike <carrier|fighter base> at <target> [x N]' };
      if (mission === 'recon' && !to) return { kind: 'error', msg: 'usage: recon <carrier|fighter base> to <place> [x N]' };
      return { kind: 'cmd', cmd: { op: 'sortie', from, mission: mission as 'recon' | 'cap' | 'strike', to, count: cnt ? +cnt[1] : undefined } };
    }
    case 'cruise': {
      // cruise <ship|sub> at <target> [x N]
      const m = args.match(/^(\S+)\s+(?:at|->|on)\s+(.+?)(?:\s+x\s*(\d+))?$/i);
      if (!m) return { kind: 'error', msg: 'usage: cruise <surface group|attack sub> at <target> [x N]' };
      return { kind: 'cmd', cmd: { op: 'cruise', from: m[1], target: strip(m[2]), count: m[3] ? +m[3] : undefined } };
    }
    case 'drone':
    case 'swarm': {
      // drone <base> to <place>  ·  drone <base> attack <target> [x N]  ·  swarm <base> at <target> [x N]
      const m = args.match(/^(\S+)\s+(to|over|attack|at|->)\s+(.+?)(?:\s+x\s*(\d+))?$/i);
      if (!m) return { kind: 'error', msg: 'usage: drone <base> to <place>  ·  drone <base> attack <target> [x N]' };
      const attack = verb === 'swarm' || /^(attack|at)$/i.test(m[2]);
      return { kind: 'cmd', cmd: { op: 'sortie', from: m[1], mission: attack ? 'swarm' : 'drone', to: strip(m[3]), count: m[4] ? +m[4] : undefined } };
    }
    case 'resign':
    case 'concede':
      return { kind: 'cmd', cmd: { op: 'resign' } };
    case 'recall': {
      if (!args) return { kind: 'error', msg: 'usage: recall <bomber>' };
      return { kind: 'cmd', cmd: { op: 'recall', unit: args.split(/\s+/)[0] } };
    }
    case 'move': {
      const m = args.match(/^(\S+)\s+(?:to|->)\s+(.+)$/i);
      if (!m) return { kind: 'error', msg: 'usage: move <unit> to <place>' };
      return { kind: 'cmd', cmd: { op: 'move', unit: m[1], to: strip(m[2]) } };
    }
    case 'hotline':
    case 'msg': {
      if (!args) return { kind: 'error', msg: 'usage: hotline <message>' };
      // "hotline chn: text" sends to one faction; otherwise to every other faction
      const to = args.match(/^@?([A-Za-z]{2,12}):\s*(.+)$/);
      return { kind: 'cmd', cmd: to ? { op: 'hotline', to: to[1].toUpperCase(), text: to[2] } : { op: 'hotline', text: args } };
    }
    case 'speed': {
      const v = parseFloat(args.replace(/x$/i, ''));
      if (!(v >= 0.5 && v <= 120)) return { kind: 'error', msg: 'usage: speed <0.5-120>' };
      return { kind: 'cmd', cmd: { op: 'speed', value: v } };
    }
    case 'pause':
      return { kind: 'cmd', cmd: { op: 'pause', value: true } };
    case 'resume':
    case 'unpause':
      return { kind: 'cmd', cmd: { op: 'pause', value: false } };
    case 'hold':
      return { kind: 'cmd', cmd: { op: 'hold', note: args || undefined } };
    default:
      return { kind: 'none' };
  }
}

export function describeCommand(c: Command): string {
  switch (c.op) {
    case 'defcon': return `SET DEFCON ${c.level}`;
    case 'launch': return `LAUNCH ${c.count ?? 'ALL'} FROM ${c.from.toUpperCase()} AT ${c.target.toUpperCase()}`;
    case 'scramble': return `SCRAMBLE ${c.count ?? 'ALL'} FROM ${c.base.toUpperCase()}${c.to ? ` TO ${c.to.toUpperCase()}` : ''}`;
    case 'strike': return `GO-CODE ${c.unit.toUpperCase()} → ${c.target.toUpperCase()}`;
    case 'recall': return `RECALL ${c.unit.toUpperCase()}`;
    case 'sortie': return `${c.mission.toUpperCase()} SORTIE ${c.count ?? ''}${c.count ? ' ' : ''}FROM ${c.from.toUpperCase()}${c.to ? ` → ${c.to.toUpperCase()}` : ''}`;
    case 'move': return `MOVE ${c.unit.toUpperCase()} TO ${c.to.toUpperCase()}`;
    case 'speed': return `TIME x${c.value}`;
    case 'pause': return c.value === false ? 'RESUME' : 'PAUSE';
    case 'hotline': return `HOTLINE: "${c.text}"`;
    case 'hold': return `HOLD${c.note ? ` (${c.note})` : ''}`;
    case 'cruise': return `CRUISE MISSILES ${c.count ?? 4} FROM ${c.from.toUpperCase()} → ${c.target.toUpperCase()}`;
    case 'resign': return 'STAND DOWN AND LEAVE THE WAR';
  }
}
