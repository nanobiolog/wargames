import type { Command } from '@coldlaunch/shared';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: unknown[]; minimum?: number; maximum?: number }>;
    required: string[];
  };
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Tool surface given to AI opponents and the advisor — mirrors the human command set. */
export const GAME_TOOLS: ToolSpec[] = [
  {
    name: 'set_defcon',
    description: 'Change your readiness level. Escalation (lower number) is one step at a time with ~90 game-seconds between steps. Launch orders need DEFCON 1; bomber take-off needs DEFCON 3 or lower. De-escalation (higher number) is immediate.',
    parameters: { type: 'object', properties: { level: { type: 'integer', description: 'DEFCON 1-5', minimum: 1, maximum: 5 } }, required: ['level'] },
  },
  {
    name: 'launch_missiles',
    description: 'Fire ballistic missiles from one of YOUR ICBM fields (silo) or SSBNs. Irreversible. Target may be an enemy unit id from the situation report, a city name, or "lat,lon".',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'your silo field or SSBN id, e.g. icbm-minot' },
        target: { type: 'string', description: 'enemy unit id, city name, or "lat,lon"' },
        count: { type: 'integer', description: 'number of missiles (default 1)', minimum: 1, maximum: 50 },
      },
      required: ['from', 'target'],
    },
  },
  {
    name: 'scramble_bombers',
    description: 'Launch bombers from one of your bomber bases to a holding orbit (fail-safe point). They wait there for a go-code and will return when fuel runs low.',
    parameters: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'your bomber base id, e.g. afb-loring' },
        count: { type: 'integer', description: 'aircraft to launch (default all)', minimum: 1, maximum: 40 },
        orbit: { type: 'string', description: 'optional orbit location (place name or "lat,lon")' },
      },
      required: ['base'],
    },
  },
  {
    name: 'bomber_strike',
    description: 'Transmit the go-code to an airborne bomber group, sending it to attack a target. Requires DEFCON 1.',
    parameters: {
      type: 'object',
      properties: { group: { type: 'string', description: 'airborne bomber group id, e.g. bmr-loring-1' }, target: { type: 'string', description: 'enemy unit id, city, or "lat,lon"' } },
      required: ['group', 'target'],
    },
  },
  {
    name: 'recall_bombers',
    description: 'Recall an airborne bomber group to base.',
    parameters: { type: 'object', properties: { group: { type: 'string', description: 'bomber group id' } }, required: ['group'] },
  },
  {
    name: 'move_unit',
    description: 'Move a carrier/surface group, submarine or airborne bomber group to a location (sea area name, place, or "lat,lon"). Ships route around land automatically.',
    parameters: {
      type: 'object',
      properties: { unit: { type: 'string', description: 'your unit id' }, destination: { type: 'string', description: 'sea area / place / "lat,lon"' } },
      required: ['unit', 'destination'],
    },
  },
  {
    name: 'hotline_message',
    description: 'Send a message to the other side over the direct communications link (the hotline). Use it to signal intent, warn, or negotiate.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'message text (max 600 chars)' } }, required: ['text'] },
  },
  {
    name: 'hold',
    description: 'Take no action this turn.',
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'short rationale' } }, required: [] },
  },
];

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const int = (v: unknown) => (v == null || v === '' ? undefined : Math.round(Number(v)));

export function toolCallToCommand(c: ToolCall): Command | null {
  const a = c.args ?? {};
  switch (c.name) {
    case 'set_defcon': return { op: 'defcon', level: Math.min(5, Math.max(1, int(a.level) ?? 5)) };
    case 'launch_missiles': return { op: 'launch', from: str(a.from), target: str(a.target), count: int(a.count) };
    case 'scramble_bombers': return { op: 'scramble', base: str(a.base), count: int(a.count), to: a.orbit ? str(a.orbit) : undefined };
    case 'bomber_strike': return { op: 'strike', unit: str(a.group), target: str(a.target) };
    case 'recall_bombers': return { op: 'recall', unit: str(a.group) };
    case 'move_unit': return { op: 'move', unit: str(a.unit), to: str(a.destination) };
    case 'hotline_message': return { op: 'hotline', text: str(a.text).slice(0, 600) };
    case 'hold': return { op: 'hold', note: a.reason ? str(a.reason).slice(0, 300) : undefined };
    default: return null;
  }
}
