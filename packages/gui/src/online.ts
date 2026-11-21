// Online play in the browser: identity (callsign + friend tag), lobby (create / join by 5-char code),
// start-game options, friend invites, the match bar, settings (graphics, identity, AI keys) and the
// AI runner that answers `aiJob`s with the player's own key.
//
// AI keys never go to the game server. They live in this browser (localStorage when "remember on
// this device" is ticked, otherwise sessionStorage for this tab only) and are sent only to the
// provider, straight from this device.
import {
  normalizeCode, randomCallsign, cleanCallsign, shortCode, makeMatchLink,
  type AiJob, type GameClient, type RosterEntry, type Side,
} from '@coldlaunch/shared';
import type { FxSettings } from './gl.ts';

export interface Store {
  get<T>(k: string, d: T): T;
  set(k: string, v: unknown): void;
}

export interface Settings {
  quality: 'low' | 'medium' | 'high' | 'ultra';
  fpsCap: 0 | 30 | 60; // 0 = display refresh rate
  dprCap: number; // max device-pixel ratio rendered
  reduceMotion: boolean;
  aiModel: string; // provider:model used for this browser's AI work
}

export const QUALITY: Record<Settings['quality'], { fx: Partial<FxSettings>; dpr: number; fps: Settings['fpsCap']; label: string }> = {
  low: { fx: { bloom: 0, persistence: 0.5, scanlines: 0 }, dpr: 1, fps: 30, label: 'Low — laptops on battery, old phones' },
  medium: { fx: { bloom: 0.35, persistence: 0.75, scanlines: 0.15 }, dpr: 1.5, fps: 60, label: 'Medium — most machines' },
  high: { fx: { bloom: 0.55, persistence: 0.8, scanlines: 0.3 }, dpr: 2, fps: 60, label: 'High — default look' },
  ultra: { fx: { bloom: 0.9, persistence: 0.88, scanlines: 0.35 }, dpr: 3, fps: 0, label: 'Ultra — big wall displays' },
};

export const DEFAULT_SETTINGS: Settings = { quality: 'high', fpsCap: 60, dprCap: 2, reduceMotion: false, aiModel: 'claude:claude-haiku-5-5' };

interface Identity {
  player: string; // random, stable per browser
  name: string; // callsign
  tag: string; // 5-char friend tag
}

interface Friend {
  tag: string;
  name: string;
}

interface Keys {
  anthropic?: string;
  gemini?: string;
}

export interface OnlineHost {
  client: GameClient;
  store: Store;
  fx: FxSettings;
  settings: Settings;
  applySettings(): void;
  connect(link: string): Promise<void> | void;
  toast(msg: string, cls?: string): void;
  showLocalConnect(msg: string): void;
}

const h = (tag: string, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const AI_MODELS: [string, string][] = [
  ['claude:claude-haiku-5-5', 'Claude Haiku 5.5 — cheapest, fast ($0.10 / $0.50 per 1M tokens)'],
  ['claude:claude-sonnet-5-5', 'Claude Sonnet 5.5 — balanced ($2 / $10)'],
  ['claude:claude-opus-5-5', 'Claude Opus 5.5 — strongest strategist ($4 / $20)'],
  ['gemini:gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite — cheapest Gemini ($0.25 / $1.50)'],
  ['gemini:gemini-4-hydrogen', 'Gemini 4 Hydrogen — strongest Gemini listed ($1.50 / $7.50)'],
];

export class Online {
  /** true when this page is served by the online (Cloudflare) server */
  available = false;
  id: Identity;
  private friends: Friend[];
  private online: Record<string, boolean> = {};
  private lobby: HTMLElement;
  private settingsBox: HTMLElement;
  private bar: HTMLElement;
  private inbox?: WebSocket;
  private usage = { calls: 0, inTok: 0, outTok: 0, cost: 0 };
  private hb = 0;

  constructor(private root: HTMLElement, private host: OnlineHost) {
    const st = host.store;
    const saved = st.get<Partial<Identity>>('identity', {});
    this.id = {
      player: saved.player ?? `p-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
      name: cleanCallsign(saved.name) ?? randomCallsign(),
      tag: saved.tag && /^[2-9A-Z]{5}$/.test(saved.tag) ? saved.tag : shortCode(),
    };
    st.set('identity', this.id);
    this.friends = st.get<Friend[]>('friends', []);
    this.lobby = h('div', 'lobby hidden');
    this.settingsBox = h('div', 'settings hidden');
    this.bar = h('div', 'matchbar hidden');
    root.append(this.lobby, this.settingsBox, this.bar);
    this.applyIdentity();

    const c = host.client;
    c.on('aiJob', (job) => void this.runJob(job));
    c.on('roster', (r) => this.renderBar(r));
    c.on('chat', (m) => host.toast(`${m.from} (${m.role}): ${m.text}`, 'hot'));
    c.on('welcome', () => { this.renderBar(c.roster); this.lobby.classList.add('hidden'); });
    // Heartbeat while the clock runs: keeps the match's Durable Object topped up on CPU between
    // orders. Paused or finished matches send nothing, so they can hibernate.
    this.hb = window.setInterval(() => {
      const s = c.snap;
      if (c.connected && c.match && s && !s.paused && !s.over) c.ping();
    }, 20_000);
  }

  /** Probe the server: the online server answers /api/health, the local Node server doesn't. */
  async detect(): Promise<boolean> {
    if (!location.protocol.startsWith('http')) return false;
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      this.available = r.ok && (await r.json()).ok === true;
    } catch { this.available = false; }
    if (this.available) this.openInbox();
    return this.available;
  }

  // ------------------------------------------------------------------ identity & keys

  private applyIdentity() {
    this.host.client.identity = { name: this.id.name, player: this.id.player, tag: this.id.tag, caps: this.hasKey() ? ['ai'] : [] };
  }

  private keys(): Keys {
    const read = (k: string) => sessionStorage.getItem(`cl:key:${k}`) ?? localStorage.getItem(`cl:key:${k}`) ?? undefined;
    return { anthropic: read('anthropic'), gemini: read('gemini') };
  }

  private saveKey(k: 'anthropic' | 'gemini', v: string, remember: boolean) {
    localStorage.removeItem(`cl:key:${k}`);
    sessionStorage.removeItem(`cl:key:${k}`);
    if (v) (remember ? localStorage : sessionStorage).setItem(`cl:key:${k}`, v);
  }

  hasKey(): boolean {
    const k = this.keys();
    return this.host.settings.aiModel.startsWith('claude') ? !!k.anthropic : !!k.gemini;
  }

  /** Re-announce capabilities after identity or keys change (reconnects quietly when in a match). */
  private refreshSession() {
    this.applyIdentity();
    const c = this.host.client;
    if (c.connected && c.match && c.link) { c.close(); void this.host.connect(c.link); }
  }

  // ------------------------------------------------------------------ AI jobs (player's own key)

  private async runJob(job: AiJob) {
    const c = this.host.client;
    const spec = job.model || this.host.settings.aiModel;
    try {
      const { browserProvider, describeAiError } = await import('@coldlaunch/ai/browser');
      const p = browserProvider(spec, this.keys());
      if (typeof p === 'string') return c.aiResult({ t: 'aiResult', id: job.id, error: p });
      try {
        const r = await p.decide(job.system, job.user, job.tools as never);
        this.usage.calls++;
        this.usage.inTok += r.inTok;
        this.usage.outTok += r.outTok;
        if (p.price) this.usage.cost += (r.inTok * p.price[0] + r.outTok * p.price[1]) / 1e6;
        c.aiResult({ t: 'aiResult', id: job.id, calls: r.calls.slice(0, 16), text: r.text.slice(0, 4000), inTok: r.inTok, outTok: r.outTok });
      } catch (e) {
        c.aiResult({ t: 'aiResult', id: job.id, error: describeAiError(e, p.provider).slice(0, 400) });
      }
    } catch (e) {
      c.aiResult({ t: 'aiResult', id: job.id, error: `AI module failed to load: ${(e as Error).message}`.slice(0, 400) });
    }
  }

  // ------------------------------------------------------------------ lobby

  showLobby(note = '') {
    const L = this.lobby;
    const pending = new URLSearchParams(location.search).get('m');
    L.innerHTML = `
      <div class="ph">STRATCOM // COLD LAUNCH</div>
      ${note ? `<p class="note">${esc(note)}</p>` : ''}
      <div class="sec">
        <div class="lbl">YOUR CALLSIGN</div>
        <div class="line"><input class="callsign" maxlength="20" value="${esc(this.id.name)}"><button class="dice" title="Random callsign">⚄</button></div>
        <div class="tagline">Friend tag <b class="tag">${this.id.tag}</b> <button class="small copytag">COPY</button> — friends add this to invite you.</div>
      </div>
      <div class="cols">
        <div class="sec">
          <div class="lbl">JOIN A MATCH</div>
          <div class="line"><input class="code" maxlength="6" placeholder="K7M2Q" value="${esc(pending ?? '')}" autocapitalize="characters" autocomplete="off"></div>
          <div class="line">
            <select class="joinrole"><option value="">Any free seat</option><option>USA</option><option>USSR</option><option value="SPECTATOR">Watch (spectator)</option></select>
            <button class="big join">JOIN</button>
          </div>
          <p class="hint">Use the same callsign on your phone, a second monitor or another tab to command the same side on several screens.</p>
        </div>
        <div class="sec">
          <div class="lbl">NEW MATCH</div>
          <label class="row">Scenario <select class="scenario">
            <option value="1983">1983 — USA vs USSR (classic)</option>
            <option value="modern" disabled>Modern multipolar — coming soon</option>
          </select></label>
          <label class="row">You command <select class="side"><option>USA</option><option>USSR</option></select></label>
          <label class="row">Opponent <select class="opp">
            <option value="human">A friend (share the code)</option>
            <option value="rules">Doctrine AI (free, offline rules)</option>
            <option value="byok">LLM AI with your own key</option>
          </select></label>
          <label class="row temp">Temperament <input type="range" class="pers" min="0" max="1" step="0.05" value="0.5"><span class="persv">balanced</span></label>
          <label class="row">Time compression <select class="speed"><option value="5">x5</option><option value="10" selected>x10</option><option value="20">x20</option><option value="30">x30</option></select></label>
          <button class="big create">CREATE MATCH</button>
        </div>
      </div>
      <div class="sec friends"></div>
      <div class="foot"><button class="small settingsbtn">SETTINGS</button> <button class="small local">LOCAL SESSION LINK…</button></div>`;
    const q = <T extends HTMLElement>(s: string) => L.querySelector(s) as T;
    const cs = q<HTMLInputElement>('.callsign');
    const saveName = () => {
      const n = cleanCallsign(cs.value);
      if (n) { this.id.name = n; this.host.store.set('identity', this.id); this.applyIdentity(); }
      cs.value = this.id.name;
    };
    cs.onchange = saveName;
    q<HTMLButtonElement>('.dice').onclick = () => { cs.value = randomCallsign(); saveName(); };
    q<HTMLButtonElement>('.copytag').onclick = () => void navigator.clipboard?.writeText(this.id.tag).then(() => this.host.toast('FRIEND TAG COPIED'));
    const pers = q<HTMLInputElement>('.pers');
    const persv = q<HTMLElement>('.persv');
    pers.oninput = () => { const v = +pers.value; persv.textContent = v < 0.3 ? 'dove' : v > 0.7 ? 'hawk' : 'balanced'; };
    const opp = q<HTMLSelectElement>('.opp');
    const syncOpp = () => q<HTMLElement>('.temp').classList.toggle('hidden', opp.value === 'human');
    opp.onchange = () => {
      syncOpp();
      if (opp.value === 'byok' && !this.hasKey()) this.host.toast('ADD YOUR AI KEY IN SETTINGS FIRST — IT STAYS IN THIS BROWSER', 'bad');
    };
    syncOpp();
    const join = () => {
      saveName();
      const code = normalizeCode(q<HTMLInputElement>('.code').value);
      if (!code) return this.host.toast('MATCH CODES ARE 5 CHARACTERS, E.G. K7M2Q', 'bad');
      const role = q<HTMLSelectElement>('.joinrole').value as Side | 'SPECTATOR' | '';
      void this.join(code, role || undefined);
    };
    q<HTMLButtonElement>('.join').onclick = join;
    q<HTMLInputElement>('.code').onkeydown = (e) => { if (e.key === 'Enter') join(); };
    q<HTMLButtonElement>('.create').onclick = async () => {
      saveName();
      if (opp.value === 'byok' && !this.hasKey()) { this.openSettings('ai'); return; }
      const res = await fetch('/api/match', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ opponent: opp.value, side: q<HTMLSelectElement>('.side').value, speed: +q<HTMLSelectElement>('.speed').value, personality: +pers.value, name: this.id.name }),
      });
      const m = (await res.json()) as { code?: string; error?: string };
      if (!m.code) return this.host.toast(`COULD NOT CREATE MATCH: ${m.error ?? res.status}`, 'bad');
      this.host.toast(`MATCH ${m.code} CREATED — SHARE THE CODE`, 'hot');
      void this.join(m.code, q<HTMLSelectElement>('.side').value as Side);
    };
    q<HTMLButtonElement>('.settingsbtn').onclick = () => this.openSettings();
    q<HTMLButtonElement>('.local').onclick = () => { L.classList.add('hidden'); this.host.showLocalConnect('Paste the session link printed in your terminal.'); };
    this.renderFriends();
    L.classList.remove('hidden');
    void this.pollFriends();
  }

  async join(code: string, role?: Side | 'SPECTATOR') {
    this.applyIdentity();
    const link = makeMatchLink(location.origin, code, role);
    const url = new URL(location.href);
    url.searchParams.set('m', code);
    if (role) url.searchParams.set('role', role); else url.searchParams.delete('role');
    history.replaceState(null, '', url);
    await this.host.connect(link);
  }

  // ------------------------------------------------------------------ friends & invites

  private renderFriends() {
    const box = this.lobby.querySelector('.friends') as HTMLElement | null;
    if (!box) return;
    const inMatch = this.host.client.match?.code;
    box.innerHTML = `<div class="lbl">FRIENDS</div>`;
    if (!this.friends.length) box.append(h('p', 'hint', 'No friends yet. Add a friend tag below; they see your invites live.'));
    for (const f of this.friends) {
      const row = h('div', 'friend');
      row.innerHTML = `<span class="dot ${this.online[f.tag] ? 'on' : ''}"></span><b>${esc(f.name)}</b> <span class="tag">${f.tag}</span>`;
      if (inMatch) {
        const b = h('button', 'small', 'INVITE');
        b.onclick = () => void this.invite(f.tag);
        row.append(b);
      }
      const x = h('button', 'small', '×');
      x.title = 'Remove';
      x.onclick = () => { this.friends = this.friends.filter((g) => g.tag !== f.tag); this.host.store.set('friends', this.friends); this.renderFriends(); };
      row.append(x);
      box.append(row);
    }
    const add = h('div', 'line');
    add.innerHTML = `<input class="ftag" maxlength="5" placeholder="TAG"><input class="fname" maxlength="20" placeholder="name (optional)"><button class="small">ADD</button>`;
    (add.querySelector('button') as HTMLButtonElement).onclick = () => {
      const tag = normalizeCode((add.querySelector('.ftag') as HTMLInputElement).value);
      if (!tag || tag === this.id.tag) return this.host.toast('FRIEND TAGS ARE 5 CHARACTERS', 'bad');
      const name = cleanCallsign((add.querySelector('.fname') as HTMLInputElement).value) ?? tag;
      this.friends = [...this.friends.filter((f) => f.tag !== tag), { tag, name }];
      this.host.store.set('friends', this.friends);
      this.renderFriends();
      void this.pollFriends();
    };
    box.append(add);
  }

  private async pollFriends() {
    if (!this.available || !this.friends.length) return;
    try {
      this.online = await fetch(`/api/friends?tags=${this.friends.map((f) => f.tag).join(',')}`).then((r) => r.json());
      this.renderFriends();
    } catch { /* offline */ }
  }

  async invite(tag: string) {
    const code = this.host.client.match?.code;
    if (!code) return;
    const r = await fetch(`/api/invite/${tag}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, from: this.id.name, fromTag: this.id.tag }),
    }).then((x) => x.json()).catch(() => ({ ok: false })) as { ok: boolean; online?: boolean };
    this.host.toast(r.ok ? (r.online ? 'INVITE SENT' : 'INVITE QUEUED — THEY ARE OFFLINE (KEPT 10 MIN)') : 'INVITE FAILED', r.ok ? 'hot' : 'bad');
  }

  private openInbox() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/inbox/${this.id.tag}/ws`);
    this.inbox = ws;
    const ping = window.setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 60_000);
    ws.onmessage = (ev) => {
      if (ev.data === 'pong') return;
      try {
        const m = JSON.parse(String(ev.data)) as { t: string; invite?: { from: string; code: string } };
        if (m.t === 'invite' && m.invite) this.showInvite(m.invite.from, m.invite.code);
      } catch { /* ignore */ }
    };
    ws.onclose = () => { clearInterval(ping); window.setTimeout(() => this.openInbox(), 5000 + Math.random() * 5000); };
  }

  private showInvite(from: string, code: string) {
    const box = h('div', 'invite');
    box.innerHTML = `<b>${esc(from)}</b> invites you to match <b>${esc(code)}</b> `;
    const yes = h('button', 'small', 'JOIN');
    yes.onclick = () => { box.remove(); void this.join(code); };
    const no = h('button', 'small', 'LATER');
    no.onclick = () => box.remove();
    box.append(yes, no);
    this.root.append(box);
    window.setTimeout(() => box.remove(), 60_000);
  }

  // ------------------------------------------------------------------ match bar

  private renderBar(roster: RosterEntry[]) {
    const c = this.host.client;
    if (!c.match) { this.bar.classList.add('hidden'); return; }
    const by = (r: string) => roster.filter((p) => p.role === r);
    const names = (r: string) => [...new Set(by(r).map((p) => p.name))].join(', ') || '—';
    const watching = by('SPECTATOR').length;
    this.bar.innerHTML = `<b class="code" title="Click to copy the match link">MATCH ${c.match.code}</b>
      <span class="usa">USA ${esc(names('USA'))}</span> <span class="ussr">USSR ${esc(names('USSR'))}</span>
      ${watching ? `<span>· ${watching} watching</span>` : ''} <span class="you">you: ${esc(c.role ?? '')}</span>`;
    const code = this.bar.querySelector('.code') as HTMLElement;
    code.onclick = () => void navigator.clipboard?.writeText(makeMatchLink(location.origin, c.match!.code)).then(() => this.host.toast('MATCH LINK COPIED'));
    const chat = h('input', 'chat') as HTMLInputElement;
    chat.placeholder = 'chat…';
    chat.maxLength = 300;
    chat.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' && chat.value.trim()) { c.chat(chat.value.trim()); chat.value = ''; } };
    const inv = h('button', 'small', 'INVITE');
    inv.onclick = () => { this.showLobby(); };
    this.bar.append(chat, inv);
    this.bar.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ settings

  openSettings(tab: 'graphics' | 'player' | 'ai' = 'graphics') {
    const S = this.settingsBox;
    const s = this.host.settings;
    const k = this.keys();
    const remembered = !!(localStorage.getItem('cl:key:anthropic') || localStorage.getItem('cl:key:gemini'));
    const mask = (v?: string) => (v ? `${v.slice(0, 7)}…${v.slice(-4)}` : 'not set');
    S.innerHTML = `
      <div class="ph">SETTINGS <button class="small close">×</button></div>
      <div class="tabs"><button data-t="graphics">GRAPHICS</button><button data-t="player">PLAYER</button><button data-t="ai">AI KEYS</button></div>
      <div class="tab graphics">
        <label class="row">Quality <select class="quality">${Object.entries(QUALITY).map(([q, v]) => `<option value="${q}" ${q === s.quality ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
        <label class="row">Frame-rate cap <select class="fps"><option value="30">30 fps (saves battery)</option><option value="60">60 fps</option><option value="0">Display refresh rate</option></select></label>
        <label class="row">Resolution <select class="dpr"><option value="1">Standard (fastest)</option><option value="1.5">Sharp</option><option value="2">Retina</option><option value="3">Native 4K/5K</option></select></label>
        <label class="row"><input type="checkbox" class="rm" ${s.reduceMotion ? 'checked' : ''}> Reduce motion (no camera fly-overs or phosphor trails)</label>
        <p class="hint">The map is drawn once into GPU buffers and only moving tracks are redrawn each frame; drawing pauses when the tab is hidden. Lower settings mainly save GPU on 4K screens and phones.</p>
      </div>
      <div class="tab player">
        <label class="row">Callsign <input class="callsign" maxlength="20" value="${esc(this.id.name)}"> <button class="small dice">⚄</button></label>
        <div class="row">Friend tag <b>${this.id.tag}</b> <button class="small newtag">NEW TAG</button></div>
        <p class="hint">Your callsign and tag live in this browser. Use the same callsign on every screen you play from (phone, second monitor): screens with the same player identity share your side.</p>
        <div class="row">Player id <code>${this.id.player.slice(0, 10)}…</code> <button class="small copyid">COPY LINK FOR MY OTHER SCREENS</button></div>
      </div>
      <div class="tab ai">
        <p class="hint"><b>Your keys stay on this device.</b> They are stored in this browser only (not in a cookie, so they are never sent to the game server) and used to call the provider directly from here. Anyone with access to this browser profile can read them — use a key with a spending limit, and clear it on shared computers.</p>
        <label class="row">Model <select class="model">${AI_MODELS.map(([v, l]) => `<option value="${v}" ${v === s.aiModel ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="row">Claude key <input type="password" class="kA" placeholder="${mask(k.anthropic)}" autocomplete="off"></label>
        <label class="row">Gemini key <input type="password" class="kG" placeholder="${mask(k.gemini)}" autocomplete="off"></label>
        <label class="row"><input type="checkbox" class="remember" ${remembered || (!k.anthropic && !k.gemini) ? 'checked' : ''}> Remember on this device (otherwise only for this tab)</label>
        <div class="line"><button class="savekeys">SAVE KEYS</button> <button class="danger clearkeys">CLEAR KEYS</button></div>
        <p class="hint">What uses your key: the advisor (plain-English orders from any of your screens — a phone sends the order, this browser makes the AI call), and an LLM opponent if you start a match against one. When your key plays the opponent, its prompts pass through this browser.</p>
        <p class="usage">This session: ${this.usage.calls} AI calls · ${this.usage.inTok + this.usage.outTok} tokens · ~$${this.usage.cost.toFixed(4)}</p>
      </div>`;
    const q = <T extends HTMLElement>(sel: string) => S.querySelector(sel) as T;
    const show = (t: string) => {
      for (const el of S.querySelectorAll('.tab')) el.classList.toggle('hidden', !el.classList.contains(t));
      for (const b of S.querySelectorAll<HTMLButtonElement>('.tabs button')) b.classList.toggle('active', b.dataset.t === t);
    };
    for (const b of S.querySelectorAll<HTMLButtonElement>('.tabs button')) b.onclick = () => show(b.dataset.t!);
    show(tab);
    q<HTMLButtonElement>('.close').onclick = () => S.classList.add('hidden');
    const save = () => { this.host.store.set('settings', s); this.host.applySettings(); };
    const fps = q<HTMLSelectElement>('.fps'); fps.value = String(s.fpsCap);
    const dpr = q<HTMLSelectElement>('.dpr'); dpr.value = String(s.dprCap);
    q<HTMLSelectElement>('.quality').onchange = (e) => {
      const v = (e.target as HTMLSelectElement).value as Settings['quality'];
      const p = QUALITY[v];
      s.quality = v; s.fpsCap = p.fps; s.dprCap = p.dpr;
      Object.assign(this.host.fx, p.fx);
      fps.value = String(s.fpsCap); dpr.value = String(s.dprCap);
      this.host.store.set('fx2', this.host.fx);
      save();
    };
    fps.onchange = () => { s.fpsCap = +fps.value as Settings['fpsCap']; save(); };
    dpr.onchange = () => { s.dprCap = +dpr.value; save(); };
    q<HTMLInputElement>('.rm').onchange = (e) => { s.reduceMotion = (e.target as HTMLInputElement).checked; save(); };
    const cs = q<HTMLInputElement>('.callsign');
    cs.onchange = () => { const n = cleanCallsign(cs.value); if (n) { this.id.name = n; this.host.store.set('identity', this.id); this.refreshSession(); } cs.value = this.id.name; };
    q<HTMLButtonElement>('.dice').onclick = () => { cs.value = randomCallsign(); cs.onchange?.(new Event('change')); };
    q<HTMLButtonElement>('.newtag').onclick = () => { this.id.tag = shortCode(); this.host.store.set('identity', this.id); this.inbox?.close(); this.openSettings('player'); };
    q<HTMLButtonElement>('.copyid').onclick = () => {
      const c = this.host.client;
      const url = c.match ? `${makeMatchLink(location.origin, c.match.code, c.role === 'SPECTATOR' ? undefined : c.role)}` : location.origin;
      void navigator.clipboard?.writeText(url).then(() => this.host.toast('LINK COPIED — OPEN IT ON YOUR OTHER SCREEN AND USE THE SAME CALLSIGN'));
    };
    q<HTMLSelectElement>('.model').onchange = (e) => { s.aiModel = (e.target as HTMLSelectElement).value; save(); this.refreshSession(); };
    q<HTMLButtonElement>('.savekeys').onclick = () => {
      const remember = q<HTMLInputElement>('.remember').checked;
      const a = q<HTMLInputElement>('.kA').value.trim(), g = q<HTMLInputElement>('.kG').value.trim();
      if (a) this.saveKey('anthropic', a, remember);
      if (g) this.saveKey('gemini', g, remember);
      this.host.toast(a || g ? 'KEYS SAVED IN THIS BROWSER' : 'NOTHING TO SAVE');
      this.refreshSession();
      this.openSettings('ai');
    };
    q<HTMLButtonElement>('.clearkeys').onclick = () => {
      this.saveKey('anthropic', '', false);
      this.saveKey('gemini', '', false);
      this.host.toast('KEYS REMOVED FROM THIS BROWSER');
      this.refreshSession();
      this.openSettings('ai');
    };
    S.classList.remove('hidden');
  }
}
