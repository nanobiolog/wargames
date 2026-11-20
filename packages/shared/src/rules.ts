import type { UnitKind } from './types.ts';

/** DEFCON gates. Lower number = higher readiness. */
export const DEFCON_RULES = {
  scrambleMax: 3, // bombers can take off at DEFCON 3 or lower
  launchMax: 1, // missiles + bomber go-codes require DEFCON 1
  stepDownSec: 90, // game seconds between each escalation step
  launchDelaySec: 45, // order → liftoff
  launchDelayDegradedSec: 240, // when command post is destroyed
};

export const DEFCON_NAMES: Record<number, string> = {
  5: 'FADE OUT',
  4: 'DOUBLE TAKE',
  3: 'ROUND HOUSE',
  2: 'FAST PACE',
  1: 'COCKED PISTOL',
};

export const SPEED_STEPS = [1, 2, 5, 10, 20, 30, 60];
export const DEFAULT_SPEED = 10;

/** Ballistic flight times (game seconds) roughly scale with range. */
export function ballisticFlightSec(km: number, type: 'ICBM' | 'SLBM' | 'ABM'): number {
  if (type === 'ABM') return 60;
  // ~30 min for 10 000 km ICBM, SLBM depressed trajectories a bit faster
  const base = type === 'ICBM' ? 600 + km * 0.12 : 300 + km * 0.11;
  return Math.round(base);
}

export function apexKm(km: number, type: 'ICBM' | 'SLBM' | 'ABM'): number {
  if (type === 'ABM') return 120;
  return Math.min(1300, 200 + km * (type === 'ICBM' ? 0.11 : 0.08));
}

/** Lethal radius against soft targets (km) for a warhead of yield kt. */
export function softKillKm(yieldKt: number): number {
  return 2.2 * Math.cbrt(yieldKt); // ~5 psi radius-ish
}

/** Kill probability against a hardened point target. */
export function hardKillProb(yieldKt: number, cepKm: number, hardness = 1): number {
  const lr = (0.35 * Math.cbrt(yieldKt)) / hardness;
  return 1 - Math.pow(0.5, (lr / cepKm) ** 2);
}

export const KIND_LABEL: Record<UnitKind, string> = {
  silo: 'ICBM FIELD',
  airbase: 'BOMBER BASE',
  afb_int: 'INTERCEPTOR BASE',
  bomber: 'BOMBER GROUP',
  radar: 'EARLY WARNING RADAR',
  abm: 'ABM SITE',
  command: 'COMMAND POST',
  navalbase: 'NAVAL BASE',
  carrier: 'SURFACE GROUP',
  ssbn: 'SSBN',
  ssn: 'SSN',
};

/** Glyph used by the terminal map for each kind. */
export const KIND_GLYPH: Record<UnitKind, string> = {
  silo: '▲',
  airbase: '✈',
  afb_int: '◇',
  bomber: '►',
  radar: '◎',
  abm: '◆',
  command: '★',
  navalbase: '⚓',
  carrier: '▬',
  ssbn: '◒',
  ssn: '◓',
};

/** Phosphor palette — shared between terminal and GUI. */
export const PALETTE = {
  bg: '#000000',
  grid: '#12305a',
  coast: '#3fa9ff',
  coastDim: '#1f5fae',
  border: '#36d07a',
  states: '#2a64c4',
  river: '#2f8fd8',
  road: '#e0a040',
  urban: '#ff9a3c',
  city: '#ff9a3c',
  label: '#9fd8ff',
  reticle: '#ff5ad1',
  usa: '#8fd6ff',
  ussr: '#ff5a4f',
  missileUSA: '#c9f0ff',
  missileUSSR: '#ff7a6a',
  blast: '#ffffff',
  counter: '#ff3b2f',
  warn: '#ffd23f',
  ok: '#5cff8a',
  text: '#a8dcff',
};
