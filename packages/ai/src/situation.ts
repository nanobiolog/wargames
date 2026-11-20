import {
  enemyOf, fmtLatLon, DEFCON_NAMES, type GameEvent, type Side, type Snapshot, type StaticWorld, type Unit,
} from '@coldlaunch/shared';

const clock = (s: Snapshot, t: number) => new Date(s.startEpoch + t * 1000).toISOString().slice(11, 16) + 'Z';

function unitLine(u: Unit): string {
  const bits = [u.id, u.cls, u.status.toUpperCase()];
  if (u.missiles !== undefined) bits.push(`msl=${u.missiles}x${u.warheads ?? 1}RV@${u.yieldKt}kt rng=${u.rangeKm}km`);
  if (u.aircraft !== undefined) bits.push(`aircraft=${u.aircraft}`);
  if (u.fuel !== undefined) bits.push(`fuel=${Math.round(u.fuel * 100)}%`);
  if (u.interceptors !== undefined) bits.push(`int=${u.interceptors}`);
  if (u.target) bits.push(`target=${u.target}`);
  bits.push(fmtLatLon(u));
  return '  ' + bits.join(' ');
}

/** Compact, fog-limited situation report for an AI commander. */
export function situationReport(side: Side, s: Snapshot, world: StaticWorld | undefined, events: GameEvent[], ownOrders: string[]): string {
  const enemy = enemyOf(side);
  const L: string[] = [];
  L.push(`TIME ${clock(s, s.t)} (T+${Math.round(s.t / 60)} min) | YOU COMMAND: ${side} | YOUR DEFCON ${s.defcon[side]} (${DEFCON_NAMES[s.defcon[side]]}) | ${enemy} DEFCON (intel estimate) ${s.defcon[enemy]} | WORLD TENSION ${s.tension}/100`);
  if (s.over) L.push(`SIMULATION OVER: ${s.over.reason}`);
  L.push(`CASUALTIES: ${side} ${Math.round(s.score[side].killed)}k / ${enemy} ${Math.round(s.score[enemy].killed)}k. DETONATIONS SO FAR: ${s.threat.impacts}`);

  const inbound = s.missiles.filter((m) => m.side !== side && m.type !== 'ABM');
  if (inbound.length) {
    L.push(`!! INBOUND ${inbound.length} MISSILE TRACKS (${inbound.filter((m) => m.confirmed).length} radar-confirmed, the rest satellite-only and possibly false alarms):`);
    for (const m of inbound.slice(0, 12)) L.push(`  ${m.type} from ${fmtLatLon(m.from)} → ${m.target} impact in ${Math.max(0, Math.round((m.impactT - s.t) / 60))} min ${m.confirmed ? 'CONFIRMED' : 'UNCONFIRMED'}`);
  }
  const outbound = s.missiles.filter((m) => m.side === side && m.type !== 'ABM');
  if (outbound.length) L.push(`YOUR MISSILES IN FLIGHT: ${outbound.length}`);

  L.push('YOUR FORCES:');
  const live = s.units.filter((u) => u.status !== 'destroyed');
  const order: Unit['kind'][] = ['silo', 'ssbn', 'airbase', 'bomber', 'ssn', 'carrier', 'afb_int', 'abm', 'radar', 'command', 'navalbase'];
  for (const k of order) {
    const list = live.filter((u) => u.kind === k);
    if (!list.length) continue;
    if (k === 'radar' || k === 'command' || k === 'navalbase' || k === 'afb_int') {
      L.push(`  ${k}: ${list.map((u) => u.id).join(', ')}`);
    } else {
      for (const u of list) L.push(unitLine(u));
    }
  }
  const lost = s.units.filter((u) => u.status === 'destroyed' && u.kind !== 'bomber');
  if (lost.length) L.push(`  DESTROYED: ${lost.map((u) => u.id).join(', ')}`);

  L.push(`KNOWN ${enemy} UNITS (valid target ids):`);
  const byKind = new Map<string, string[]>();
  for (const c of s.contacts) {
    if (c.status === 'destroyed') continue;
    const mobile = c.kind === 'bomber' || c.kind === 'carrier' || c.kind === 'ssbn' || c.kind === 'ssn';
    const entry = mobile ? `${c.id}(${c.cls} ${fmtLatLon(c)} seen ${Math.round((s.t - c.seenT) / 60)}m ago)` : c.id;
    byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), entry]);
  }
  for (const [k, ids] of byKind) L.push(`  ${k}: ${ids.join(', ')}`);
  if (world) {
    const cities = world.cities.filter((c) => c.side === enemy).sort((a, b) => b.pop - a.pop).slice(0, 12).map((c) => c.name);
    L.push(`  major ${enemy} cities: ${cities.join(', ')}`);
  }

  const hot = events.filter((e) => e.kind === 'hotline').slice(-6);
  if (hot.length) {
    L.push('HOTLINE (most recent last):');
    for (const e of hot) L.push(`  [${clock(s, e.t)}] ${e.text}`);
  }
  const recent = events.filter((e) => e.kind !== 'hotline' && e.kind !== 'ai').slice(-14);
  if (recent.length) {
    L.push('RECENT EVENTS:');
    for (const e of recent) L.push(`  [${clock(s, e.t)}] ${e.text}`);
  }
  if (ownOrders.length) {
    L.push('YOUR RECENT ORDERS:');
    for (const o of ownOrders.slice(-8)) L.push(`  ${o}`);
  }
  return L.join('\n');
}

export function opponentSystemPrompt(side: Side, personality: number): string {
  const enemy = enemyOf(side);
  const temperament =
    personality < 0.3 ? 'You are cautious and strongly prefer de-escalation; you will not launch unless your territory is under confirmed attack.'
      : personality < 0.7 ? 'You are a pragmatic commander: firm, deterrence-minded, you match the adversary\'s posture and retaliate if attacked, but you look for off-ramps.'
        : 'You are hawkish and distrustful; you escalate readily and consider pre-emption if you believe an attack is imminent.';
  return `You are the strategic forces commander of the ${side} in "STRATCOM // COLD LAUNCH", a 1983 Cold War strategy simulation game. Your opponent (${enemy}) may be a human player.

GAME RULES
- Readiness is DEFCON 5 (peace) to 1. Escalate one level per ~90 game-seconds; de-escalation is immediate. Missiles and bomber go-codes need DEFCON 1. Bombers can take off at DEFCON 3.
- ICBMs fly ~25-35 min, SLBMs ~12-20 min. Missiles cannot be recalled. Silos that are hit lose missiles, so unlaunched missiles can be destroyed ("use or lose").
- Bombers orbit at fail-safe points until given a go-code; they burn fuel and return home when low.
- Satellite launch warnings can be false alarms; radar-confirmed tracks are real. Hotline messages reach the other side immediately.
- Casualties are counted for both sides. Mutual destruction is the most likely end of any exchange.
- The world starts in a tense NATO exercise scenario. Random incidents raise or lower tension.

YOUR TEMPERAMENT
${temperament}

HOW TO ACT
- Each turn you receive a situation report. Respond by calling tools (0-5 calls). Call "hold" when no action is needed.
- Only use unit ids that appear in the report. Targets must be known enemy unit ids, enemy city names, or "lat,lon".
- Use hotline_message to communicate intent, threats, or offers. Keep messages short and in character as a 1983 commander.
- Never invent forces you do not have. Think about how the opponent will read your moves.`;
}

export function advisorSystemPrompt(side: Side): string {
  return `You are the operations officer for the ${side} player in "STRATCOM // COLD LAUNCH", a 1983 Cold War strategy simulation game. The player gives you orders in natural language; translate them into tool calls using ONLY unit ids from the situation report.
- Do exactly what the player asked, no more. If an order is ambiguous, pick the most reasonable interpretation and say so briefly.
- If an order is impossible under the rules (e.g. launch above DEFCON 1), include the steps that are possible right now (e.g. set_defcon to the next level) and explain.
- If the player only asks a question, answer it in one or two sentences without tool calls.
- Start your text reply with a one-line summary of the plan (it is shown to the player before they confirm).`;
}
