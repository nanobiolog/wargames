// Scenario registry. A scenario is self-contained: factions (who can play, colours, sensors,
// defeat texts), how they relate (allied / neutral / hostile), order of battle, cities, sea areas,
// opening briefing and random incidents. The engine reads nothing else about the world.
import type { ScenarioDef } from '@coldlaunch/shared';
import { buildUnits, CITIES, SEA_AREAS } from './scenario1983.ts';
import { MODERN } from './scenarioModern.ts';

const INCIDENTS_1983: { text: string; tension: number }[] = [
  { text: 'NORAD: SOVIET TU-95 PAIR PROBING ALASKAN AIR DEFENSE IDENTIFICATION ZONE. INTERCEPTORS SHADOWING.', tension: 4 },
  { text: 'SIGINT: UNUSUAL VOLUME OF ENCRYPTED TRAFFIC ON WARSAW PACT COMMAND NETS.', tension: 6 },
  { text: 'NORTHERN FLEET SURFACE UNITS SORTIE FROM KOLA INLET.', tension: 5 },
  { text: 'NATO EXERCISE ENTERS NUCLEAR RELEASE PROCEDURES PHASE (SIMULATED).', tension: 9 },
  { text: 'RESIDENCY CABLES: SOVIET INTELLIGENCE ORDERED TO REPORT ANY SIGNS OF SURPRISE ATTACK PREPARATIONS.', tension: 7 },
  { text: 'SOLAR ACTIVITY DEGRADING HF COMMUNICATIONS ACROSS THE ARCTIC.', tension: 2 },
  { text: 'US CARRIER BATTLE GROUP CONDUCTING FLIGHT OPS NEAR KAMCHATKA.', tension: 5 },
  { text: 'DIPLOMATIC CHANNEL: BOTH CAPITALS REQUEST CLARIFICATION OF RECENT FORCE MOVEMENTS.', tension: -4 },
  { text: 'WEATHER: HEAVY CLOUD OVER MONTANA MISSILE FIELDS — SATELLITE GLINT REPORTS EXPECTED.', tension: 3 },
  { text: 'ATTACK SUBMARINE TRAILING INCIDENT REPORTED IN THE NORWEGIAN SEA.', tension: 5 },
  { text: 'PRESS REPORTS: CIVIL DEFENSE OFFICES IN SEVERAL CITIES RECEIVE UNUSUAL INSTRUCTIONS.', tension: 4 },
  { text: 'BACK-CHANNEL: NEUTRAL INTERMEDIARY PROPOSES MUTUAL STAND-DOWN OF BOMBER ALERT.', tension: -6 },
];

export const SCENARIO_1983: ScenarioDef = {
  id: '1983',
  name: '1983 AUTUMN EXERCISE',
  summary: 'The classic: United States vs Soviet Union during a NATO command-post exercise. Two players or you vs an AI.',
  startEpoch: Date.UTC(1983, 10, 8, 21, 0, 0), // 8 Nov 1983 21:00Z
  timeLimitSec: 8 * 3600,
  factions: [
    {
      id: 'USA', name: 'UNITED STATES', short: 'USA', color: '#8cd9ff', playable: true,
      brief: 'Strategic Air Command, the Navy and NORAD. Deter, reassure allies, keep the missiles in their silos.',
      satDelaySec: 50, satDetectP: 0.97, failSafe: { aim: { lat: 55.75, lon: 37.62 }, km: 2400 },
      defeatText: 'UNITED STATES NATIONAL COMMAND DESTROYED',
    },
    {
      id: 'USSR', name: 'SOVIET UNION', short: 'USSR', color: '#ff524a', playable: true,
      brief: 'Strategic Rocket Forces, Long-Range Aviation and the Northern and Pacific fleets, convinced NATO may be preparing a surprise attack.',
      satDelaySec: 80, satDetectP: 0.85, failSafe: { aim: { lat: 38.9, lon: -77.0 }, km: 2200 },
      defeatText: 'SOVIET NATIONAL COMMAND DESTROYED',
    },
  ],
  relations: [['USA', 'USSR', 'hostile']],
  defaultSides: ['USA', 'USSR'],
  intro: [
    'STRATCOM // COLD LAUNCH — SCENARIO 1983: AUTUMN EXERCISE',
    'NATO COMMAND POST EXERCISE UNDERWAY IN WESTERN EUROPE. WARSAW PACT INTELLIGENCE ON HEIGHTENED WATCH.',
    'ALL FORCES AT DEFCON 5. TYPE "help" FOR ORDERS.',
  ],
  incidents: INCIDENTS_1983,
  units: buildUnits,
  cities: () => CITIES.map((c) => ({ ...c })),
  seaAreas: SEA_AREAS,
};

export const SCENARIOS: Record<string, ScenarioDef> = { '1983': SCENARIO_1983, modern: MODERN };

export function getScenario(id: string | undefined): ScenarioDef {
  return SCENARIOS[id ?? '1983'] ?? SCENARIO_1983;
}

/** Lobby list: id, name, summary, playable factions. */
export function scenarioList() {
  return Object.values(SCENARIOS).map((s) => ({
    id: s.id, name: s.name, summary: s.summary,
    factions: s.factions.filter((f) => f.playable).map((f) => ({ id: f.id, name: f.name, short: f.short, color: f.color, brief: f.brief })),
    defaultSides: s.defaultSides,
  }));
}
