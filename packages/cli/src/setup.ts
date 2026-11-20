#!/usr/bin/env node
/**
 * npm run setup — save AI API keys and defaults to ~/.coldlaunch/config.json (file mode 600).
 *
 *   npm run setup            interactive (keys are typed with hidden input)
 *   npm run setup -- --show  print the current settings (keys masked)
 *   npm run models           pick opponent / advisor models from a numbered list
 *   npm run setup -- --clear-keys
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { MODEL_MENU, type AiConfig } from '@coldlaunch/ai';

const DIR = join(homedir(), '.coldlaunch');
const FILE = join(DIR, 'config.json');

function load(): AiConfig {
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function save(cfg: AiConfig) {
  mkdirSync(DIR, { recursive: true });
  const clean = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== ''));
  writeFileSync(FILE, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  chmodSync(FILE, 0o600);
}

const mask = (k?: string) => (k ? `${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)` : 'not set');

function show(cfg: AiConfig) {
  const envG = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const envA = process.env.ANTHROPIC_API_KEY;
  console.log(`\n  config file   ${FILE}`);
  console.log(`  Gemini key    ${mask(cfg.geminiApiKey)}${envG ? '   (GEMINI_API_KEY env var set — it takes priority)' : ''}`);
  console.log(`  Anthropic key ${mask(cfg.anthropicApiKey)}${envA ? '   (ANTHROPIC_API_KEY env var set — it takes priority)' : ''}`);
  console.log(`  OpenAI-compat ${mask(cfg.openaiApiKey)}`);
  console.log(`  opponent      ${cfg.opponent ?? 'rules (default)'}`);
  console.log(`  advisor       ${cfg.advisor ?? 'same as opponent (or whichever key is set)'}`);
  console.log(`  bare "gemini" → ${cfg.geminiModel ?? 'gemini-3.1-flash-lite'},  bare "claude" → ${cfg.claudeModel ?? 'claude-haiku-5-5'}`);
  console.log(`  personality   ${cfg.personality ?? 0.5}`);
  console.log(`  display       ${cfg.display ?? 'electron (default)'}\n`);
}

// Piped (non-terminal) input: one shared line reader for every prompt.
let piped: AsyncIterableIterator<string> | null = null;
async function nextLine(): Promise<string> {
  piped ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const r = await piped.next();
  return r.done ? '' : r.value.trim();
}

/** Read a line without echoing it (for secrets). Enter on an empty line keeps the current value. */
function hidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    if (!stdin.isTTY) {
      void nextLine().then((l) => { process.stdout.write('\n'); resolve(l); });
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(buf.trim());
        }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(1); }
        if (ch === '\u007f' || ch === '\b') { if (buf) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        if (ch >= ' ') { buf += ch; process.stdout.write('*'); }
      }
    };
    stdin.on('data', onData);
  });
}

async function ask(q: string, def?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(`${q}${def ? ` [${def}]` : ''}: `);
    const l = await nextLine();
    process.stdout.write('\n');
    return l || def || '';
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
  rl.close();
  return a || def || '';
}

/** Numbered model menu. Accepts a number, a full spec (gemini:model), or Enter for the default. */
async function pickModel(title: string, current: string | undefined, cfg: AiConfig, allowSame = false): Promise<string | undefined> {
  const hasG = !!(cfg.geminiApiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
  const hasA = !!(cfg.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY);
  console.log(`\n  ${title}   (price per 1M tokens: input / output)`);
  if (allowSame) console.log(`   0) same as opponent`);
  MODEL_MENU.forEach((m, i) => {
    const needs = m.spec.startsWith('gemini') && !hasG ? '  [needs Gemini key]' : m.spec.startsWith('claude') && !hasA ? '  [needs Anthropic key or `ant auth login`]' : '';
    const mark = m.spec === current ? '  ← current' : '';
    console.log(`   ${i + 1}) ${m.label.padEnd(48)} ${m.price}${needs}${mark}`);
  });
  console.log(`   or type any spec, e.g. gemini:<model>, claude:<model>, openai:<model>@http://localhost:11434/v1`);
  const def = allowSame ? (current ? String(MODEL_MENU.findIndex((m) => m.spec === current) + 1 || current) : '0')
    : String((MODEL_MENU.findIndex((m) => m.spec === current) + 1) || (hasG ? 2 : hasA ? 5 : 1));
  const a = (await ask('  Choice', def)).trim();
  if (allowSame && a === '0') return undefined;
  const n = parseInt(a, 10);
  if (/^\d+$/.test(a) && n >= 1 && n <= MODEL_MENU.length) return MODEL_MENU[n - 1].spec;
  return a || current;
}

function rememberModel(cfg: AiConfig, spec?: string) {
  const m = spec?.match(/^(gemini|google|claude|anthropic):(.+)$/);
  if (!m) return;
  if (m[1] === 'gemini' || m[1] === 'google') cfg.geminiModel = m[2];
  else cfg.claudeModel = m[2];
}

async function chooseModels(cfg: AiConfig) {
  cfg.opponent = await pickModel('Opponent AI', cfg.opponent ?? undefined, cfg);
  rememberModel(cfg, cfg.opponent);
  cfg.advisor = await pickModel('Advisor (turns your plain-English orders into commands)', cfg.advisor, cfg, true);
  rememberModel(cfg, cfg.advisor);
}

async function main() {
  const cfg = load();
  if (process.argv.includes('--show')) return show(cfg);
  if (process.argv.includes('--models')) {
    await chooseModels(cfg);
    save(cfg);
    console.log('\n  Saved ✓');
    show(cfg);
    process.exit(0);
  }
  if (process.argv.includes('--clear-keys')) {
    delete cfg.geminiApiKey; delete cfg.anthropicApiKey; delete cfg.openaiApiKey;
    save(cfg);
    console.log('API keys removed from', FILE);
    return;
  }

  console.log(`
  STRATCOM // COLD LAUNCH — AI setup
  ----------------------------------
  Keys are saved only on this computer (${FILE}, readable by you only)
  and sent only to their own provider. Press Enter to keep a value, type "-" to remove it.

  Gemini key:    https://aistudio.google.com/apikey
  Anthropic key: Claude Console → API keys  (or run \`ant auth login\` and leave this empty)
`);
  const upd = async (label: string, cur?: string) => {
    const v = await hidden(`  ${label} (${cur ? 'currently ' + mask(cur) : 'not set'}): `);
    return v === '-' ? undefined : v || cur;
  };
  cfg.geminiApiKey = await upd('Gemini API key', cfg.geminiApiKey);
  cfg.anthropicApiKey = await upd('Anthropic API key', cfg.anthropicApiKey);

  await chooseModels(cfg);
  const p = parseFloat(await ask('  Opponent temperament 0 (dove) … 1 (hawk)', String(cfg.personality ?? 0.5)));
  cfg.personality = Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0.5;
  const d = (await ask('  Wall display: electron | browser | none', cfg.display ?? 'electron')).toLowerCase();
  cfg.display = (['electron', 'browser', 'none'].includes(d) ? d : 'electron') as AiConfig['display'];

  save(cfg);
  console.log(`\n  Saved ✓`);
  show(cfg);
  console.log('  Change models later:                             npm run models');
  console.log('  Test your opponent model (one small, billed call): npm run ai:smoke');
  console.log('  Play:                                            npm start\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
