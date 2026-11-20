#!/usr/bin/env node
/**
 * coldlaunch — start the game engine, take over this terminal as the command console,
 * and open the Electron wall display linked to the same session.
 *
 *   npm start -- [--side USA|USSR] [--opponent rules|claude[:model]|gemini[:model]|openai:model@url]
 *                [--advisor <spec>|none] [--personality 0..1] [--port 7700] [--seed N]
 *                [--no-gui] [--no-tui] [--ai-vs-ai] [--join <link>]
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, GameClient, enemyOf, parseLink, type Side, type Role } from '@coldlaunch/shared';
import { Game, GameServer } from '@coldlaunch/engine';
import { AiOpponent, loadConfig, makeAdvisor, makeProvider } from '@coldlaunch/ai';
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

  --side USA|USSR          side you command (default USA)
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
  --host 0.0.0.0           allow other devices on your LAN to join (token still required)
  --no-tui                 run the server only and print the session link
  --join <link>            connect this terminal to an existing session

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

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const joinLink = opt('--join');
  if (joinLink) {
    const client = new GameClient('tui');
    await client.connect(joinLink, opt('--side') as Role | undefined);
    const p = parseLink(joinLink);
    const webUrl = p ? `http://${p.host}:${p.port}/?token=${p.token}${p.role ? `&role=${p.role}` : ''}` : undefined;
    new TuiApp(client, { openGui: () => openGui(joinLink), openWeb: webUrl ? (preset) => openBrowser(`${webUrl}${preset ? `&preset=${preset}` : ''}`) : undefined }).start();
    return;
  }

  const cfg = loadConfig();
  const side = ((opt('--side') ?? 'USA').toUpperCase() === 'USSR' ? 'USSR' : 'USA') as Side;
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
    game: new Game(seed),
    playerSide: aiVsAi ? 'USA' : side,
    advisor: advisorLlm && advisorLlm !== 'rules' ? makeAdvisor(advisorLlm) : undefined,
    staticDir: join(ROOT, 'packages', 'gui', 'dist'),
  });
  await server.start();

  const ais: AiOpponent[] = [];
  const enemy = enemyOf(side);
  if (!humanOpponent) ais.push(new AiOpponent(server, enemy, opponent, { personality, log }).attach());
  if (aiVsAi) ais.push(new AiOpponent(server, side, opponent, { personality: 1 - personality * 0.6, log }).attach());
  server.aiLabel = humanOpponent ? `${enemy}=human` : ais.map((a) => `${a.side}=${a.label}`).join(' ');
  if (server.host === '0.0.0.0') server.publicHost = lanAddress();

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
    const lan = !!server.publicHost;
    const out: [string, string][] = [
      ['your browser display', server.webLink(role)],
      ['spectator wall (any PC)', server.webLink('SPECTATOR', 'wall', lan)],
      ['missile board (any PC)', server.webLink(role, 'missiles', lan)],
      [`${enemy} player browser`, server.webLink(enemy, 'wall', lan)],
      [`${enemy} player terminal`, `npm start -- --join "${server.link(enemy, lan)}"`],
      ['your terminal elsewhere', `npm start -- --join "${server.link(role, lan)}"`],
    ];
    if (!lan) out.push(['other PCs', 'restart with --host 0.0.0.0 to allow LAN connections']);
    return out;
  }
  if (useTui) log(`join links:\n${joinLinks().map(([a, b]) => `  ${a.padEnd(26)} ${b}`).join('\n')}`);

  if (!useTui) {
    console.log(`\n  STRATCOM // COLD LAUNCH — server running (opponent: ${server.aiLabel})\n`);
    for (const [a, b] of joinLinks()) console.log(`  ${a.padEnd(26)} ${b}`);
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
