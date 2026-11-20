// Electron main process for the STRATCOM // COLD LAUNCH wall display.
const { app, BrowserWindow, Menu, protocol, net, ipcMain, shell, screen } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, 'dist');
const SCHEME = 'coldlaunch';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let pendingLink = findLink(process.argv);
const windows = new Set();

function findLink(argv) {
  for (const a of argv) {
    if (a.startsWith('--link=')) return a.slice(7);
    if (a.startsWith(`${SCHEME}://`)) return a;
  }
  return null;
}

function createWindow(link, opts = {}) {
  const win = new BrowserWindow({
    width: opts.width ?? 1600,
    height: opts.height ?? 960,
    backgroundColor: '#000000',
    title: 'STRATCOM // COLD LAUNCH',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const q = new URLSearchParams();
  if (link) q.set('link', link);
  if (opts.preset) q.set('preset', opts.preset);
  win.loadURL(`app://wall/index.html?${q.toString()}`);
  // external links open in the system browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  // test hook: COLDLAUNCH_SCREENSHOT=/path.png captures the first window after it has rendered, then quits
  if (process.env.COLDLAUNCH_SCREENSHOT && windows.size === 1) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      require('node:fs').writeFileSync(process.env.COLDLAUNCH_SCREENSHOT, img.toPNG());
      app.quit();
    }, 7000));
  }
  return win;
}

function buildMenu() {
  const presets = [
    ['Full wall', 'wall'], ['World', 'world'], ['North polar', 'polar'], ['Continental US', 'conus'],
    ['Alaska sector', 'alaska'], ['Eurasia', 'eurasia'], ['Europe', 'europe'], ['Pacific', 'pacific'],
    ['North Atlantic', 'atlantic'], ['Ballistic missile status', 'missiles'], ['Force status & stats', 'stats'], ['Comms log', 'log'],
  ];
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Display',
      submenu: [
        ...presets.map(([label, preset]) => ({
          label: `New window: ${label}`,
          click: () => createWindow(lastLink(), { preset }),
        })),
        { type: 'separator' },
        { label: 'Fill all monitors', accelerator: 'CmdOrCtrl+Shift+M', click: () => openAllDisplays() },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let currentLink = pendingLink;
function lastLink() {
  return currentLink;
}

ipcMain.handle('wall:new-window', (_e, preset) => {
  createWindow(lastLink(), { preset: String(preset ?? 'world') });
});
// One fullscreen window per connected monitor, each showing a different preset.
const MONITOR_ORDER = ['wall', 'conus', 'missiles', 'stats', 'world', 'europe', 'eurasia', 'polar'];
function openAllDisplays() {
  const displays = screen.getAllDisplays();
  for (const w of [...windows]) w.close();
  displays.forEach((d, i) => {
    const win = createWindow(lastLink(), { preset: MONITOR_ORDER[i % MONITOR_ORDER.length] });
    win.setBounds(d.bounds);
    win.setFullScreen(true);
  });
  return displays.length;
}
ipcMain.handle('wall:all-displays', () => openAllDisplays());
ipcMain.handle('wall:set-link', (_e, link) => {
  currentLink = String(link);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = findLink(argv);
    if (link) {
      currentLink = link;
      createWindow(link);
    } else {
      const w = [...windows][0];
      if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
    }
  });
  app.on('open-url', (e, url) => {
    e.preventDefault();
    currentLink = url;
    if (app.isReady()) createWindow(url);
    else pendingLink = url;
  });

  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const { pathname } = new URL(req.url);
      const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
      if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    if (process.defaultApp) {
      app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(__dirname)]);
    } else {
      app.setAsDefaultProtocolClient(SCHEME);
    }
    buildMenu();
    if (process.argv.includes('--all-monitors')) openAllDisplays();
    else createWindow(pendingLink, { preset: (process.argv.find((a) => a.startsWith('--preset=')) || '').slice(9) || undefined });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(lastLink());
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
