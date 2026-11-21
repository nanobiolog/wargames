# COLD LAUNCH — roadmap

Status as of 21 Nov 2026. Section 1 is built and tested. Section 2 is partly built (marked ✅). Sections 3–7 are the plan.

---

## 1. Shipped in this change

### 1.1 Online matches on Cloudflare (`packages/cloud`)

```
 browser / phone / terminal ──wss──►  Worker (edge)  ──►  MatchRoom Durable Object (one per match code)
                                       │                    ├─ authoritative Game, 10 Hz while live
                                       │                    ├─ doctrine AI (no key)
                                       │                    ├─ LLM calls relayed to a screen holding the player's own key
                                       │                    └─ state in SQLite storage, hibernates when idle
                                       ├─►  Inbox DO (one per friend tag): live invites
                                       └─►  static assets: the web wall display
```

* **Same TypeScript engine** runs in Node (local play) and in the Durable Object (`@coldlaunch/engine/core`, no Node APIs).
* **Hibernation.** The tick timer runs only while someone is connected and the clock is running. Paused, finished and empty matches stop the timer. WebSockets stay open and cost no duration. Clients send a heartbeat every 20 s only while the clock runs, which keeps the Durable Object's CPU allowance topped up. An empty match deletes itself after 24 h.
* **Short codes.** Matches and friend tags use 5 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, so there are no 0/O/1/I/L to confuse. That gives 28.6M combinations, and collisions are retried. Share link: `https://<host>/m/K7M2Q`.
* **Identity.** Each player has a callsign (their own or a random `RAVEN-42`), a random player id, and a friend tag, all kept in the browser or in `~/.coldlaunch/identity.json`. Screens with the same player id share a side, so one commander can use several tabs, monitors or a phone at once.
* **Seats.** A seat belongs to the player id that holds it. A second person asking for a taken seat gets the free side, or becomes a spectator. In human-vs-human games a seated player can't also open an all-seeing spectator view.
* **Spectators** see both sides and can't give orders. TV wall: `/m/CODE?role=SPECTATOR&preset=wall`.
* **AI keys never reach our servers.**
  * In the browser, keys live in localStorage, or sessionStorage for "this tab only". A cookie would be sent to the game server on every request, so cookies aren't used.
  * Requests go from the browser straight to the provider, using the official SDK with `dangerouslyAllowBrowser`.
  * A terminal that joins an online match uses the key saved by `npm run setup`.
  * When a phone sends a plain-English order, the Durable Object builds the prompt and sends it as an `aiJob` to a screen of that side that holds a key (for example your PC). The plan comes back to the phone for confirmation.
* **Friends.** Add a friend's tag, see whether they're online, and invite them to your match. Invites to offline friends are kept for 10 minutes.

### 1.2 Performance: profiled first, ported nothing

`npm run profile` plays full rules-vs-rules games headless. It times every engine phase, snapshot and JSON per role, type-ahead, and ship routing.

| path | before | after |
|---|---|---|
| `step()` whole tick, p99 | 0.86 ms | 1.3 ms (now includes routing slices) |
| `nav.route` one ocean route, mean / p99 / max | 128 / 586 / 1000 ms (**ran inside `apply()`**) | 47 / 204 / 298 ms of work, but sliced |
| player `move` command latency, p99 | up to 1 s | **0.5 ms** |
| tick while a route is being computed, p99 / max | n/a | 14 / 24 ms |
| string-pulling of a found route, max | 87 ms | 7 ms |
| snapshot + JSON per client per 5 Hz frame | ~0.35 ms | shared once per role |

What changed:

* A* now reuses its buffers with generation stamps instead of allocating 1M-cell arrays per route.
* Step costs use per-row trig tables.
* The heap uses typed arrays.
* The heuristic has a mild 1.2 weight.
* String-pulling is linear (gallop plus binary search) instead of O(n²).
* `move` replies at once ("PLOTTING COURSE"). The search runs in **8 000-cell slices per tick**, counted in cells rather than milliseconds, so every machine finishes on the same tick. Saves taken mid-search resume to the identical state hash (tested).

**WASM decision:** no port. The only real hotspot was algorithmic (allocation, O(n²) string-pulling) and blocking (it ran inside the command path). Both are fixed in TypeScript. A Rust A* might expand cells 2–4× faster, but slicing already keeps every tick under 25 ms. Port only if the modern scenario's larger maps put `nav.expand` back above ~10 ms per tick, and keep `RouteJob.run(budget)` as the interface around it.

### 1.3 Latency budget (measured locally on workerd)

| what | budget | measured |
|---|---|---|
| player command round-trip | < 100 ms + network RTT | p50 2.6–4.6 ms, p95 5.8–15.8 ms |
| ship order reply | < 100 ms | 3.6–8.4 ms |
| engine tick | < 10 ms p99 | 1.3 ms (14 ms while routing) |
| AI calls | never block the tick | always async; on failure or timeout (45 s) the doctrine AI covers |

A Durable Object is placed near whoever created it, so friends on other continents add their RTT. Next: a location hint chosen from the players' regions when a match is created.

---

## 2. Modern multipolar scenario (next big piece)

Goal: a second scenario, chosen in the lobby, where 2–8 players (or AIs) each command one or more countries in a present-day crisis, alongside the classic 1983 two-player game.

### 2.1 Engine generalisation (prerequisite) ✅ done

Built as described below. Scenario-defined factions and a live relations matrix (attacking a non-hostile nation
makes it hostile). Intel and DEFCON assessments per faction, allies share their picture, end conditions per faction.
1983 stays bit-identical (`cli/src/baseline.ts`). Still open: splitting one faction among several players by branch,
and per-viewport interest management.


`Side = 'USA' | 'USSR'` is hard-coded across the engine, AI, GUI and TUI. Steps:

1. Replace `Side` with `FactionId` (string), and add a scenario-defined `Faction { id, name, colour, countries[], capital, doctrine }`.
2. Make relations a matrix, `stance[a][b] = allied | neutral | hostile`, and let it change during play (alliances, betrayal, neutrality).
3. Intel becomes per faction. Allies optionally share contacts (a "five eyes" style flag).
4. Scores, casualties and DEFCON per faction. Win conditions defined by the scenario (survive, deter, protect allies, control straits).
5. Seats: one player per faction, **or split one faction among several players by branch** (navy / air / rocket forces / intelligence) with a commander who approves launches. This is the "each player directs a country" mode with real teamwork.
6. Interest management: each client gets only what its faction can see within the viewport plus a margin. This also shrinks the 20 KB snapshots.

### 2.2 New systems and units

| system | gameplay | notes |
|---|---|---|
| ✅ **Carrier air wings** | `sortie` recon / CAP / strike from carriers and fighter bases; surface warfare; coastal radar ship tracking; intel summaries and `intel` | built in both scenarios |
| **Reconnaissance satellites** | orbital passes (real ground tracks from simple two-line elements), revisit times, cloud cover; reveal ships and mobile launchers | replaces today's fixed 20-minute satellite pass |
| **Drones** | MALE ISR drones (loiter, spot), loitering munitions (cheap, slow, interceptable) | swarms stress air defence; cost/benefit decisions |
| **Cruise missiles** | ship-, sub-, air- and ground-launched; low-altitude terrain-following paths (reuse ocean/land routing); radar horizon | new `Missile.type = 'CRUISE'` with waypoints |
| **Surface navy** | destroyers and frigates with area air defence, SSGNs, amphibious groups | existing carrier logic generalises |
| **Strategic infrastructure** | ports, air bases, airports, oil refineries, pipelines, chokepoints (Hormuz, Malacca, Suez, Bosphorus, Gibraltar, Taiwan Strait) | an economy layer: fuel and readiness depend on refineries and ports; blockades matter |
| **Cyber / EW (abstract)** | blinding radar, spoofing satellite warnings | builds on the existing false-alarm mechanic |
| **Diplomacy** | hotline to every faction, treaties, sanctions, UN votes as events | keeps the core lesson: restraint scores highest |

Data: use only public, coarse, encyclopedic locations (major ports, well-known bases, large refineries), at Natural Earth / Wikipedia level. No precise or sensitive targeting data. Placement is intentionally approximate and fictionalised where needed.

### 2.3 Delivery order (1, 2 and the 2026 scenario are done)

1. Faction refactor behind the 1983 scenario, kept bit-identical (determinism tests guard this).
2. Scenario file format (JSON) plus a "modern 2026" scenario with 6 factions.
3. Cruise missiles and surface navy → satellites → drones → infrastructure economy.
4. Lobby: per-faction seats, AI fill-ins, team chat.

---

## 3. Optimisation backlog

* **Delta snapshots.** Send only units whose state changed, plus a full keyframe every 2 s, probably with MessagePack. Expect about 5–10× less bandwidth.
* **Per-viewport interest management** for spectators on big maps.
* **GPU instancing** for unit icons, and render-on-change when the clock is paused (currently capped by the new frame-rate setting).
* **Location hints** for Durable Objects; persist state in SQL rows instead of one blob when the modern map grows.
* Re-run `npm run profile` in CI and fail when p99 tick or command latency regresses.

## 4. UI / UX backlog

* **Web:** first-run tutorial (DEFCON ladder, why restraint scores highest), command palette with the same type-ahead as the terminal, radial context menus on touch, colour-blind palettes, sound design pass, persistent chat panel, replay viewer (the command log is already deterministic, so replays are just seed plus log).
* **Terminal:**
  * `npx coldlaunch` as a single install with no clone.
  * `coldlaunch join K7M2Q` and `coldlaunch new --vs ai`.
  * Callsign and server in `~/.coldlaunch/identity.json` (done), and a lobby screen in the TUI.
* **Multi-screen:** "cast this view" (pick a preset for another tab or device from the main screen), saved wall layouts per user.

---

## 5. Monetisation

Principles: never pay-to-win; the full classic game and doctrine AI stay free; bring-your-own-key AI stays free. The theme is nuclear war, so stay with stores and payment providers that accept mature strategy titles, and avoid ad networks.

| offer | price (start) | why |
|---|---|---|
| **Free**: classic 1983, doctrine AI, BYOK AI, online with friends, spectators | €0 | growth and word of mouth |
| **Commander pass** (subscription) | €4.99/month or €39/year | hosted AI opponents and advisor without your own key (with a monthly token allowance), ranked matchmaking, cloud replays, private leagues, early scenarios |
| **Scenario packs** (one-time) | €4.99–9.99 | modern multipolar, historical crises (Able Archer variants, Cuba 1962 what-ifs), user-made scenarios with revenue share later |
| **Cosmetics** | €1.99–4.99 | CRT colour themes, war-room wall layouts, terminal skins, sound packs |
| **Steam / desktop edition** (Electron) | €14.99 one-time | includes the first scenario pack; Steam audience pays up front for strategy |
| **Education / institutions** | quote | classroom licence (history, international relations) with instructor dashboard and debriefs |

Implementation: [Paddle](https://www.paddle.com) as merchant of record (handles VAT and sales tax worldwide), with entitlements stored per player id in D1. Hosted-AI cost control: Claude Haiku 5.5 at about $0.10/$0.50 per 1M tokens is roughly $0.002 per opponent decision. Cap tokens per pass per month and degrade to doctrine AI when the cap is reached.

## 6. Marketing

**Positioning:** "The Cold War command bunker on your desk: a glowing vector war room on every screen you own, orders from your terminal, and AI opponents that answer the hotline. The best score is zero casualties."

| phase | actions |
|---|---|
| **Pre-launch (4–6 weeks)** | landing page with a live spectator match in the hero, wishlist / email list; devlog posts (the "route a carrier around Africa without dropping a frame" story is a great technical post); Discord server |
| **Launch** | Show HN (terminal + MCP + Cloudflare Durable Objects angle); r/WebGames, r/commandline, r/gamedev, r/wargaming, r/coldwar; Product Hunt; itch.io page |
| **Content loop** | 15–30 s vertical clips of missile arcs and the war-room wall (TikTok / Shorts / Reels); an "AI vs AI: will Claude launch?" stream series; weekly community challenges ("defuse the crisis in under 2 h game time") |
| **Creators** | send keys and private-league invites to strategy and grand-strategy YouTubers and streamers; make spectator mode broadcast-friendly (clean TV preset, delay option) |
| **Steam** | Next Fest demo (classic scenario), launch with the modern scenario pack |
| **Education** | outreach to history and IR teachers; a free classroom mode is the wedge |

Metrics: day-1/day-7 retention, matches per player per week, share-link → join conversion, % of matches with a friend, free → Commander pass conversion (target 2–4%), hosted-AI cost per paying user.

## 7. Deploying the online server

Live: **https://coldlaunch.nano-carbay.workers.dev** (Workers Free plan, deployed 21 Nov 2026). On Free, `limits.cpu_ms` can't be set; a 120 s soak test (`scripts/soak.ts`) held exactly ×10 game speed with no resets. On the Paid plan, uncomment `cpu_ms` in `wrangler.jsonc` for long matches and more headroom.

```bash
npm run cloud:dev      # local: http://127.0.0.1:8787 (Worker + Durable Objects + web display)
npm run cloud:deploy   # builds the web display and deploys to your Cloudflare account
npm run smoke -w @coldlaunch/cloud -- https://<your-worker-host>   # end-to-end check
```

Then set `"server": "https://<your-worker-host>"` in `~/.coldlaunch/config.json`, or export `COLDLAUNCH_SERVER`, so `npm start -- --join K7M2Q` works from any terminal. Before a public launch, add Turnstile and a rate limit on `POST /api/match` and `/api/invite`.
