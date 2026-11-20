/**
 * 1983 order of battle (game-scaled, roughly 1:10 for ICBM fields) built from publicly known
 * base locations. Numbers are tuned for play balance, not accuracy.
 */
import type { City, Side, Unit, UnitKind } from '@coldlaunch/shared';

type U = Omit<Unit, 'status' | 'hp'> & Partial<Pick<Unit, 'status' | 'hp'>>;

const mk = (side: Side, kind: UnitKind, id: string, name: string, lat: number, lon: number, cls: string, extra: Partial<Unit> = {}): U => ({
  id, name, side, kind, lat, lon, cls, ...extra,
});

// ---------------------------------------------------------------- ICBM fields
const icbm = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, missiles: number, warheads: number, yieldKt: number) =>
  mk(side, 'silo', id, name, lat, lon, cls, { missiles, warheads, yieldKt, rangeKm: 13000 });

const US_ICBM: U[] = [
  icbm('USA', 'icbm-minot', 'MINOT MISSILE FIELD', 48.42, -101.36, 'MINUTEMAN III', 15, 3, 170),
  icbm('USA', 'icbm-grandforks', 'GRAND FORKS MISSILE FIELD', 47.95, -97.40, 'MINUTEMAN III', 15, 3, 170),
  icbm('USA', 'icbm-malmstrom', 'MALMSTROM MISSILE FIELD', 47.51, -111.18, 'MINUTEMAN II/III', 20, 2, 335),
  icbm('USA', 'icbm-warren', 'F.E. WARREN MISSILE FIELD', 41.13, -104.87, 'MINUTEMAN III', 20, 3, 335),
  icbm('USA', 'icbm-ellsworth', 'ELLSWORTH MISSILE FIELD', 44.15, -103.10, 'MINUTEMAN II', 15, 1, 1200),
  icbm('USA', 'icbm-whiteman', 'WHITEMAN MISSILE FIELD', 38.73, -93.55, 'MINUTEMAN II', 15, 1, 1200),
  icbm('USA', 'icbm-davismonthan', 'DAVIS-MONTHAN TITAN WING', 32.17, -110.88, 'TITAN II', 3, 1, 9000),
  icbm('USA', 'icbm-mcconnell', 'McCONNELL TITAN WING', 37.62, -97.27, 'TITAN II', 3, 1, 9000),
  icbm('USA', 'icbm-littlerock', 'LITTLE ROCK TITAN WING', 34.92, -92.15, 'TITAN II', 3, 1, 9000),
];

const SU_ICBM: U[] = [
  icbm('USSR', 'icbm-dombarovsky', 'DOMBAROVSKY', 51.0, 59.8, 'SS-18 SATAN', 6, 10, 550),
  icbm('USSR', 'icbm-uzhur', 'UZHUR', 55.3, 89.8, 'SS-18 SATAN', 6, 10, 550),
  icbm('USSR', 'icbm-aleysk', 'ALEYSK', 52.5, 82.3, 'SS-18 SATAN', 6, 10, 550),
  icbm('USSR', 'icbm-kartaly', 'KARTALY', 53.05, 60.65, 'SS-18 SATAN', 6, 10, 550),
  icbm('USSR', 'icbm-zhangiztobe', 'ZHANGIZ-TOBE', 49.2, 81.2, 'SS-18 SATAN', 5, 10, 550),
  icbm('USSR', 'icbm-derzhavinsk', 'DERZHAVINSK', 51.1, 66.3, 'SS-18 SATAN', 5, 10, 550),
  icbm('USSR', 'icbm-tatishchevo', 'TATISHCHEVO', 51.68, 45.6, 'SS-19 STILETTO', 8, 6, 550),
  icbm('USSR', 'icbm-kozelsk', 'KOZELSK', 54.03, 35.78, 'SS-19 STILETTO', 8, 6, 550),
  icbm('USSR', 'icbm-pervomaysk', 'PERVOMAYSK', 47.97, 31.0, 'SS-19 STILETTO', 8, 6, 550),
  icbm('USSR', 'icbm-khmelnytskyi', 'KHMELNYTSKYI', 49.43, 26.98, 'SS-19 STILETTO', 6, 6, 550),
  icbm('USSR', 'icbm-teykovo', 'TEYKOVO', 56.85, 40.55, 'SS-11 SEGO', 10, 1, 1000),
  icbm('USSR', 'icbm-svobodny', 'SVOBODNY', 51.4, 128.1, 'SS-11 SEGO', 10, 1, 1000),
  icbm('USSR', 'icbm-drovyanaya', 'DROVYANAYA', 51.3, 113.0, 'SS-11 SEGO', 10, 1, 1000),
];

// ---------------------------------------------------------------- bomber bases
const bbase = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, aircraft: number, bombs: number, yieldKt: number, tankers = 2) =>
  mk(side, 'airbase', id, name, lat, lon, cls, { aircraft, bombs, yieldKt, tankers, rangeKm: side === 'USA' ? 14000 : 12000 });

const US_BOMBERS: U[] = [
  bbase('USA', 'afb-loring', 'LORING AIR FORCE BASE', 46.95, -67.89, 'B-52G', 6, 4, 1100),
  bbase('USA', 'afb-griffiss', 'GRIFFISS AIR FORCE BASE', 43.23, -75.41, 'B-52G', 6, 4, 1100),
  bbase('USA', 'afb-plattsburgh', 'PLATTSBURGH AIR FORCE BASE', 44.65, -73.47, 'FB-111A', 5, 2, 200),
  bbase('USA', 'afb-fairchild', 'FAIRCHILD AIR FORCE BASE', 47.62, -117.66, 'B-52G', 6, 4, 1100),
  bbase('USA', 'afb-castle', 'CASTLE AIR FORCE BASE', 37.38, -120.57, 'B-52G', 5, 4, 1100),
  bbase('USA', 'afb-barksdale', 'BARKSDALE AIR FORCE BASE', 32.50, -93.66, 'B-52G', 6, 4, 1100),
  bbase('USA', 'afb-minot', 'MINOT AIR FORCE BASE', 48.42, -101.36, 'B-52H', 6, 4, 1100),
  bbase('USA', 'afb-grandforks', 'GRAND FORKS AIR FORCE BASE', 47.96, -97.40, 'B-52H', 6, 4, 1100),
  bbase('USA', 'afb-wurtsmith', 'WURTSMITH AIR FORCE BASE', 44.45, -83.39, 'B-52G', 5, 4, 1100),
  bbase('USA', 'afb-ksawyer', 'K.I. SAWYER AIR FORCE BASE', 46.35, -87.40, 'B-52H', 5, 4, 1100),
];

const SU_BOMBERS: U[] = [
  bbase('USSR', 'lra-engels', 'ENGELS AIR BASE', 51.48, 46.20, 'M-4 / 3M', 5, 2, 1000),
  bbase('USSR', 'lra-ukrainka', 'UKRAINKA AIR BASE', 51.17, 128.45, 'TU-95K', 5, 2, 1000),
  bbase('USSR', 'lra-dolon', 'DOLON AIR BASE', 50.53, 79.18, 'TU-95', 5, 2, 1000),
  bbase('USSR', 'lra-uzin', 'UZIN AIR BASE', 49.83, 30.40, 'TU-95K', 4, 2, 1000),
  bbase('USSR', 'lra-mozdok', 'MOZDOK AIR BASE', 43.75, 44.65, 'TU-95', 4, 2, 1000),
];

// ---------------------------------------------------------------- air defence
const intb = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, interceptors: number, defenceKm = 700) =>
  mk(side, 'afb_int', id, name, lat, lon, cls, { interceptors, defenceKm, radarKm: 0 });

const US_AD: U[] = [
  intb('USA', 'int-elmendorf', 'ELMENDORF AIR FORCE BASE', 61.25, -149.80, 'F-15A', 18, 900),
  intb('USA', 'int-galena', 'GALENA FORWARD OPERATING BASE', 64.74, -156.94, 'F-15A', 6, 600),
  intb('USA', 'int-kingsalmon', 'KING SALMON AIRPORT', 58.68, -156.65, 'F-15A', 6, 600),
  intb('USA', 'int-mcchord', 'McCHORD AIR FORCE BASE', 47.14, -122.48, 'F-106A', 12),
  intb('USA', 'int-langley', 'LANGLEY AIR FORCE BASE', 37.08, -76.36, 'F-15A', 12),
  intb('USA', 'int-tyndall', 'TYNDALL AIR FORCE BASE', 30.07, -85.58, 'F-106A', 8),
  intb('USA', 'int-keflavik', 'KEFLAVIK NAVAL AIR STATION', 63.98, -22.60, 'F-4E', 10, 800),
  intb('USA', 'int-goosebay', 'GOOSE BAY (CF)', 53.32, -60.42, 'CF-101', 8, 700),
];

const SU_AD: U[] = [
  intb('USSR', 'pvo-arkhangelsk', 'TALAGI AIR BASE', 64.60, 40.72, 'MIG-25P', 14),
  intb('USSR', 'pvo-severomorsk', 'KILPYAVR AIR BASE', 69.23, 32.88, 'MIG-31', 12, 800),
  intb('USSR', 'pvo-vorkuta', 'VORKUTA AIR BASE', 67.49, 63.99, 'MIG-25P', 10, 800),
  intb('USSR', 'pvo-norilsk', 'NORILSK AIR BASE', 69.31, 87.33, 'SU-15', 8, 800),
  intb('USSR', 'pvo-anadyr', 'ANADYR UGOLNY', 64.73, 177.74, 'MIG-31', 10, 900),
  intb('USSR', 'pvo-moscow', 'KUBINKA AIR BASE', 55.61, 36.65, 'MIG-25P', 16),
  intb('USSR', 'pvo-petropavlovsk', 'YELIZOVO AIR BASE', 53.17, 158.45, 'MIG-31', 10),
  intb('USSR', 'pvo-kotlas', 'SAVATIYA AIR BASE', 61.12, 46.70, 'TU-128', 8, 800),
];

// ---------------------------------------------------------------- radars
const rdr = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, radarKm: number, airKm = 400) =>
  mk(side, 'radar', id, name, lat, lon, cls, { radarKm, defenceKm: airKm });

const US_RADAR: U[] = [
  rdr('USA', 'rdr-thule', 'THULE BMEWS', 76.53, -68.70, 'AN/FPS-50', 4800),
  rdr('USA', 'rdr-clear', 'CLEAR BMEWS', 64.29, -149.19, 'AN/FPS-50', 4800),
  rdr('USA', 'rdr-fylingdales', 'FYLINGDALES BMEWS', 54.36, -0.67, 'AN/FPS-49', 4800),
  rdr('USA', 'rdr-capecod', 'CAPE COD PAVE PAWS', 41.75, -70.54, 'AN/FPS-115', 5500),
  rdr('USA', 'rdr-beale', 'BEALE PAVE PAWS', 39.14, -121.35, 'AN/FPS-115', 5500),
  rdr('USA', 'rdr-shemya', 'SHEMYA COBRA DANE', 52.72, 174.10, 'AN/FPS-108', 4600),
  rdr('USA', 'rdr-barrow', 'POINT BARROW DEW', 71.29, -156.79, 'DEW LINE', 0, 500),
  rdr('USA', 'rdr-cambridge', 'CAMBRIDGE BAY DEW', 69.12, -105.06, 'DEW LINE', 0, 500),
  rdr('USA', 'rdr-hallbeach', 'HALL BEACH DEW', 68.78, -81.24, 'DEW LINE', 0, 500),
];

const SU_RADAR: U[] = [
  rdr('USSR', 'rdr-olenegorsk', 'OLENEGORSK', 68.12, 33.91, 'DNEPR', 4000),
  rdr('USSR', 'rdr-skrunda', 'SKRUNDA', 56.71, 21.97, 'DNEPR', 4000),
  rdr('USSR', 'rdr-pechora', 'PECHORA', 65.21, 57.30, 'DARYAL', 6000),
  rdr('USSR', 'rdr-mishelevka', 'MISHELEVKA', 52.86, 103.23, 'DNEPR', 4000),
  rdr('USSR', 'rdr-balkhash', 'BALKHASH', 46.60, 74.53, 'DNEPR', 4000),
  rdr('USSR', 'rdr-sevastopol', 'SEVASTOPOL', 44.58, 33.39, 'DNEPR', 4000),
  rdr('USSR', 'rdr-mukachevo', 'MUKACHEVO', 48.38, 22.71, 'DNEPR', 4000),
  rdr('USSR', 'rdr-anadyr', 'ANADYR PVO RADAR', 64.70, 177.50, 'TALL KING', 0, 500),
];

// ---------------------------------------------------------------- command / ABM
const US_C2: U[] = [
  mk('USA', 'command', 'cmd-norad', 'NORAD — CHEYENNE MOUNTAIN', 38.74, -104.85, 'HARDENED C2'),
  mk('USA', 'command', 'cmd-pentagon', 'NATIONAL MILITARY COMMAND CENTER', 38.87, -77.06, 'NMCC'),
  mk('USA', 'command', 'cmd-offutt', 'SAC HEADQUARTERS — OFFUTT', 41.12, -95.91, 'SAC HQ'),
];
const SU_C2: U[] = [
  mk('USSR', 'command', 'cmd-kremlin', 'KREMLIN', 55.75, 37.62, 'STAVKA'),
  mk('USSR', 'command', 'cmd-chekhov', 'CHEKHOV GENERAL STAFF BUNKER', 55.15, 37.45, 'HARDENED C2'),
  mk('USSR', 'command', 'cmd-vlasikha', 'RVSN HQ — VLASIKHA', 55.68, 37.18, 'RVSN HQ'),
  mk('USSR', 'abm', 'abm-moscow', 'MOSCOW ABM SYSTEM', 55.98, 37.40, 'A-35M GALOSH', { missiles: 32, defenceKm: 320, radarKm: 2800 }),
];

// ---------------------------------------------------------------- naval
const port = (side: Side, id: string, name: string, lat: number, lon: number, cls = 'NAVAL BASE') => mk(side, 'navalbase', id, name, lat, lon, cls);
const ssbn = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, missiles: number, warheads: number, yieldKt: number, rangeKm: number, home: string) =>
  mk(side, 'ssbn', id, name, lat, lon, cls, { missiles, warheads, yieldKt, rangeKm, speedKmh: 30, submerged: true, home, status: 'patrol' });
const ssn = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, home: string) =>
  mk(side, 'ssn', id, name, lat, lon, cls, { speedKmh: 48, defenceKm: 130, submerged: true, home, status: 'patrol' });
const fleet = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, home: string, interceptors = 24) =>
  mk(side, 'carrier', id, name, lat, lon, cls, { speedKmh: 55, defenceKm: 450, radarKm: 0, interceptors, home, status: 'patrol' });

const US_NAVY: U[] = [
  port('USA', 'nb-norfolk', 'NORFOLK NAVAL STATION', 36.95, -76.31),
  port('USA', 'nb-sandiego', 'SAN DIEGO NAVAL BASE', 32.68, -117.13),
  port('USA', 'nb-pearl', 'PEARL HARBOR', 21.35, -157.95),
  port('USA', 'nb-kingsbay', 'KINGS BAY SUBMARINE BASE', 30.80, -81.52, 'SSBN BASE'),
  port('USA', 'nb-bangor', 'BANGOR SUBMARINE BASE', 47.72, -122.71, 'SSBN BASE'),
  port('USA', 'nb-holyloch', 'HOLY LOCH', 56.00, -4.93, 'SSBN TENDER'),
  port('USA', 'nb-yokosuka', 'YOKOSUKA', 35.29, 139.67),
  ssbn('USA', 'ssbn-ohio', 'USS OHIO', 46.0, -165.0, 'OHIO / TRIDENT C4', 8, 8, 100, 7400, 'nb-bangor'),
  ssbn('USA', 'ssbn-michigan', 'USS MICHIGAN', 38.0, 168.0, 'OHIO / TRIDENT C4', 8, 8, 100, 7400, 'nb-bangor'),
  ssbn('USA', 'ssbn-francis', 'USS FRANCIS SCOTT KEY', 69.0, 3.0, 'LAFAYETTE / TRIDENT C4', 6, 8, 100, 7400, 'nb-holyloch'),
  ssbn('USA', 'ssbn-henryclay', 'USS HENRY CLAY', 60.5, -12.0, 'LAFAYETTE / POSEIDON', 6, 10, 40, 4600, 'nb-holyloch'),
  ssbn('USA', 'ssbn-jamesmadison', 'USS JAMES MADISON', 34.5, 25.0, 'LAFAYETTE / POSEIDON', 6, 10, 40, 4600, 'nb-holyloch'),
  ssbn('USA', 'ssbn-simonbolivar', 'USS SIMON BOLIVAR', 48.0, -30.0, 'BENJAMIN FRANKLIN / TRIDENT C4', 6, 8, 100, 7400, 'nb-kingsbay'),
  ssbn('USA', 'ssbn-casimir', 'USS CASIMIR PULASKI', 64.0, -2.0, 'BENJAMIN FRANKLIN / POSEIDON', 6, 10, 40, 4600, 'nb-holyloch'),
  ssn('USA', 'ssn-batonrouge', 'USS BATON ROUGE', 71.0, 22.0, 'LOS ANGELES', 'nb-norfolk'),
  ssn('USA', 'ssn-memphis', 'USS MEMPHIS', 66.5, -1.0, 'LOS ANGELES', 'nb-norfolk'),
  ssn('USA', 'ssn-omaha', 'USS OMAHA', 47.0, 151.0, 'LOS ANGELES', 'nb-pearl'),
  ssn('USA', 'ssn-parche', 'USS PARCHE', 36.0, 18.0, 'STURGEON', 'nb-norfolk'),
  fleet('USA', 'cvbg-eisenhower', 'EISENHOWER BATTLE GROUP', 34.0, 20.0, 'CVN-69 NIMITZ', 'nb-norfolk'),
  fleet('USA', 'cvbg-americas', 'AMERICA BATTLE GROUP', 52.0, -25.0, 'CV-66 KITTY HAWK', 'nb-norfolk'),
  fleet('USA', 'cvbg-midway', 'MIDWAY BATTLE GROUP', 33.5, 141.0, 'CV-41 MIDWAY', 'nb-yokosuka'),
  fleet('USA', 'cvbg-enterprise', 'ENTERPRISE BATTLE GROUP', 46.0, -150.0, 'CVN-65 ENTERPRISE', 'nb-pearl'),
];

const SU_NAVY: U[] = [
  port('USSR', 'nb-severomorsk', 'SEVEROMORSK', 69.07, 33.42, 'NORTHERN FLEET HQ'),
  port('USSR', 'nb-gadzhiyevo', 'GADZHIYEVO', 69.25, 33.33, 'SSBN BASE'),
  port('USSR', 'nb-vladivostok', 'VLADIVOSTOK', 43.12, 131.90, 'PACIFIC FLEET HQ'),
  port('USSR', 'nb-rybachiy', 'RYBACHIY', 52.92, 158.50, 'SSBN BASE'),
  port('USSR', 'nb-sevastopol', 'SEVASTOPOL', 44.60, 33.53, 'BLACK SEA FLEET HQ'),
  port('USSR', 'nb-baltiysk', 'BALTIYSK', 54.65, 19.90, 'BALTIC FLEET HQ'),
  ssbn('USSR', 'ssbn-k441', 'K-441', 75.0, 40.0, 'DELTA III / SS-N-18', 8, 3, 200, 6500, 'nb-gadzhiyevo'),
  ssbn('USSR', 'ssbn-k490', 'K-490', 73.5, 52.0, 'DELTA III / SS-N-18', 8, 3, 200, 6500, 'nb-gadzhiyevo'),
  ssbn('USSR', 'ssbn-tk208', 'TK-208', 83.0, 45.0, 'TYPHOON / SS-N-20', 10, 6, 100, 8300, 'nb-gadzhiyevo'),
  ssbn('USSR', 'ssbn-k223', 'K-223', 53.0, 148.0, 'DELTA III / SS-N-18', 8, 3, 200, 6500, 'nb-rybachiy'),
  ssbn('USSR', 'ssbn-k180', 'K-180', 55.5, 150.5, 'DELTA III / SS-N-18', 8, 3, 200, 6500, 'nb-rybachiy'),
  ssbn('USSR', 'ssbn-k219', 'K-219', 34.0, -60.0, 'YANKEE I / SS-N-6', 8, 1, 1000, 3000, 'nb-gadzhiyevo'),
  ssbn('USSR', 'ssbn-k140', 'K-140', 38.0, -133.0, 'YANKEE I / SS-N-6', 8, 1, 1000, 3000, 'nb-rybachiy'),
  ssn('USSR', 'ssn-k524', 'K-524', 65.0, -5.0, 'VICTOR III', 'nb-severomorsk'),
  ssn('USSR', 'ssn-k255', 'K-255', 55.0, -25.0, 'VICTOR III', 'nb-severomorsk'),
  ssn('USSR', 'ssn-k492', 'K-492', 45.0, 170.0, 'VICTOR III', 'nb-rybachiy'),
  ssn('USSR', 'ssn-k324', 'K-324', 70.0, 15.0, 'VICTOR III', 'nb-severomorsk'),
  fleet('USSR', 'sag-kirov', 'KIROV SURFACE ACTION GROUP', 70.5, 18.0, 'KIROV', 'nb-severomorsk'),
  fleet('USSR', 'sag-kiev', 'KIEV TASK FORCE', 34.0, 30.0, 'KIEV', 'nb-sevastopol'),
  fleet('USSR', 'sag-minsk', 'MINSK TASK FORCE', 41.0, 134.0, 'KIEV / MINSK', 'nb-vladivostok'),
  fleet('USSR', 'sag-northern', 'NORTHERN FLEET SAG', 70.0, 36.0, 'SLAVA', 'nb-severomorsk', 12),
];

export function buildUnits(): Unit[] {
  const all = [...US_ICBM, ...SU_ICBM, ...US_BOMBERS, ...SU_BOMBERS, ...US_AD, ...SU_AD, ...US_RADAR, ...SU_RADAR, ...US_C2, ...SU_C2, ...US_NAVY, ...SU_NAVY];
  return all.map((u) => ({ status: 'ready', hp: 1, ...u }) as Unit);
}

// ---------------------------------------------------------------- cities (pop in thousands, c.1983)
const C = (side: Side | 'OTHER', name: string, lat: number, lon: number, pop: number): City => ({
  id: `city-${name.toLowerCase().replace(/[^a-z]+/g, '')}`, name: name.toUpperCase(), side, lat, lon, pop, killed: 0,
});

export const CITIES: City[] = [
  C('USA', 'New York', 40.71, -74.01, 16000), C('USA', 'Los Angeles', 34.05, -118.24, 11500), C('USA', 'Chicago', 41.88, -87.63, 7900),
  C('USA', 'Philadelphia', 39.95, -75.17, 5500), C('USA', 'San Francisco', 37.77, -122.42, 5300), C('USA', 'Detroit', 42.33, -83.05, 4750),
  C('USA', 'Boston', 42.36, -71.06, 3970), C('USA', 'Washington', 38.91, -77.04, 3250), C('USA', 'Houston', 29.76, -95.37, 3100),
  C('USA', 'Dallas', 32.78, -96.80, 2930), C('USA', 'Cleveland', 41.50, -81.69, 2830), C('USA', 'Miami', 25.76, -80.19, 2640),
  C('USA', 'Pittsburgh', 40.44, -79.99, 2420), C('USA', 'St. Louis', 38.63, -90.20, 2380), C('USA', 'Baltimore', 39.29, -76.61, 2200),
  C('USA', 'Minneapolis', 44.98, -93.27, 2110), C('USA', 'Seattle', 47.61, -122.33, 2090), C('USA', 'Atlanta', 33.75, -84.39, 2030),
  C('USA', 'San Diego', 32.72, -117.16, 1860), C('USA', 'Cincinnati', 39.10, -84.51, 1660), C('USA', 'Denver', 39.74, -104.99, 1620),
  C('USA', 'Milwaukee', 43.04, -87.91, 1570), C('USA', 'Tampa', 27.95, -82.46, 1570), C('USA', 'Phoenix', 33.45, -112.07, 1510),
  C('USA', 'Kansas City', 39.10, -94.58, 1430), C('USA', 'Portland', 45.52, -122.68, 1300), C('USA', 'New Orleans', 29.95, -90.07, 1260),
  C('USA', 'Buffalo', 42.89, -78.88, 1240), C('USA', 'Indianapolis', 39.77, -86.16, 1170), C('USA', 'Norfolk', 36.85, -76.29, 1160),
  C('USA', 'Sacramento', 38.58, -121.49, 1100), C('USA', 'Columbus', 39.96, -83.00, 1090), C('USA', 'San Antonio', 29.42, -98.49, 1070),
  C('USA', 'Charlotte', 35.23, -80.84, 970), C('USA', 'Louisville', 38.25, -85.76, 950), C('USA', 'Salt Lake City', 40.76, -111.89, 940),
  C('USA', 'Memphis', 35.15, -90.05, 910), C('USA', 'Oklahoma City', 35.47, -97.52, 860), C('USA', 'Nashville', 36.16, -86.78, 850),
  C('USA', 'Honolulu', 21.31, -157.86, 760), C('USA', 'Omaha', 41.26, -95.94, 570), C('USA', 'Las Vegas', 36.17, -115.14, 460),
  C('USA', 'Albuquerque', 35.08, -106.65, 450), C('USA', 'Spokane', 47.66, -117.43, 340), C('USA', 'Great Falls', 47.50, -111.30, 80),
  C('USA', 'Anchorage', 61.22, -149.90, 175), C('USA', 'Fargo', 46.88, -96.79, 140), C('USA', 'Cheyenne', 41.14, -104.82, 70),
  C('USSR', 'Moscow', 55.76, 37.62, 8400), C('USSR', 'Leningrad', 59.93, 30.36, 4800), C('USSR', 'Kiev', 50.45, 30.52, 2400),
  C('USSR', 'Tashkent', 41.30, 69.24, 1950), C('USSR', 'Baku', 40.41, 49.87, 1600), C('USSR', 'Kharkov', 49.99, 36.23, 1500),
  C('USSR', 'Minsk', 53.90, 27.56, 1450), C('USSR', 'Gorky', 56.33, 44.00, 1400), C('USSR', 'Novosibirsk', 55.03, 82.92, 1380),
  C('USSR', 'Sverdlovsk', 56.84, 60.61, 1250), C('USSR', 'Kuibyshev', 53.20, 50.15, 1240), C('USSR', 'Tbilisi', 41.72, 44.79, 1140),
  C('USSR', 'Dnepropetrovsk', 48.46, 35.05, 1130), C('USSR', 'Yerevan', 40.18, 44.51, 1100), C('USSR', 'Odessa', 46.48, 30.72, 1080),
  C('USSR', 'Omsk', 54.99, 73.37, 1080), C('USSR', 'Chelyabinsk', 55.16, 61.40, 1070), C('USSR', 'Donetsk', 48.02, 37.80, 1050),
  C('USSR', 'Perm', 58.01, 56.25, 1030), C('USSR', 'Kazan', 55.79, 49.12, 1020), C('USSR', 'Ufa', 54.73, 55.96, 1000),
  C('USSR', 'Alma-Ata', 43.24, 76.89, 1000), C('USSR', 'Rostov', 47.24, 39.71, 980), C('USSR', 'Volgograd', 48.71, 44.51, 960),
  C('USSR', 'Saratov', 51.53, 46.03, 880), C('USSR', 'Riga', 56.95, 24.11, 860), C('USSR', 'Krasnoyarsk', 56.01, 92.87, 850),
  C('USSR', 'Zaporozhye', 47.84, 35.14, 840), C('USSR', 'Lvov', 49.84, 24.03, 700), C('USSR', 'Vladivostok', 43.12, 131.89, 590),
  C('USSR', 'Irkutsk', 52.29, 104.30, 580), C('USSR', 'Novokuznetsk', 53.76, 87.11, 580), C('USSR', 'Barnaul', 53.35, 83.78, 570),
  C('USSR', 'Khabarovsk', 48.48, 135.07, 560), C('USSR', 'Vilnius', 54.69, 25.28, 530), C('USSR', 'Kemerovo', 55.35, 86.09, 500),
  C('USSR', 'Tallinn', 59.44, 24.75, 460), C('USSR', 'Murmansk', 68.97, 33.08, 400), C('USSR', 'Arkhangelsk', 64.54, 40.54, 400),
  C('USSR', 'Sevastopol', 44.62, 33.53, 330), C('USSR', 'Petropavlovsk', 53.02, 158.65, 230), C('USSR', 'Orenburg', 51.77, 55.10, 510),
  C('OTHER', 'London', 51.51, -0.13, 6700), C('OTHER', 'Paris', 48.86, 2.35, 8700), C('OTHER', 'Tokyo', 35.68, 139.69, 11600),
  C('OTHER', 'Beijing', 39.90, 116.40, 5600), C('OTHER', 'Berlin', 52.52, 13.40, 3000), C('OTHER', 'Toronto', 43.65, -79.38, 2900),
  C('OTHER', 'Montreal', 45.50, -73.57, 2800), C('OTHER', 'Warsaw', 52.23, 21.01, 1600), C('OTHER', 'Reykjavik', 64.15, -21.94, 85),
];

export const SEA_AREAS: { name: string; lat: number; lon: number }[] = [
  ['BARENTS SEA', 73, 40], ['NORWEGIAN SEA', 68, 5], ['GIUK GAP', 63, -15], ['NORTH ATLANTIC', 45, -35], ['MID ATLANTIC', 30, -45],
  ['MEDITERRANEAN', 35, 18], ['BLACK SEA', 43, 34], ['BALTIC SEA', 57, 19], ['ARCTIC OCEAN', 84, 0], ['KARA SEA', 76, 70],
  ['SEA OF OKHOTSK', 54, 148], ['SEA OF JAPAN', 40, 135], ['BERING SEA', 58, -178], ['GULF OF ALASKA', 56, -145],
  ['NORTH PACIFIC', 42, 170], ['EAST PACIFIC', 30, -135], ['HAWAII', 22, -160], ['CARIBBEAN', 15, -75], ['GULF OF MEXICO', 25, -90],
  ['INDIAN OCEAN', 0, 75], ['ARABIAN SEA', 15, 62], ['LABRADOR SEA', 58, -55], ['HUDSON BAY', 60, -85], ['BAFFIN BAY', 73, -66],
  ['PHILIPPINE SEA', 20, 130], ['SOUTH CHINA SEA', 12, 114], ['GREENLAND SEA', 76, -5], ['CHUKCHI SEA', 69, -171],
  ['EAST SIBERIAN SEA', 74, 165], ['LAPTEV SEA', 76, 125], ['BAY OF BISCAY', 45, -5], ['NORTH SEA', 56, 3], ['WESTERN PACIFIC', 30, 155],
  ['US EAST COAST', 36, -68], ['US WEST COAST', 36, -128], ['NORTH POLE', 89, 0],
].map(([name, lat, lon]) => ({ name: name as string, lat: lat as number, lon: lon as number }));
