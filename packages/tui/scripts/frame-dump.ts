import { Game } from '@coldlaunch/engine';
import { MapView } from '../src/mapview.ts';
import { Screen } from '../src/screen.ts';
const g = new Game(1);
for (let i = 0; i < 50; i++) g.step();
(process.stdout as any).columns = Number(process.argv[2] ?? 140); (process.stdout as any).rows = Number(process.argv[3] ?? 40);
const scr = new Screen();
const m = new MapView();
m.setSize(scr.w, scr.h);
const view = process.argv[4] ?? 'world';
if (view === 'gf') m.centerOn(47.95, -97.4, 40);
if (view === 'polar') { m.proj = 'polar'; m.centerOn(90, 0, 1); }
if (view === 'conus') m.centerOn(39, -97, 3.2);
m.render(scr, 0, 0, { snap: g.snapshot('USA'), world: g.staticWorld(), side: 'USA', selected: view === 'gf' ? 'icbm-grandforks' : null });
for (let y = 0; y < scr.h; y++) console.log(scr.ch.slice(y * scr.w, (y + 1) * scr.w).join(''));
