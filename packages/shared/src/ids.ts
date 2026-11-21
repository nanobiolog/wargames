// Short, human-friendly identifiers: match codes, friend tags and callsigns.
// Alphabet drops look-alikes (0/O, 1/I/L) so codes survive being read aloud or typed on a phone.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LEN = 5;

function randInt(n: number): number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] % n;
  }
  return Math.floor(Math.random() * n);
}

/** 5-character code like "K7M2Q" (31^5 ≈ 28.6M combinations). Used for matches and friend tags. */
export function shortCode(len = CODE_LEN): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[randInt(CODE_ALPHABET.length)];
  return s;
}

/** Normalise user input ("k7m-2q", " K7M2Q ") to a code, or null if it can't be one. */
export function normalizeCode(input: string, len = CODE_LEN): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  // after mapping look-alikes, 0 and 1 are not in the alphabet → invalid
  if (s.length !== len) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

const WORDS = [
  'RAVEN', 'VIPER', 'ATLAS', 'NOMAD', 'TALON', 'COBRA', 'EMBER', 'FALCON', 'GHOST', 'HALO', 'JAGUAR', 'KESTREL',
  'LANCER', 'MAVERICK', 'NOVA', 'ORBIT', 'PHANTOM', 'QUASAR', 'RAPTOR', 'SABRE', 'TEMPEST', 'ULTRA', 'VECTOR',
  'WARDEN', 'XRAY', 'YANKEE', 'ZEPHYR', 'BOREAS', 'CIPHER', 'DAGGER', 'ECHO', 'FROST', 'GRANITE', 'HUNTER',
  'IRON', 'JUNO', 'KILO', 'LYNX', 'MERIDIAN', 'NIGHTJAR', 'ONYX', 'PIKE', 'RAMPART', 'SENTRY', 'TUNDRA',
];

/** Random callsign like "RAVEN-42". */
export function randomCallsign(): string {
  return `${WORDS[randInt(WORDS.length)]}-${10 + randInt(90)}`;
}

/** Clean a player-chosen display name: printable, 2-20 chars, upper case. */
export function cleanCallsign(name: string | undefined): string | null {
  const s = (name ?? '').normalize('NFKC').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().toUpperCase().slice(0, 20);
  return s.length >= 2 ? s : null;
}
