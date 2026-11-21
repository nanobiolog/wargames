// Compact header for phones: side, DEFCON, war clock, tension, inbound, layout tabs and menu.
import { DEFCON_NAMES, type GameClient, type Snapshot } from '@coldlaunch/shared';
import type { PhoneMode } from './wall.ts';

interface HudHost {
  client: GameClient;
  getMode(): PhoneMode;
  setMode(m: PhoneMode): void;
  menu(): void;
  share(): void;
  onResize?(): void;
}

const DEFCON_CLASS: Record<number, string> = { 5: 'd5', 4: 'd4', 3: 'd3', 2: 'd2', 1: 'd1' };

export class PhoneHud {
  el: HTMLElement;
  private stats: HTMLElement;
  private tabs: HTMLButtonElement[] = [];

  constructor(root: HTMLElement, private host: HudHost) {
    this.el = document.createElement('div');
    this.el.className = 'phonehud';
    this.stats = document.createElement('div');
    this.stats.className = 'phstats';
    const tabs = document.createElement('div');
    tabs.className = 'phtabs';
    for (const [m, label] of [['map', 'MAP'], ['split', 'BOTH'], ['console', 'CONSOLE']] as [PhoneMode, string][]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { host.setMode(m); this.syncTabs(); };
      b.dataset.mode = m;
      this.tabs.push(b);
      tabs.append(b);
    }
    const share = document.createElement('button');
    share.textContent = 'QR';
    share.title = 'share with other devices';
    share.onclick = () => host.share();
    const menu = document.createElement('button');
    menu.textContent = '☰';
    menu.className = 'menubtn';
    menu.onclick = () => host.menu();
    tabs.append(share, menu);
    this.el.append(this.stats, tabs);
    root.append(this.el);
    this.syncTabs();
    // the header's height depends on how its buttons wrap; keep the layout in step with it
    new ResizeObserver(() => host.onResize?.()).observe(this.el);
  }

  height() {
    return document.body.classList.contains('phone') ? this.el.getBoundingClientRect().height || 48 : 0;
  }

  private sideStyle(role: string) {
    const f = this.host.client.world?.factions?.find((x) => x.id === role);
    return f ? `color:${f.color};border-color:${f.color}` : '';
  }

  private syncTabs() {
    for (const b of this.tabs) b.classList.toggle('active', b.dataset.mode === this.host.getMode());
  }

  update(s: Snapshot) {
    if (!document.body.classList.contains('phone')) return;
    const role = s.viewer;
    const lvl = role === 'SPECTATOR' ? Math.min(...Object.values(s.defcon)) : s.defcon[role];
    const clock = new Date(s.startEpoch + s.t * 1000).toISOString().slice(11, 16);
    this.stats.innerHTML =
      `<span class="side ${role === 'USSR' ? 'su' : 'us'}" style="${this.sideStyle(role)}">${role === 'SPECTATOR' ? 'OBS' : role}</span>` +
      `<span class="defcon ${DEFCON_CLASS[lvl]}" title="${DEFCON_NAMES[lvl]}">DEFCON ${lvl}</span>` +
      `<span>${clock}Z${s.paused ? ' ⏸' : ` ×${s.speed}`}</span>` +
      `<span class="${s.tension > 70 ? 'red' : ''}">T ${s.tension}</span>` +
      (s.threat.inbound ? `<span class="red blink">▲ ${s.threat.inbound} INBOUND</span>` : '') +
      (s.over ? `<span class="white">${s.over.reason}</span>` : '');
    this.syncTabs();
  }
}
