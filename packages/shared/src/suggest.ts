// Type-ahead engine shared by the terminal and the in-display console.
import { COMMANDS, commandsFor, findCommand, type ArgKind, type ArgSlot } from './commands.ts';
import type { Role, Snapshot, StaticWorld, Unit, Contact } from './types.ts';

export interface SuggestCtx {
  snap?: Snapshot;
  world?: StaticWorld;
  role: Role;
  where: 'tui' | 'gui';
  places?: string[]; // extra gazetteer names (lower-case), optional
  layers?: string[];
  presets?: string[];
}

export interface Suggestion {
  /** text to append after the input to accept the top suggestion ('' = none) */
  ghost: string;
  /** candidate values for the word being typed (display form) */
  candidates: string[];
  /** syntax + summary of the command being typed, or next-order tips on an empty line */
  hint: string;
  /** index of the slot being typed, for highlighting */
  slot?: string;
}

const KINDS = ['silo', 'ssbn', 'ssn', 'carrier', 'airbase', 'bomber', 'afb_int', 'radar', 'abm', 'command', 'navalbase', 'enemy'];
const TARGET_ORDER: Record<string, number> = { silo: 0, command: 1, airbase: 2, abm: 3, navalbase: 4, radar: 5, afb_int: 6, carrier: 7, ssbn: 8, ssn: 9, bomber: 10 };

function own(ctx: SuggestCtx): Unit[] {
  return (ctx.snap?.units ?? []).filter((u) => u.status !== 'destroyed');
}
function enemy(ctx: SuggestCtx): Contact[] {
  return (ctx.snap?.contacts ?? []).filter((c) => c.status !== 'destroyed');
}
function enemyCities(ctx: SuggestCtx): string[] {
  const mySide = ctx.role === 'SPECTATOR' ? null : ctx.role;
  return (ctx.world?.cities ?? [])
    .filter((c) => c.side !== 'OTHER' && c.side !== mySide)
    .sort((a, b) => b.pop - a.pop)
    .map((c) => c.name.toLowerCase());
}

function candidatesFor(kind: ArgKind | undefined, ctx: SuggestCtx): string[] {
  switch (kind) {
    case 'launcher':
      return own(ctx).filter((u) => (u.kind === 'silo' || u.kind === 'ssbn') && (u.missiles ?? 0) > 0)
        .sort((a, b) => (a.kind === b.kind ? (b.missiles ?? 0) - (a.missiles ?? 0) : a.kind === 'silo' ? -1 : 1)).map((u) => u.id);
    case 'airbase':
      return own(ctx).filter((u) => u.kind === 'airbase' && (u.aircraft ?? 0) > 0).map((u) => u.id);
    case 'bomber':
      return own(ctx).filter((u) => u.kind === 'bomber').map((u) => u.id);
    case 'mobile':
      return own(ctx).filter((u) => u.kind === 'carrier' || u.kind === 'ssbn' || u.kind === 'ssn' || u.kind === 'bomber').map((u) => u.id);
    case 'ownunit':
      return own(ctx).map((u) => u.id);
    case 'unit':
      return [...own(ctx).map((u) => u.id), ...enemy(ctx).map((c) => c.id), ...(ctx.snap?.missiles ?? []).filter((m) => m.type !== 'ABM').map((m) => m.id)];
    case 'target':
      return [
        ...enemy(ctx).filter((c) => c.identified).sort((a, b) => (TARGET_ORDER[a.kind] ?? 20) - (TARGET_ORDER[b.kind] ?? 20)).map((c) => c.id),
        ...enemyCities(ctx),
        ...enemy(ctx).filter((c) => !c.identified).map((c) => c.id),
      ];
    case 'place':
      return [
        ...(ctx.world?.seaAreas.map((a) => a.name.toLowerCase()) ?? []),
        ...(ctx.world?.cities.map((c) => c.name.toLowerCase()) ?? []),
        ...own(ctx).map((u) => u.id),
        ...enemy(ctx).map((c) => c.id),
        ...(ctx.places ?? []),
      ];
    case 'defcon': {
      const d = ctx.snap && ctx.role !== 'SPECTATOR' ? ctx.snap.defcon[ctx.role] : 5;
      return [d - 1, d + 1, 5, 4, 3, 2, 1].filter((x, i, a) => x >= 1 && x <= 5 && a.indexOf(x) === i).map(String);
    }
    case 'speed':
      return ['1', '2', '5', '10', '20', '30', '60'];
    case 'layer':
      return ctx.layers ?? [];
    case 'preset':
      return ctx.presets ?? [];
    case 'kind':
      return KINDS;
    case 'command':
      return commandsFor(ctx.where).map((c) => c.verb);
    default:
      return [];
  }
}

function syntaxOf(verb: string, where: 'tui' | 'gui') {
  const c = findCommand(verb, where);
  return c ? `${c.syntax}  —  ${c.summary}` : '';
}

/** Rank: prefix matches first (in source order), then substring matches. */
function match(cands: string[], partial: string): string[] {
  const p = partial.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cands) if (c.startsWith(p) && !seen.has(c)) { seen.add(c); out.push(c); }
  if (p.length >= 2) for (const c of cands) if (!c.startsWith(p) && c.includes(p) && !seen.has(c)) { seen.add(c); out.push(c); }
  return out;
}

export function suggest(input: string, ctx: SuggestCtx): Suggestion {
  if (!input.trim()) {
    const next = nextOrders(ctx);
    return { ghost: next[0] ?? '', candidates: next, hint: next.length ? `suggested: ${next.join('  ·  ')}   (→ or Tab accepts)` : '' };
  }
  const lead = input.match(/^\s*/)![0];
  const body = input.slice(lead.length);
  const sp = body.indexOf(' ');
  const cmds = commandsFor(ctx.where);
  if (sp < 0) {
    // completing the verb
    const verbs = cmds.flatMap((c) => [c.verb, ...(c.aliases ?? [])]).filter((v) => v !== '?');
    const m = match(verbs, body);
    const top = m.find((v) => v.startsWith(body.toLowerCase()));
    const spec = findCommand(top ?? body, ctx.where);
    return {
      ghost: top && top !== body.toLowerCase() ? top.slice(body.length) + ' ' : spec && spec.args.length ? ' ' : '',
      candidates: m.slice(0, 12),
      hint: spec ? `${spec.syntax}  —  ${spec.summary}` : m.length ? '' : 'not a command — Enter sends it to your AI advisor',
    };
  }
  const verb = body.slice(0, sp).toLowerCase();
  const spec = findCommand(verb, ctx.where);
  if (!spec) return { ghost: '', candidates: [], hint: 'not a command — Enter sends it to your AI advisor' };
  let rest = body.slice(sp + 1);
  const slots = spec.args;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const nextKw = slots.slice(i + 1).find((x) => x.kw)?.kw;
    if (s.kw) {
      if (rest.toLowerCase().startsWith(s.kw + ' ')) { rest = rest.slice(s.kw.length + 1); continue; }
      if (!rest.includes(' ') && s.kw.startsWith(rest.toLowerCase())) {
        return { ghost: s.kw.slice(rest.length) + ' ', candidates: [s.kw], hint: hintFor(spec.syntax, spec.summary, s) };
      }
      if (s.optional) continue;
      return { ghost: '', candidates: [], hint: `${spec.syntax}  —  expected "${s.kw}"` };
    }
    if (s.multi) {
      const kwAt = nextKw ? rest.toLowerCase().indexOf(` ${nextKw} `) : -1;
      if (kwAt >= 0) { rest = rest.slice(kwAt + 1); continue; }
      // typing this (possibly multi-word) slot — also offer the next keyword once a value is complete
      const cands = candidatesFor(s.kind, ctx);
      const m = match(cands, rest);
      const exact = cands.includes(rest.trim().toLowerCase());
      if (exact && nextKw && rest.endsWith(' ')) return { ghost: nextKw + ' ', candidates: [nextKw], hint: hintFor(spec.syntax, spec.summary, s) };
      const top = m.find((c) => c.startsWith(rest.toLowerCase()));
      return { ghost: top ? top.slice(rest.length) : '', candidates: m.slice(0, 12), hint: hintFor(spec.syntax, spec.summary, s) };
    }
    // single-token slot
    const tokEnd = rest.indexOf(' ');
    if (tokEnd >= 0) { rest = rest.slice(tokEnd + 1); continue; }
    const cands = candidatesFor(s.kind, ctx);
    const m = match(cands, rest);
    const top = m.find((c) => c.startsWith(rest.toLowerCase()));
    const nextSlot = slots[i + 1];
    let ghost = top ? top.slice(rest.length) : '';
    if (top && top === rest.toLowerCase() && nextSlot?.kw && !nextSlot.optional) ghost = ` ${nextSlot.kw} `;
    else if (top && top !== rest.toLowerCase() && nextSlot && !nextSlot.optional) ghost += ' ';
    return { ghost, candidates: m.slice(0, 12), hint: hintFor(spec.syntax, spec.summary, s) };
  }
  return { ghost: '', candidates: [], hint: `${spec.syntax}  —  ${spec.summary}   ⏎ to send` };
}

function hintFor(syntax: string, summary: string, s: ArgSlot) {
  return `${syntax}  —  ${summary}${s.name ? `   [now: ${s.name}]` : ''}`;
}

/** Context-aware ideas for the next order, shown on an empty command line. */
export function nextOrders(ctx: SuggestCtx): string[] {
  const s = ctx.snap;
  if (!s) return ['help'];
  if (s.over) return ['new', 'help'];
  if (ctx.role === 'SPECTATOR') return ['world', 'zoom europe', 'list enemy'];
  const out: string[] = [];
  const d = s.defcon[ctx.role];
  const inbound = s.missiles.filter((m) => m.side !== ctx.role && m.type !== 'ABM');
  if (inbound.length) {
    const t = inbound.sort((a, b) => a.impactT - b.impactT)[0];
    out.push(`zoom ${t.target.toLowerCase()}`);
    if (d > 1) out.push(`defcon ${d - 1}`);
    out.push('list enemy');
  }
  const unk = s.contacts.find((c) => !c.identified && c.status !== 'destroyed');
  if (unk) out.push(`select ${unk.id}`);
  if (!inbound.length && s.tension >= 45) out.push('hotline we have no hostile intent. we propose a mutual stand-down.');
  if (!inbound.length && s.tension < 30 && d < 5) out.push(`defcon ${d + 1}`);
  const orbit = s.units.find((u) => u.kind === 'bomber' && u.status === 'orbit');
  if (orbit && d > 1) out.push(`recall ${orbit.id}`);
  if (d <= 3 && !s.units.some((u) => u.kind === 'bomber')) {
    const base = s.units.find((u) => u.kind === 'airbase' && (u.aircraft ?? 0) > 0 && u.status !== 'destroyed');
    if (base) out.push(`scramble ${base.id}`);
  }
  if (out.length < 3) out.push('list silo', 'zoom moscow', 'help');
  return [...new Set(out)].slice(0, 4);
}


