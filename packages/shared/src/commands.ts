// Single source of truth for every console command: syntax, help text, examples and the argument
// grammar used for type-ahead suggestions (terminal console and the in-display console).

export type ArgKind =
  | 'launcher' // own silo field / SSBN with missiles
  | 'airbase' // own bomber base with aircraft
  | 'bomber' // own airborne bomber group
  | 'mobile' // own ship / sub / bomber group
  | 'ownunit' // any own unit
  | 'unit' // any own unit or known contact
  | 'target' // enemy contact, enemy city, lat,lon
  | 'place' // sea area, city, unit, place name, lat,lon
  | 'defcon'
  | 'speed'
  | 'count'
  | 'layer'
  | 'preset'
  | 'kind'
  | 'name'
  | 'command'
  | 'text';

export interface ArgSlot {
  kind?: ArgKind;
  kw?: string; // literal keyword (e.g. "at", "to", "x")
  name?: string; // shown in the syntax hint
  optional?: boolean;
  multi?: boolean; // may contain spaces (consumes until next keyword)
}

export type Scope = 'game' | 'console' | 'tui' | 'gui';

export interface CommandSpec {
  verb: string;
  aliases?: string[];
  scope: Scope; // game = engine order; console = both consoles; tui / gui = only there
  group: 'ORDERS' | 'MAP' | 'INFO' | 'SESSION';
  syntax: string;
  summary: string;
  details: string;
  examples: string[];
  args: ArgSlot[];
}

const S = (kind: ArgKind, name: string, extra: Partial<ArgSlot> = {}): ArgSlot => ({ kind, name, ...extra });
const K = (kw: string, optional = false): ArgSlot => ({ kw, optional });

export const COMMANDS: CommandSpec[] = [
  // ------------------------------------------------------------------ orders
  {
    verb: 'defcon', scope: 'game', group: 'ORDERS', syntax: 'defcon <1-5>',
    summary: 'set your readiness level',
    details: 'DEFCON 5 is peacetime, 1 is maximum readiness. You can escalate only one level at a time, with about 90 game-seconds between steps. De-escalation is immediate. Bombers can take off at DEFCON 3 or lower; missile launches and bomber go-codes need DEFCON 1. The other side sees your change after an intelligence delay.',
    examples: ['defcon 4', 'defcon 5'], args: [S('defcon', '1-5')],
  },
  {
    verb: 'launch', aliases: ['fire'], scope: 'game', group: 'ORDERS', syntax: 'launch <silo|ssbn> at <target> [x N]',
    summary: 'fire ballistic missiles (irreversible)',
    details: 'Fires N missiles (default 1) from one of your ICBM fields or ballistic-missile submarines. The target can be a known enemy unit id, an enemy city, or coordinates like 55.7,37.6. Liftoff happens after a short authentication delay. Missiles cannot be recalled. Firing from a submarine reveals its position.',
    examples: ['launch icbm-minot at kozelsk x 3', 'launch ssbn-ohio at 55.7,37.6'],
    args: [S('launcher', 'silo|ssbn'), K('at'), S('target', 'target', { multi: true }), K('x', true), S('count', 'N', { optional: true })],
  },
  {
    verb: 'scramble', scope: 'game', group: 'ORDERS', syntax: 'scramble <base> [N] [to <place>]',
    summary: 'launch bombers to a holding orbit',
    details: 'Sends N bombers (default: all) from a bomber base to a fail-safe orbit. Without "to", they fly to a default point toward the enemy. They wait there for a go-code (strike) and return home when fuel runs low; a tanker extends their time once. Requires DEFCON 3.',
    examples: ['scramble afb-loring', 'scramble afb-minot 3 to baffin bay'],
    args: [S('airbase', 'base'), S('count', 'N', { optional: true }), K('to', true), S('place', 'place', { multi: true, optional: true })],
  },
  {
    verb: 'strike', aliases: ['go'], scope: 'game', group: 'ORDERS', syntax: 'strike <bomber-group> at <target>',
    summary: 'send the go-code to an airborne bomber group',
    details: 'The group flies to the target and releases all its weapons, then heads home if it has the fuel. Interceptors and carrier air defence can shoot bombers down on the way. Requires DEFCON 1.',
    examples: ['strike bmr-loring-1 at murmansk'], args: [S('bomber', 'group'), K('at'), S('target', 'target', { multi: true })],
  },
  {
    verb: 'recall', scope: 'game', group: 'ORDERS', syntax: 'recall <bomber-group>',
    summary: 'bring a bomber group home', details: 'Cancels an orbit or a strike that has not arrived yet; the aircraft return to base and can be scrambled again.',
    examples: ['recall bmr-loring-1'], args: [S('bomber', 'group')],
  },
  {
    verb: 'move', scope: 'game', group: 'ORDERS', syntax: 'move <unit> to <place>',
    summary: 'move a fleet, submarine or bomber orbit',
    details: 'Carrier and surface groups and submarines route around land automatically and report when they are on station. For an airborne bomber group this sets a new orbit point. Fixed installations cannot move.',
    examples: ['move cvbg-midway to sea of japan', 'move ssn-memphis to barents sea'], args: [S('mobile', 'unit'), K('to'), S('place', 'place', { multi: true })],
  },
  {
    verb: 'hotline', aliases: ['msg'], scope: 'game', group: 'ORDERS', syntax: 'hotline <message>',
    summary: 'message the other side directly',
    details: 'Sends text over the direct communications link. AI opponents read and answer it. Conciliatory messages lower world tension a little (once every 5 game-minutes).',
    examples: ['hotline our bombers are on a training exercise. we propose a mutual stand-down.'], args: [S('text', 'message', { multi: true })],
  },
  {
    verb: 'speed', scope: 'game', group: 'SESSION', syntax: 'speed <x>',
    summary: 'set time compression', details: 'Game seconds per real second (0.5-120). Keys [ and ] step through 1, 2, 5, 10, 20, 30, 60.',
    examples: ['speed 30'], args: [S('speed', 'x')],
  },
  { verb: 'pause', scope: 'game', group: 'SESSION', syntax: 'pause', summary: 'pause the clock (space bar toggles)', details: 'Everyone in the session sees the pause.', examples: ['pause'], args: [] },
  { verb: 'resume', scope: 'game', group: 'SESSION', syntax: 'resume', summary: 'resume the clock', details: '', examples: ['resume'], args: [] },
  {
    verb: 'ask', scope: 'console', group: 'ORDERS', syntax: 'ask <anything>',
    summary: 'natural-language orders via your AI advisor',
    details: 'Your advisor model turns plain language into orders and shows the plan for you to confirm (y/N). The wall display previews it as dashed yellow lines. Any line that is not a command is sent to the advisor automatically.',
    examples: ['ask put the bombers on alert and move the midway group north', 'what is the closest enemy submarine?'], args: [S('text', 'request', { multi: true })],
  },
  // ------------------------------------------------------------------ map
  {
    verb: 'zoom', scope: 'console', group: 'MAP', syntax: 'zoom <place|in|out|N>',
    summary: 'zoom the map (wheel and +/- work too)', details: 'Zooms to a place, unit, city, sea area or lat,lon, or by a factor (in/out), or to an absolute zoom level N. The other screens follow when sync is on.',
    examples: ['zoom grand forks', 'zoom in', 'zoom 40'], args: [S('place', 'place|in|out|N', { multi: true })],
  },
  { verb: 'goto', aliases: ['center'], scope: 'console', group: 'MAP', syntax: 'goto <place>', summary: 'center the map without changing zoom', details: '', examples: ['goto barents sea'], args: [S('place', 'place', { multi: true })] },
  { verb: 'world', scope: 'console', group: 'MAP', syntax: 'world', summary: 'reset to the whole world', details: '', examples: ['world'], args: [] },
  { verb: 'polar', scope: 'tui', group: 'MAP', syntax: 'polar', summary: 'north-polar projection (missile corridors)', details: '', examples: ['polar'], args: [] },
  { verb: 'flat', scope: 'tui', group: 'MAP', syntax: 'flat', summary: 'back to the flat projection', details: '', examples: ['flat'], args: [] },
  {
    verb: 'layer', aliases: ['layers'], scope: 'console', group: 'MAP', syntax: 'layer [name] [on|off]',
    summary: 'list or toggle map layers', details: 'Without a name, lists all layers. The display also has service-branch layers: navy, air, rocket and ground.',
    examples: ['layer', 'layer roads off', 'layer navy off'], args: [S('layer', 'name', { optional: true }), S('text', 'on|off', { optional: true })],
  },
  {
    verb: 'view', aliases: ['preset'], scope: 'gui', group: 'MAP', syntax: 'view <preset>',
    summary: 'change what this display tab shows', details: 'Presets: wall, world, conus, europe, eurasia, alaska, pacific, atlantic, polar, missiles, stats, log.',
    examples: ['view missiles', 'view conus'], args: [S('preset', 'preset')],
  },
  {
    verb: 'select', scope: 'console', group: 'MAP', syntax: 'select <unit|missile>', summary: 'select a unit or missile track and show its details',
    details: 'Shows type, status, speed, distance remaining, ETA (game clock and real time), fuel and payload; for missiles: phase, altitude, speed, distance to impact and time to impact. Clicking a unit or a missile head on any map does the same.', examples: ['select cvbg-americas', 'select m12'], args: [S('unit', 'unit|missile')],
  },
  { verb: 'track', scope: 'tui', group: 'MAP', syntax: 'track <unit>', summary: 'select a unit and keep the map centered on it', details: 'Esc stops tracking.', examples: ['track ssbn-ohio'], args: [S('unit', 'unit')] },
  { verb: 'focus', scope: 'tui', group: 'MAP', syntax: 'focus', summary: 'fly the wall displays to the terminal view', details: '', examples: ['focus'], args: [] },
  // ------------------------------------------------------------------ info
  {
    verb: 'list', scope: 'console', group: 'INFO', syntax: 'list [kind|enemy]', summary: 'list your units or known enemy contacts',
    details: 'Kinds: silo, ssbn, ssn, carrier, airbase, bomber, afb_int, radar, abm, command, navalbase.', examples: ['list silo', 'list enemy'], args: [S('kind', 'kind', { optional: true })],
  },
  { verb: 'info', scope: 'console', group: 'INFO', syntax: 'info [unit|missile]', summary: 'details of the selected (or named) unit or missile', details: '', examples: ['info', 'info bmr-loring-1'], args: [S('unit', 'unit', { optional: true })] },
  { verb: 'help', aliases: ['?'], scope: 'console', group: 'INFO', syntax: 'help [command]', summary: 'list commands, or explain one in detail', details: '', examples: ['help', 'help launch'], args: [S('command', 'command', { optional: true })] },
  { verb: 'keys', aliases: ['setup'], scope: 'tui', group: 'INFO', syntax: 'keys', summary: 'how to add Gemini / Claude API keys', details: '', examples: ['keys'], args: [] },
  // ------------------------------------------------------------------ session
  {
    verb: 'share', aliases: ['qr'], scope: 'console', group: 'SESSION', syntax: 'share',
    summary: 'share this game with phones and other PCs (QR codes)',
    details: 'Opens the game to your local network (no restart needed) and shows QR codes. Scan one with a phone to get the map plus a touch console, or open the links on another PC. Only the machine running the game can switch sharing on. Anyone with the link can join, so use it on trusted networks.',
    examples: ['share'], args: [],
  },
  { verb: 'link', scope: 'console', group: 'SESSION', syntax: 'link', summary: 'list the join links as text (no QR)', details: '', examples: ['link'], args: [] },
  { verb: 'gui', scope: 'tui', group: 'SESSION', syntax: 'gui', summary: 'open the wall display (your saved display mode)', details: '', examples: ['gui'], args: [] },
  { verb: 'web', aliases: ['browser'], scope: 'console', group: 'SESSION', syntax: 'web [preset]', summary: 'open a display in a new browser tab/window', details: '', examples: ['web conus', 'web missiles'], args: [S('preset', 'preset', { optional: true })] },
  { verb: 'save', scope: 'console', group: 'SESSION', syntax: 'save <name>', summary: 'save the game', details: 'Saved to ~/.coldlaunch/saves on the machine running the game.', examples: ['save crisis1'], args: [S('name', 'name')] },
  { verb: 'load', scope: 'console', group: 'SESSION', syntax: 'load <name>', summary: 'load a saved game', details: '', examples: ['load crisis1'], args: [S('name', 'name')] },
  { verb: 'new', scope: 'console', group: 'SESSION', syntax: 'new', summary: 'restart the scenario', details: '', examples: ['new'], args: [] },
  { verb: 'clear', scope: 'console', group: 'SESSION', syntax: 'clear', summary: 'clear the console log', details: '', examples: ['clear'], args: [] },
  { verb: 'mouse', scope: 'tui', group: 'SESSION', syntax: 'mouse on|off', summary: 'mouse capture (off = terminal text selection)', details: '', examples: ['mouse off'], args: [S('text', 'on|off')] },
  { verb: 'bell', scope: 'tui', group: 'SESSION', syntax: 'bell on|off', summary: 'beep on launch detection', details: '', examples: ['bell off'], args: [S('text', 'on|off')] },
  { verb: 'sync', scope: 'console', group: 'SESSION', syntax: 'sync on|off', summary: 'share selection and zoom with the other screens', details: '', examples: ['sync off'], args: [S('text', 'on|off')] },
  { verb: 'quit', aliases: ['exit'], scope: 'tui', group: 'SESSION', syntax: 'quit', summary: 'leave the game (stops the server if it runs here)', details: '', examples: ['quit'], args: [] },
];

export function commandsFor(where: 'tui' | 'gui'): CommandSpec[] {
  return COMMANDS.filter((c) => c.scope === 'game' || c.scope === 'console' || c.scope === where);
}

export function findCommand(verb: string, where: 'tui' | 'gui'): CommandSpec | undefined {
  const v = verb.toLowerCase();
  return commandsFor(where).find((c) => c.verb === v || c.aliases?.includes(v));
}

/** Plain-text help lines (used by both consoles). */
export function helpLines(where: 'tui' | 'gui', verb?: string): string[] {
  if (verb) {
    const c = findCommand(verb, where);
    if (!c) return [`no command "${verb}" — type help for the list`];
    const out = [`${c.syntax}  —  ${c.summary}`];
    if (c.details) out.push(c.details);
    if (c.aliases?.length) out.push(`aliases: ${c.aliases.join(', ')}`);
    out.push(...c.examples.map((e) => `  e.g. ${e}`));
    return out;
  }
  const out: string[] = [];
  for (const g of ['ORDERS', 'MAP', 'INFO', 'SESSION'] as const) {
    out.push(`── ${g} ──`);
    for (const c of commandsFor(where).filter((x) => x.group === g)) out.push(`${c.syntax.padEnd(40)} ${c.summary}`);
  }
  out.push('Type "help <command>" for details and examples. Anything that is not a command goes to your AI advisor.');
  return out;
}
