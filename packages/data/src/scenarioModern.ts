/**
 * MODERN 2026 — a fictional multipolar crisis. Five factions with game-scaled forces placed at
 * publicly known, approximate locations (encyclopedia level). Numbers are tuned for play balance,
 * not accuracy, and the crisis itself is invented.
 */
import type { City, ScenarioDef, Side, Unit, UnitKind } from '@coldlaunch/shared';

type U = Omit<Unit, 'status' | 'hp'> & Partial<Pick<Unit, 'status' | 'hp'>>;
const mk = (side: Side, kind: UnitKind, id: string, name: string, lat: number, lon: number, cls: string, extra: Partial<Unit> = {}): U => ({
  id, name, side, kind, lat, lon, cls, ...extra,
});
const icbm = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, missiles: number, warheads: number, yieldKt: number, rangeKm = 12000) =>
  mk(side, 'silo', id, name, lat, lon, cls, { missiles, warheads, yieldKt, rangeKm });
const bbase = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, aircraft: number, bombs: number, yieldKt: number, rangeKm = 12000, tankers = 2) =>
  mk(side, 'airbase', id, name, lat, lon, cls, { aircraft, bombs, yieldKt, tankers, rangeKm });
const intb = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, interceptors: number, defenceKm = 650) =>
  mk(side, 'afb_int', id, name, lat, lon, cls, { interceptors, defenceKm, radarKm: 0 });
const rdr = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, radarKm: number, airKm = 450) =>
  mk(side, 'radar', id, name, lat, lon, cls, { radarKm, defenceKm: airKm });
const port = (side: Side, id: string, name: string, lat: number, lon: number) => mk(side, 'navalbase', id, name, lat, lon, 'NAVAL BASE');
const ssbn = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, missiles: number, warheads: number, yieldKt: number, rangeKm: number, home: string) =>
  mk(side, 'ssbn', id, name, lat, lon, cls, { missiles, warheads, yieldKt, rangeKm, speedKmh: 30, submerged: true, home, status: 'patrol' });
const ssn = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, home: string) =>
  mk(side, 'ssn', id, name, lat, lon, cls, { speedKmh: 55, defenceKm: 150, submerged: true, home, status: 'patrol' });
const fleet = (side: Side, id: string, name: string, lat: number, lon: number, cls: string, home: string, interceptors: number, defenceKm = 500) =>
  mk(side, 'carrier', id, name, lat, lon, cls, { speedKmh: 55, defenceKm, radarKm: 0, interceptors, home, status: 'patrol' });
const cmd = (side: Side, id: string, name: string, lat: number, lon: number, cls = 'NATIONAL COMMAND') => mk(side, 'command', id, name, lat, lon, cls);

// ---------------------------------------------------------------- United States
const USA: U[] = [
  icbm('USA', 'm-icbm-minot', 'MINOT MISSILE FIELD', 48.42, -101.36, 'MINUTEMAN III', 10, 1, 300),
  icbm('USA', 'm-icbm-malmstrom', 'MALMSTROM MISSILE FIELD', 47.51, -111.18, 'MINUTEMAN III', 10, 1, 300),
  icbm('USA', 'm-icbm-warren', 'F.E. WARREN MISSILE FIELD', 41.13, -104.87, 'MINUTEMAN III', 10, 1, 300),
  bbase('USA', 'm-afb-whiteman', 'WHITEMAN AIR FORCE BASE', 38.73, -93.55, 'B-2A', 4, 4, 300, 11000),
  bbase('USA', 'm-afb-barksdale', 'BARKSDALE AIR FORCE BASE', 32.50, -93.66, 'B-52H', 6, 4, 150, 14000),
  bbase('USA', 'm-afb-andersen', 'ANDERSEN AIR FORCE BASE, GUAM', 13.58, 144.93, 'B-52H', 4, 4, 150, 14000),
  intb('USA', 'm-int-elmendorf', 'ELMENDORF AIR BASE', 61.25, -149.80, 'F-22A', 16),
  intb('USA', 'm-int-langley', 'LANGLEY AIR BASE', 37.08, -76.36, 'F-22A', 16),
  intb('USA', 'm-int-kadena', 'KADENA AIR BASE', 26.35, 127.77, 'F-15EX', 16, 700),
  rdr('USA', 'm-rdr-clear', 'CLEAR SPACE FORCE STATION', 64.29, -149.19, 'AN/FPS-123 UEWR', 5000),
  rdr('USA', 'm-rdr-pituffik', 'PITUFFIK SPACE BASE', 76.53, -68.70, 'AN/FPS-132 UEWR', 5000),
  rdr('USA', 'm-rdr-beale', 'BEALE AIR FORCE BASE', 39.14, -121.44, 'AN/FPS-132 UEWR', 5000),
  mk('USA', 'abm', 'm-abm-greely', 'FORT GREELY MISSILE DEFENSE', 63.98, -145.73, 'GROUND-BASED INTERCEPTOR', { missiles: 20, defenceKm: 1500, radarKm: 4000 }),
  cmd('USA', 'm-cmd-pentagon', 'NATIONAL MILITARY COMMAND CENTER', 38.87, -77.06),
  cmd('USA', 'm-cmd-offutt', 'STRATCOM HEADQUARTERS — OFFUTT', 41.12, -95.91, 'STRATCOM HQ'),
  cmd('USA', 'm-cmd-cheyenne', 'CHEYENNE MOUNTAIN', 38.74, -104.85, 'HARDENED C2'),
  port('USA', 'm-nb-norfolk', 'NORFOLK NAVAL STATION', 36.95, -76.31),
  port('USA', 'm-nb-sandiego', 'SAN DIEGO NAVAL BASE', 32.68, -117.12),
  port('USA', 'm-nb-pearl', 'PEARL HARBOR', 21.35, -157.95),
  port('USA', 'm-nb-yokosuka', 'YOKOSUKA FLEET ACTIVITIES', 35.29, 139.67),
  port('USA', 'm-nb-kingsbay', 'KINGS BAY SUBMARINE BASE', 30.80, -81.52),
  port('USA', 'm-nb-bangor', 'NAVAL BASE KITSAP — BANGOR', 47.73, -122.72),
  ssbn('USA', 'm-ssbn-wyoming', 'USS WYOMING', 32.0, -55.0, 'OHIO / TRIDENT II', 8, 4, 100, 11000, 'm-nb-kingsbay'),
  ssbn('USA', 'm-ssbn-maine', 'USS MAINE', 42.0, -160.0, 'OHIO / TRIDENT II', 8, 4, 100, 11000, 'm-nb-bangor'),
  ssbn('USA', 'm-ssbn-nevada', 'USS NEVADA', 25.0, 170.0, 'OHIO / TRIDENT II', 8, 4, 100, 11000, 'm-nb-bangor'),
  ssn('USA', 'm-ssn-virginia', 'USS VIRGINIA', 70.0, 5.0, 'VIRGINIA', 'm-nb-norfolk'),
  ssn('USA', 'm-ssn-indiana', 'USS INDIANA', 20.0, 125.0, 'VIRGINIA', 'm-nb-yokosuka'),
  ssn('USA', 'm-ssn-delaware', 'USS DELAWARE', 15.0, 115.0, 'VIRGINIA', 'm-nb-pearl'),
  fleet('USA', 'm-csg-reagan', 'RONALD REAGAN STRIKE GROUP', 24.0, 131.0, 'CVN NIMITZ / F-35C', 'm-nb-yokosuka', 30),
  fleet('USA', 'm-csg-ford', 'GERALD R. FORD STRIKE GROUP', 34.5, 26.0, 'CVN FORD / F/A-18', 'm-nb-norfolk', 30),
  fleet('USA', 'm-csg-lincoln', 'ABRAHAM LINCOLN STRIKE GROUP', 18.0, 62.0, 'CVN NIMITZ / F-35C', 'm-nb-sandiego', 30),
  fleet('USA', 'm-csg-roosevelt', 'THEODORE ROOSEVELT STRIKE GROUP', 14.0, 145.0, 'CVN NIMITZ / F/A-18', 'm-nb-sandiego', 28),
];

// ---------------------------------------------------------------- European coalition (UK + France)
const EUR: U[] = [
  bbase('EUR', 'm-ab-stdizier', 'SAINT-DIZIER AIR BASE', 48.64, 4.90, 'RAFALE B / ASMP-A', 6, 1, 300, 3700),
  bbase('EUR', 'm-ab-istres', 'ISTRES AIR BASE', 43.52, 4.92, 'RAFALE B / ASMP-A', 4, 1, 300, 3700),
  intb('EUR', 'm-int-coningsby', 'RAF CONINGSBY', 53.09, -0.17, 'TYPHOON FGR4', 14),
  intb('EUR', 'm-int-lossiemouth', 'RAF LOSSIEMOUTH', 57.71, -3.34, 'TYPHOON FGR4', 12),
  intb('EUR', 'm-int-mont', 'MONT-DE-MARSAN AIR BASE', 43.91, -0.50, 'RAFALE C', 12),
  rdr('EUR', 'm-rdr-fylingdales', 'RAF FYLINGDALES', 54.36, -0.67, 'SSPAR', 4800),
  cmd('EUR', 'm-cmd-northwood', 'NORTHWOOD HEADQUARTERS', 51.63, -0.42, 'JOINT HQ'),
  cmd('EUR', 'm-cmd-taverny', 'TAVERNY STRATEGIC COMMAND', 49.03, 2.21, 'FOST / CDAOA C2'),
  port('EUR', 'm-nb-faslane', 'HMNB CLYDE — FASLANE', 56.07, -4.82),
  port('EUR', 'm-nb-ilelongue', 'ÎLE LONGUE', 48.31, -4.51),
  port('EUR', 'm-nb-toulon', 'TOULON NAVAL BASE', 43.11, 5.92),
  port('EUR', 'm-nb-portsmouth', 'HMNB PORTSMOUTH', 50.80, -1.10),
  ssbn('EUR', 'm-ssbn-vengeance', 'HMS VENGEANCE', 60.0, -20.0, 'VANGUARD / TRIDENT II', 8, 3, 100, 11000, 'm-nb-faslane'),
  ssbn('EUR', 'm-ssbn-terrible', 'LE TERRIBLE', 44.0, -18.0, 'TRIOMPHANT / M51', 8, 4, 100, 9000, 'm-nb-ilelongue'),
  ssn('EUR', 'm-ssn-astute', 'HMS ASTUTE', 66.0, -2.0, 'ASTUTE', 'm-nb-faslane'),
  ssn('EUR', 'm-ssn-suffren', 'SUFFREN', 36.0, 15.0, 'SUFFREN', 'm-nb-toulon'),
  fleet('EUR', 'm-csg-cdg', 'CHARLES DE GAULLE GROUP', 35.5, 20.0, 'CVN / RAFALE M', 'm-nb-toulon', 20),
  fleet('EUR', 'm-csg-qe', 'QUEEN ELIZABETH GROUP', 58.0, -12.0, 'CV / F-35B', 'm-nb-portsmouth', 18),
];

// ---------------------------------------------------------------- Russia
const RUS: U[] = [
  icbm('RUS', 'm-icbm-kozelsk', 'KOZELSK', 53.97, 35.83, 'RS-24 YARS', 8, 3, 300),
  icbm('RUS', 'm-icbm-teykovo', 'TEYKOVO', 56.85, 40.55, 'RS-24 YARS', 8, 3, 300),
  icbm('RUS', 'm-icbm-dombarovsky', 'DOMBAROVSKY', 51.0, 59.8, 'RS-28 / AVANGARD', 4, 6, 500),
  icbm('RUS', 'm-icbm-uzhur', 'UZHUR', 55.3, 89.8, 'RS-20V', 6, 6, 500),
  icbm('RUS', 'm-icbm-tatishchevo', 'TATISHCHEVO', 51.67, 45.57, 'RT-2PM2 TOPOL-M', 8, 1, 800),
  bbase('RUS', 'm-ab-engels', 'ENGELS AIR BASE', 51.48, 46.20, 'TU-160M', 4, 6, 250, 12000),
  bbase('RUS', 'm-ab-ukrainka', 'UKRAINKA AIR BASE', 51.17, 128.45, 'TU-95MS', 5, 6, 200, 12000),
  intb('RUS', 'm-int-olenya', 'OLENYA AIR BASE', 68.15, 33.46, 'SU-35S', 14),
  intb('RUS', 'm-int-chkalovsk', 'CHKALOVSK (KALININGRAD)', 54.77, 20.40, 'SU-35S', 12),
  intb('RUS', 'm-int-yelizovo', 'YELIZOVO (KAMCHATKA)', 53.17, 158.45, 'MIG-31BM', 12, 800),
  rdr('RUS', 'm-rdr-lekhtusi', 'LEKHTUSI VORONEZH RADAR', 60.28, 30.55, 'VORONEZH-M', 5000),
  rdr('RUS', 'm-rdr-armavir', 'ARMAVIR VORONEZH RADAR', 44.93, 40.98, 'VORONEZH-DM', 5000),
  rdr('RUS', 'm-rdr-pechora', 'PECHORA RADAR', 65.21, 57.30, 'DARYAL / VORONEZH', 5000),
  mk('RUS', 'abm', 'm-abm-moscow', 'MOSCOW MISSILE DEFENCE', 55.98, 37.40, 'A-135 / A-235', { missiles: 24, defenceKm: 350, radarKm: 3000 }),
  cmd('RUS', 'm-cmd-kremlin', 'KREMLIN', 55.75, 37.62),
  cmd('RUS', 'm-cmd-ndmc', 'NATIONAL DEFENCE CONTROL CENTRE', 55.75, 37.58, 'NDMC'),
  cmd('RUS', 'm-cmd-vlasikha', 'STRATEGIC ROCKET FORCES HQ — VLASIKHA', 55.68, 37.18, 'RVSN HQ'),
  port('RUS', 'm-nb-gadzhiyevo', 'GADZHIYEVO', 69.25, 33.32),
  port('RUS', 'm-nb-severomorsk', 'SEVEROMORSK', 69.07, 33.42),
  port('RUS', 'm-nb-vilyuchinsk', 'VILYUCHINSK', 52.93, 158.40),
  port('RUS', 'm-nb-vladivostok', 'VLADIVOSTOK', 43.11, 131.88),
  port('RUS', 'm-nb-novorossiysk', 'NOVOROSSIYSK', 44.72, 37.79),
  ssbn('RUS', 'm-ssbn-knyazvladimir', 'KNYAZ VLADIMIR', 74.0, 45.0, 'BOREI-A / BULAVA', 8, 5, 150, 9300, 'm-nb-gadzhiyevo'),
  ssbn('RUS', 'm-ssbn-vladmonomakh', 'VLADIMIR MONOMAKH', 55.0, 150.0, 'BOREI / BULAVA', 8, 5, 150, 9300, 'm-nb-vilyuchinsk'),
  ssbn('RUS', 'm-ssbn-generalissimus', 'GENERALISSIMUS SUVOROV', 77.5, 42.0, 'BOREI-A / BULAVA', 8, 5, 150, 9300, 'm-nb-gadzhiyevo'),
  ssn('RUS', 'm-ssn-kazan', 'KAZAN', 64.0, -10.0, 'YASEN-M', 'm-nb-severomorsk'),
  ssn('RUS', 'm-ssn-novosibirsk', 'NOVOSIBIRSK', 48.0, 160.0, 'YASEN-M', 'm-nb-vilyuchinsk'),
  fleet('RUS', 'm-sag-northern', 'NORTHERN FLEET SURFACE GROUP', 71.0, 30.0, 'PYOTR VELIKIY / ADMIRAL GORSHKOV', 'm-nb-severomorsk', 8, 450),
  fleet('RUS', 'm-sag-pacific', 'PACIFIC FLEET SURFACE GROUP', 42.0, 134.0, 'VARYAG / SLAVA', 'm-nb-vladivostok', 6, 400),
];

// ---------------------------------------------------------------- China
const CHN: U[] = [
  icbm('CHN', 'm-icbm-yumen', 'YUMEN SILO FIELD', 40.15, 96.55, 'DF-41', 8, 3, 250),
  icbm('CHN', 'm-icbm-hami', 'HAMI SILO FIELD', 42.30, 92.40, 'DF-41', 8, 3, 250),
  icbm('CHN', 'm-icbm-ordos', 'ORDOS SILO FIELD', 39.80, 108.50, 'DF-41', 6, 3, 250),
  icbm('CHN', 'm-icbm-luoning', 'LUONING DF-5 BRIGADE', 34.40, 111.65, 'DF-5B', 4, 5, 300, 13000),
  bbase('CHN', 'm-ab-neixiang', 'NEIXIANG AIR BASE', 33.05, 111.85, 'H-6N', 6, 1, 300, 6000),
  intb('CHN', 'm-int-wuyishan', 'WUYISHAN AIR BASE', 27.70, 118.00, 'J-20', 16, 700),
  intb('CHN', 'm-int-suixi', 'SUIXI AIR BASE', 21.40, 110.20, 'J-16', 14),
  intb('CHN', 'm-int-anshan', 'ANSHAN AIR BASE', 41.10, 122.85, 'J-20', 12),
  rdr('CHN', 'm-rdr-korla', 'KORLA EARLY WARNING RADAR', 41.6, 86.2, 'LPAR', 5000),
  rdr('CHN', 'm-rdr-zhejiang', 'ZHEJIANG LPAR', 30.3, 119.3, 'LPAR', 5000),
  cmd('CHN', 'm-cmd-beijing', 'CENTRAL MILITARY COMMISSION — BEIJING', 39.91, 116.39),
  cmd('CHN', 'm-cmd-western-hills', 'WESTERN HILLS COMMAND CENTRE', 39.99, 116.17, 'HARDENED C2'),
  port('CHN', 'm-nb-yulin', 'YULIN NAVAL BASE', 18.22, 109.55),
  port('CHN', 'm-nb-qingdao', 'QINGDAO NAVAL BASE', 36.07, 120.38),
  port('CHN', 'm-nb-ningbo', 'NINGBO NAVAL BASE', 29.87, 121.55),
  ssbn('CHN', 'm-ssbn-jin1', 'TYPE 094A — 1', 15.0, 113.0, 'JIN / JL-3', 8, 3, 250, 10000, 'm-nb-yulin'),
  ssbn('CHN', 'm-ssbn-jin2', 'TYPE 094A — 2', 12.0, 117.0, 'JIN / JL-3', 8, 3, 250, 10000, 'm-nb-yulin'),
  ssn('CHN', 'm-ssn-shang1', 'TYPE 093B — 1', 22.0, 128.0, 'SHANG', 'm-nb-yulin'),
  ssn('CHN', 'm-ssn-shang2', 'TYPE 093B — 2', 30.0, 126.0, 'SHANG', 'm-nb-qingdao'),
  fleet('CHN', 'm-csg-shandong', 'SHANDONG CARRIER GROUP', 18.0, 114.0, 'TYPE 002 / J-15', 'm-nb-yulin', 22),
  fleet('CHN', 'm-csg-liaoning', 'LIAONING CARRIER GROUP', 28.0, 125.0, 'TYPE 001 / J-15', 'm-nb-qingdao', 20),
  fleet('CHN', 'm-csg-fujian', 'FUJIAN CARRIER GROUP', 33.0, 124.0, 'TYPE 003 / J-35', 'm-nb-ningbo', 26),
];

// ---------------------------------------------------------------- India (neutral)
const IND: U[] = [
  icbm('IND', 'm-icbm-agni', 'AGNI-V MISSILE GROUP', 21.0, 79.0, 'AGNI-V', 6, 1, 200, 7000),
  bbase('IND', 'm-ab-ambala', 'AMBALA AIR FORCE STATION', 30.37, 76.82, 'RAFALE / SU-30MKI', 6, 1, 40, 3700),
  intb('IND', 'm-int-pune', 'LOHEGAON AIR FORCE STATION', 18.58, 73.92, 'SU-30MKI', 14),
  intb('IND', 'm-int-tezpur', 'TEZPUR AIR FORCE STATION', 26.71, 92.79, 'SU-30MKI', 12, 700),
  rdr('IND', 'm-rdr-swordfish', 'SWORDFISH LONG-RANGE RADAR', 15.5, 79.0, 'LRTR', 3000),
  cmd('IND', 'm-cmd-delhi', 'STRATEGIC FORCES COMMAND — NEW DELHI', 28.61, 77.21),
  port('IND', 'm-nb-vizag', 'EASTERN NAVAL COMMAND — VISAKHAPATNAM', 17.69, 83.29),
  port('IND', 'm-nb-karwar', 'INS KADAMBA — KARWAR', 14.80, 74.12),
  ssbn('IND', 'm-ssbn-arighaat', 'INS ARIGHAAT', 15.0, 87.0, 'ARIHANT / K-4', 4, 1, 200, 3500, 'm-nb-vizag'),
  fleet('IND', 'm-csg-vikrant', 'INS VIKRANT GROUP', 12.0, 70.0, 'IAC-1 / MIG-29K', 'm-nb-karwar', 16),
  fleet('IND', 'm-csg-vikramaditya', 'INS VIKRAMADITYA GROUP', 14.0, 86.0, 'MODIFIED KIEV / MIG-29K', 'm-nb-vizag', 14),
];

// ---------------------------------------------------------------- cities (pop in thousands, metro, rounded)
const C = (side: Side | 'OTHER', name: string, lat: number, lon: number, pop: number): City => ({
  id: `city-${name.toLowerCase().replace(/[^a-z]+/g, '')}`, name: name.toUpperCase(), side, lat, lon, pop, killed: 0,
});
const CITIES: City[] = [
  C('USA', 'New York', 40.71, -74.01, 19500), C('USA', 'Los Angeles', 34.05, -118.24, 12900), C('USA', 'Chicago', 41.88, -87.63, 9300),
  C('USA', 'Dallas', 32.78, -96.80, 8100), C('USA', 'Houston', 29.76, -95.37, 7500), C('USA', 'Washington', 38.91, -77.04, 6400),
  C('USA', 'Miami', 25.76, -80.19, 6200), C('USA', 'Atlanta', 33.75, -84.39, 6300), C('USA', 'Seattle', 47.61, -122.33, 4100),
  C('USA', 'San Francisco', 37.77, -122.42, 4600), C('USA', 'Honolulu', 21.31, -157.86, 1000), C('USA', 'Anchorage', 61.22, -149.90, 400),
  C('EUR', 'London', 51.51, -0.13, 9600), C('EUR', 'Paris', 48.86, 2.35, 11300), C('EUR', 'Manchester', 53.48, -2.24, 2900),
  C('EUR', 'Lyon', 45.76, 4.84, 2300), C('EUR', 'Marseille', 43.30, 5.37, 1900), C('EUR', 'Birmingham', 52.49, -1.89, 2600),
  C('EUR', 'Glasgow', 55.86, -4.25, 1700), C('EUR', 'Toulouse', 43.60, 1.44, 1400), C('EUR', 'Brest', 48.39, -4.49, 320),
  C('RUS', 'Moscow', 55.76, 37.62, 13100), C('RUS', 'St. Petersburg', 59.93, 30.36, 5600), C('RUS', 'Novosibirsk', 55.03, 82.92, 1600),
  C('RUS', 'Yekaterinburg', 56.84, 60.61, 1500), C('RUS', 'Kazan', 55.79, 49.12, 1300), C('RUS', 'Nizhny Novgorod', 56.33, 44.00, 1200),
  C('RUS', 'Samara', 53.20, 50.15, 1150), C('RUS', 'Vladivostok', 43.12, 131.89, 600), C('RUS', 'Murmansk', 68.97, 33.08, 270),
  C('CHN', 'Shanghai', 31.23, 121.47, 29900), C('CHN', 'Beijing', 39.90, 116.40, 22000), C('CHN', 'Guangzhou', 23.13, 113.26, 14300),
  C('CHN', 'Shenzhen', 22.54, 114.06, 13400), C('CHN', 'Chongqing', 29.56, 106.55, 17400), C('CHN', 'Tianjin', 39.34, 117.36, 14000),
  C('CHN', 'Wuhan', 30.59, 114.31, 8900), C('CHN', 'Chengdu', 30.57, 104.07, 9500), C('CHN', "Xi'an", 34.34, 108.94, 8900),
  C('CHN', 'Qingdao', 36.07, 120.38, 6200), C('CHN', 'Sanya', 18.25, 109.51, 1000),
  C('IND', 'Delhi', 28.70, 77.10, 33800), C('IND', 'Mumbai', 19.08, 72.88, 21700), C('IND', 'Kolkata', 22.57, 88.36, 15600),
  C('IND', 'Bengaluru', 12.97, 77.59, 14000), C('IND', 'Chennai', 13.08, 80.27, 12000), C('IND', 'Hyderabad', 17.39, 78.49, 11000),
  C('IND', 'Visakhapatnam', 17.69, 83.22, 2400),
  C('OTHER', 'Tokyo', 35.68, 139.69, 37000), C('OTHER', 'Seoul', 37.57, 126.98, 25000), C('OTHER', 'Taipei', 25.03, 121.57, 7000),
  C('OTHER', 'Manila', 14.60, 120.98, 14900), C('OTHER', 'Singapore', 1.35, 103.82, 6000), C('OTHER', 'Berlin', 52.52, 13.40, 3700),
  C('OTHER', 'Istanbul', 41.01, 28.98, 15900), C('OTHER', 'Tehran', 35.69, 51.39, 9500), C('OTHER', 'Karachi', 24.86, 67.01, 17200),
  C('OTHER', 'Riyadh', 24.71, 46.68, 7700), C('OTHER', 'Cairo', 30.04, 31.24, 22600), C('OTHER', 'Sydney', -33.87, 151.21, 5400),
  C('OTHER', 'Toronto', 43.65, -79.38, 6400), C('OTHER', 'Mexico City', 19.43, -99.13, 22500),
];

const SEA_AREAS = [
  ['BARENTS SEA', 73, 40], ['NORWEGIAN SEA', 68, 5], ['GIUK GAP', 63, -15], ['NORTH ATLANTIC', 45, -35], ['MID ATLANTIC', 30, -45],
  ['MEDITERRANEAN', 35, 18], ['EASTERN MEDITERRANEAN', 34, 30], ['BLACK SEA', 43, 34], ['BALTIC SEA', 57, 19], ['NORTH SEA', 56, 3],
  ['ARCTIC OCEAN', 84, 0], ['SEA OF OKHOTSK', 54, 148], ['SEA OF JAPAN', 40, 135], ['BERING SEA', 58, -178], ['GULF OF ALASKA', 56, -145],
  ['NORTH PACIFIC', 42, 170], ['WESTERN PACIFIC', 25, 150], ['PHILIPPINE SEA', 20, 130], ['EAST CHINA SEA', 29, 125], ['YELLOW SEA', 36, 123],
  ['TAIWAN STRAIT', 24.5, 119.5], ['SOUTH CHINA SEA', 13, 114], ['STRAIT OF MALACCA', 3.5, 100.5], ['BAY OF BENGAL', 14, 88],
  ['ARABIAN SEA', 15, 62], ['INDIAN OCEAN', -5, 75], ['STRAIT OF HORMUZ', 26.3, 56.6], ['PERSIAN GULF', 27, 51], ['GULF OF ADEN', 12.5, 47],
  ['RED SEA', 20, 38.5], ['HAWAII', 22, -160], ['US EAST COAST', 36, -68], ['US WEST COAST', 36, -128], ['CARIBBEAN', 15, -75],
  ['GULF OF MEXICO', 25, -90], ['BAY OF BISCAY', 45, -5], ['GREENLAND SEA', 76, -5], ['LABRADOR SEA', 58, -55],
].map(([name, lat, lon]) => ({ name: name as string, lat: lat as number, lon: lon as number }));

const INCIDENTS: { text: string; tension: number }[] = [
  { text: 'MARITIME: CONTAINER SHIPPING DIVERTS AWAY FROM THE TAIWAN STRAIT AFTER A NAVAL STAND-OFF.', tension: 6 },
  { text: 'CYBER: GPS JAMMING REPORTED ACROSS THE BALTIC AND EASTERN MEDITERRANEAN.', tension: 4 },
  { text: 'SPACE: AN ANTI-SATELLITE TEST LEAVES A DEBRIS FIELD IN LOW EARTH ORBIT. EARLY-WARNING SATELLITES MANOEUVRE.', tension: 8 },
  { text: 'DRONES: UNIDENTIFIED DRONES OBSERVED OVER A NORTH SEA GAS PLATFORM. NAVAL PATROLS DISPATCHED.', tension: 4 },
  { text: 'ENERGY: TANKER TRAFFIC THROUGH THE STRAIT OF HORMUZ HALTED FOR SIX HOURS AFTER A MINE WARNING.', tension: 7 },
  { text: 'SUBMARINE: A FISHING VESSEL REPORTS A SUBMARINE SURFACING NEAR THE GIUK GAP.', tension: 4 },
  { text: 'AIR: BOMBERS FLY A LONG-RANGE PATROL ALONG THE EDGE OF A NEIGHBOUR\'S AIR DEFENCE IDENTIFICATION ZONE.', tension: 5 },
  { text: 'DIPLOMACY: THE UN SECURITY COUNCIL CALLS AN EMERGENCY SESSION ON FREEDOM OF NAVIGATION.', tension: -4 },
  { text: 'DIPLOMACY: NEUTRAL STATES OFFER TO HOST TALKS ON MARITIME RULES OF THE ROAD.', tension: -6 },
  { text: 'MARKETS: INSURERS SUSPEND COVER FOR SHIPS IN THE SOUTH CHINA SEA.', tension: 3 },
  { text: 'INTELLIGENCE: SATELLITE IMAGERY SHOWS UNUSUAL ACTIVITY AT A MISSILE BRIGADE GARRISON.', tension: 6 },
  { text: 'HOTLINE: MILITARY-TO-MILITARY CHANNELS REOPENED AFTER A WEEK OF SILENCE.', tension: -5 },
];

export const MODERN: ScenarioDef = {
  id: 'modern',
  name: '2026 STRAITS CRISIS',
  summary: 'Five powers, one crisis over the sea lanes. USA + European coalition vs Russia + China, with India neutral. Up to 5 players; AI fills the rest.',
  startEpoch: Date.UTC(2026, 9, 14, 3, 0, 0),
  timeLimitSec: 10 * 3600,
  factions: [
    {
      id: 'USA', name: 'UNITED STATES', short: 'USA', color: '#8cd9ff', playable: true,
      brief: 'Carrier strike groups in three oceans, a triad at home. Keep the sea lanes open without starting the war.',
      satDelaySec: 40, satDetectP: 0.98, failSafe: { aim: { lat: 39.9, lon: 116.4 }, km: 2600 },
      defeatText: 'UNITED STATES NATIONAL COMMAND DESTROYED',
    },
    {
      id: 'EUR', name: 'EUROPEAN COALITION', short: 'EUR', color: '#7dffb0', playable: true,
      brief: 'British and French deterrents, two carriers. Close to every flashpoint in the Atlantic and Mediterranean.',
      satDelaySec: 70, satDetectP: 0.9, failSafe: { aim: { lat: 55.75, lon: 37.62 }, km: 1300 },
      defeatText: 'EUROPEAN COALITION COMMAND DESTROYED',
    },
    {
      id: 'RUS', name: 'RUSSIA', short: 'RUS', color: '#ff524a', playable: true,
      brief: 'The largest arsenal, Arctic bastions for its submarines, and air defence in depth. Aligned with China.',
      satDelaySec: 60, satDetectP: 0.92, failSafe: { aim: { lat: 38.9, lon: -77.0 }, km: 2300 },
      defeatText: 'RUSSIAN NATIONAL COMMAND DESTROYED',
    },
    {
      id: 'CHN', name: 'CHINA', short: 'CHN', color: '#ffb347', playable: true,
      brief: 'A fast-growing silo force, three carriers and dense air power around its coasts. Aligned with Russia.',
      satDelaySec: 60, satDetectP: 0.9, failSafe: { aim: { lat: 13.5, lon: 144.8 }, km: 1600 },
      defeatText: 'CHINESE CENTRAL MILITARY COMMISSION DESTROYED',
    },
    {
      id: 'IND', name: 'INDIA', short: 'IND', color: '#d9a2ff', playable: true,
      brief: 'Neutral. Two carriers astride the Indian Ocean routes. Both blocs want you on their side; you want the shipping to keep moving.',
      satDelaySec: 120, satDetectP: 0.75, failSafe: { aim: { lat: 34.0, lon: 78.0 }, km: 600 },
      defeatText: 'INDIAN STRATEGIC FORCES COMMAND DESTROYED',
    },
  ],
  relations: [
    ['USA', 'EUR', 'allied'], ['RUS', 'CHN', 'allied'],
    ['USA', 'RUS', 'hostile'], ['USA', 'CHN', 'hostile'], ['EUR', 'RUS', 'hostile'], ['EUR', 'CHN', 'hostile'],
    // India: neutral with everyone (pairs not listed are neutral)
  ],
  defaultSides: ['USA', 'CHN'],
  intro: [
    'STRATCOM // COLD LAUNCH — SCENARIO 2026: STRAITS CRISIS',
    'A COLLISION BETWEEN WARSHIPS IN THE SOUTH CHINA SEA HAS SPIRALLED INTO A STAND-OFF ACROSS THREE OCEANS.',
    'CARRIER GROUPS ARE AT SEA. SHIPPING INSURERS HAVE SUSPENDED COVER. EVERY CAPITAL INSISTS IT IS ONLY DEFENDING THE SEA LANES.',
    'ALL FORCES AT DEFCON 5. RECON SORTIES (recon <carrier> to <place>) SHOW YOU WHO IS WHERE. TYPE "help" FOR ORDERS.',
  ],
  incidents: INCIDENTS,
  units: () => [...USA, ...EUR, ...RUS, ...CHN, ...IND].map((u) => ({ status: 'ready', hp: 1, ...u }) as Unit),
  cities: () => CITIES.map((c) => ({ ...c })),
  seaAreas: SEA_AREAS,
};
