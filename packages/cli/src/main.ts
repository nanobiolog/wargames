#!/usr/bin/env node
/**
 * coldlaunch — start the game engine, take over this terminal as the command console,
 * and open the Electron wall display linked to the same session.
 *
 *   npm start -- [--scenario 1983|modern] [--side USA|USSR|EUR|RUS|CHN|IND] [--opponent rules|claude[:model]|gemini[:model]|openai:model@url]
 *                [--advisor <spec>|none] [--personality 0..1] [--port 7700] [--seed N]
 *                [--no-gui] [--no-tui] [--ai-vs-ai] [--join <link>]
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, GameClient, enemyOf, parseLink, normalizeCode, makeMatchLink, randomCallsign, cleanCallsign, shortCode, type Side, type Role } from '@coldlaunch/shared';
import { Game, GameServer } from '@coldlaunch/engine';
import { getScenario } from '@coldlaunch/data';
import { AiOpponent, loadConfig, makeAdvisor, makeProvider, describeAiError } from '@coldlaunch/ai';
import { TuiApp } from '@coldlaunch/tui';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(k);
const opt = (k: string, d?: string) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

if (flag('--help') || flag('-h')) {
  console.log(`STRATCOM // COLD LAUNCH

  npm start -- [options]

  --side <faction>         side you command: USA|USSR (1983), USA|EUR|RUS|CHN|IND (modern); default USA
  --opponent <spec>        rules | human | claude[:model] | gemini[:model] | openai:model@baseURL
                           e.g. gemini:gemini-3.1-flash-lite, claude:claude-haiku-5-5
                           human = a second person plays the other side (see the "link" command)
  --advisor <spec>|none    AI that turns natural-language orders into commands
  --personality 0..1       opponent temperament (0 dove … 1 hawk, default 0.5)
  --ai-vs-ai               both sides played by AI, you watch as spectator
  --port N                 websocket port (default ${DEFAULT_PORT})
  --seed N                 deterministic scenario seed
  --no-gui                 don't open the Electron wall display
  --display <mode>         electron (default) | browser (a browser tab) | none — save a default with npm run setup
  --web, --browser         same as --display browser
  --all-monitors           Electron: one fullscreen window per monitor (wall, CONUS, missiles, stats, ...)
  --lan                    share with phones / other PCs on your network from the start
                           (or type "share" in the game any time for QR codes)
  --no-tui                 run the server only and print the session link
  --scenario <1983|modern> 1983 (USA vs USSR, default) or modern (2026, five factions: USA EUR RUS CHN IND)
  --join <link|CODE>       connect this terminal to an existing session, or to an online match by its
                           5-character code (server: COLDLAUNCH_SERVER or "server" in config.json)
  --name <callsign>        your callsign in online matches (saved in ~/.coldlaunch/identity.json)

  API keys: run "npm run setup" (saved to ~/.coldlaunch/config.json), or set GEMINI_API_KEY / ANTHROPIC_API_KEY`);
  process.exit(0);
}

const logDir = join(homedir(), '.coldlaunch');
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, 'server.log');
const useTui = !flag('--no-tui') && process.stdout.isTTY;
const log = (m: string) => {
  const line = `[${new Date().toISOString()}] ${m}\n`;
  if (useTui) appendFileSync(logFile, line);
  else process.stdout.write(line);
};

function openGui(link: string, allMonitors = false) {
  const guiDir = join(ROOT, 'packages', 'gui');
  if (!existsSync(join(guiDir, 'dist', 'index.html'))) {
    log('GUI not built yet — run "npm run gui:build" once');
    return false;
  }
  let electron: string;
  try {
    electron = createRequire(join(guiDir, 'package.json'))('electron') as unknown as string;
  } catch {
    log('electron not installed — run "npm install"');
    return false;
  }
  const child = spawn(electron, [guiDir, `--link=${link}`, ...(allMonitors ? ['--all-monitors'] : [])], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  child.unref();
  return true;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

/** Callsign, player id and friend tag for online matches (shared by every terminal on this machine). */
function loadIdentity(name?: string): { name: string; player: string; tag: string } {
  const f = join(homedir(), '.coldlaunch', 'identity.json');
  let id: { name?: string; player?: string; tag?: string } = {};
  try { id = JSON.parse(readFileSync(f, 'utf8')); } catch { /* first run */ }
  const out = {
    name: cleanCallsign(name) ?? cleanCallsign(id.name) ?? randomCallsign(),
    player: id.player ?? `p-${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    tag: id.tag ?? shortCode(),
  };
  mkdirSync(join(homedir(), '.coldlaunch'), { recursive: true });
  writeFileSync(f, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

async function main() {
  let joinLink = opt('--join');
  if (joinLink) {
    // a bare 5-character code joins an online match on the default server
    const code = normalizeCode(joinLink);
    const onlineServer = process.env.COLDLAUNCH_SERVER ?? loadConfig().server ?? 'https://coldlaunch.nano-carbay.workers.dev';
    if (code) joinLink = makeMatchLink(onlineServer, code, opt('--side') as Role | undefined);
    const p = parseLink(joinLink);
    const client = new GameClient('tui');
    if (p?.online) {
      // online match: identity from ~/.coldlaunch/identity.json; this terminal can run AI calls for its
      // side with the key saved by `npm run setup` (the key stays on this machine)
      const id = loadIdentity(opt('--name'));
      const cfg = loadConfig();
      const llm = makeProvider(cfg.advisor ?? cfg.opponent ?? (cfg.anthropicApiKey ? 'claude' : cfg.geminiApiKey ? 'gemini' : 'rules'), cfg);
      client.identity = { name: id.name, player: id.player, tag: id.tag, caps: llm === 'rules' ? [] : ['ai'] };
      if (llm !== 'rules') {
        client.on('aiJob', async (job) => {
          try {
            const r = await llm.decide(job.system, job.user, job.tools as never);
            client.aiResult({ t: 'aiResult', id: job.id, calls: r.calls.slice(0, 16), text: r.text.slice(0, 4000), inTok: r.inTok, outTok: r.outTok });
          } catch (e) {
            client.aiResult({ t: 'aiResult', id: job.id, error: describeAiError(e, llm.provider).slice(0, 400) });
          }
        });
      }
    }
    await client.connect(joinLink, opt('--side') as Role | undefined);
    const webUrl = p?.online
      ? makeMatchLink(`${p.secure ? 'https' : 'http'}://${p.host}${p.port === (p.secure ? 443 : 80) ? '' : `:${p.port}`}`, p.token, client.role)
      : p ? `http://${p.host}:${p.port}/?token=${p.token}${p.role ? `&role=${p.role}` : ''}` : undefined;
    const sep = webUrl?.includes('?') ? '&' : '?';
    new TuiApp(client, { openGui: () => openGui(joinLink!), openWeb: webUrl ? (preset) => openBrowser(`${webUrl}${preset ? `${sep}preset=${preset}` : ''}`) : undefined }).start();
    return;
  }

  const cfg = loadConfig();
  const scenario = getScenario(opt('--scenario') ?? '1983');
  const wantSide = (opt('--side') ?? scenario.defaultSides[0]).toUpperCase();
  const side = (scenario.factions.find((f) => f.playable && (f.id === wantSide || f.short === wantSide))?.id ?? scenario.defaultSides[0]) as Side;
  const aiVsAi = flag('--ai-vs-ai');
  const personality = Math.max(0, Math.min(1, parseFloat(opt('--personality', String(cfg.personality ?? 0.5))!)));
  const oppSpec = opt('--opponent') ?? process.env.COLDLAUNCH_OPPONENT ?? cfg.opponent ?? 'rules';
  let advSpec = opt('--advisor') ?? process.env.COLDLAUNCH_ADVISOR ?? cfg.advisor;
  const oppIsLlm = !['rules', 'human', 'none', 'builtin'].includes(oppSpec);
  if (!advSpec) advSpec = oppIsLlm ? oppSpec : cfg.geminiApiKey ? 'gemini' : cfg.anthropicApiKey ? 'claude' : 'none';

  // "human" = no AI: the other side is played by a second person (another terminal / PC)
  const humanOpponent = oppSpec === 'human' || oppSpec === 'none';
  const opponent = humanOpponent ? 'rules' : makeProvider(oppSpec, cfg, 'low');
  const advisorLlm = advSpec === 'none' ? null : makeProvider(advSpec, cfg, 'low');
  const port = parseInt(opt('--port', String(DEFAULT_PORT))!, 10);
  const seed = opt('--seed') ? parseInt(opt('--seed')!, 10) : undefined;

  const server = new GameServer({
    port,
    host: opt('--host', '127.0.0.1'),
    game: new Game(seed, undefined, scenario.id),
    playerSide: aiVsAi ? 'USA' : side,
    advisor: advisorLlm && advisorLlm !== 'rules' ? makeAdvisor(advisorLlm) : undefined,
    staticDir: join(ROOT, 'packages', 'gui', 'dist'),
  });
  await server.start();

  const ais: AiOpponent[] = [];
  const g0 = server.game;
  const enemy = g0.hostilesOf(side)[0] ?? enemyOf(side);
  // two factions: the opponent (LLM or doctrine); more: your main adversary gets the chosen opponent,
  // every other faction the doctrine AI (allies and neutrals play cautiously)
  if (!humanOpponent) ais.push(new AiOpponent(server, enemy, opponent, { personality, log }).attach());
  for (const f of g0.factions) {
    if (f === side || f === enemy) continue;
    ais.push(new AiOpponent(server, f, 'rules', { personality: g0.hostile(side, f) ? personality : 0.4, log }).attach());
  }
  if (aiVsAi) ais.push(new AiOpponent(server, side, opponent, { personality: 1 - personality * 0.6, log }).attach());
  server.aiLabel = humanOpponent ? `${enemy}=human` : ais.map((a) => `${a.side}=${a.label}`).join(' ');
  if (flag('--lan')) await server.enableLan();

  const role: Role = aiVsAi ? 'SPECTATOR' : side;
  const link = server.link(role);
  log(`server up on ${server.host}:${port} — link ${link} — opponent ${server.aiLabel}`);

  const web = server.webLink(role);
  // let the MCP server (and `--join`) discover the running session; token stays local (mode 600)
  const sessionFile = join(logDir, 'session.json');
  writeFileSync(sessionFile, JSON.stringify({ link, web, side: role, pid: process.pid }));
  chmodSync(sessionFile, 0o600);
  log(`web wall display: ${web}`);
  // display mode: electron (default) | browser | none — flag, env or saved config
  let display = (opt('--display') ?? process.env.COLDLAUNCH_DISPLAY ?? cfg.display ?? 'electron').toLowerCase();
  if (flag('--web') || flag('--browser')) display = 'browser';
  if (flag('--no-gui')) display = 'none';
  const openWall = (preset?: string) => {
    if (display === 'browser') openBrowser(server.webLink(role, preset));
    else if (!openGui(link, flag('--all-monitors'))) openBrowser(server.webLink(role, preset)); // fall back to a browser tab
  };
  if (display !== 'none') openWall();

  function joinLinks(): [string, string][] {
    const info = server.shareInfo(role);
    const out: [string, string][] = [['your browser display', server.webLink(role)]];
    if (info.lan) for (const l of info.links) out.push([l.label, l.url]);
    else out.push(['phones / other PCs', 'type "share" in the game (or start with --lan) to get QR codes and LAN links']);
    return out;
  }
  if (useTui) log(`join links:\n${joinLinks().map(([a, b]) => `  ${a.padEnd(26)} ${b}`).join('\n')}`);

  if (!useTui) {
    console.log(`\n  STRATCOM // COLD LAUNCH — server running (opponent: ${server.aiLabel})\n`);
    for (const [a, b] of joinLinks()) console.log(`  ${a.padEnd(38)} ${b}`);
    console.log('\n  Add &preset=conus|europe|missiles|stats|world|polar|… to any browser link — one per monitor.\n');
    return;
  }
  const client = new GameClient('tui');
  await client.connect(link, role);
  const app = new TuiApp(client, {
    links: () => joinLinks(),
    openGui: () => openWall(),
    openWeb: (preset) => openBrowser(server.webLink(role, preset)),
    onQuit: () => server.stop(),
  });
  app.start();
}

main().catch((e) => {
  console.error(`fatal: ${e?.message ?? e}`);
  process.exit(1);
});
