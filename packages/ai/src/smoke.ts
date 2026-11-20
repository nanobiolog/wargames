// Live smoke test for an AI provider: npm run ai:smoke -- --provider gemini:gemini-4-hydrogen
import { Game } from '@coldlaunch/engine';
import { makeProvider, loadConfig, GAME_TOOLS, situationReport, toolCallToCommand } from './index.ts';
import { opponentSystemPrompt } from './situation.ts';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
// default: the opponent you saved with `npm run setup`
const spec = arg('--provider') ?? loadConfig().opponent ?? 'gemini';
const p = makeProvider(spec);
if (p === 'rules') {
  console.log('rules provider needs no smoke test');
  process.exit(0);
}
const g = new Game(1);
for (let i = 0; i < 100; i++) g.step();
const snap = g.snapshot('USSR');
const report = situationReport('USSR', snap, g.staticWorld(), g.eventsFor('USSR', 0), []);
console.log(`→ ${p.provider}:${p.model} (${report.length} chars of situation)`);
const t0 = Date.now();
const r = await p.decide(opponentSystemPrompt('USSR', 0.5), report, GAME_TOOLS);
console.log(`← ${Date.now() - t0} ms, in=${r.inTok} out=${r.outTok}`);
if (r.text) console.log('text:', r.text);
for (const c of r.calls) console.log('call:', c.name, JSON.stringify(c.args), '→', JSON.stringify(toolCallToCommand(c)));
