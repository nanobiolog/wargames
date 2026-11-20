// Renders one real terminal-console frame from a running session to an HTML file (for README screenshots).
//   npx tsx packages/tui/scripts/screenshot-html.ts <link> <out.html> [cols] [rows]
import { writeFileSync } from 'node:fs';
import { GameClient } from '@coldlaunch/shared';
const [link, out, cols = '170', rows = '50'] = process.argv.slice(2);
(process.stdout as any).columns = +cols;
(process.stdout as any).rows = +rows;
const { TuiApp } = await import('../src/app.ts');
const client = new GameClient('tui');
await client.connect(link);
await new Promise((r) => setTimeout(r, 1500));
const app = new TuiApp(client) as any;
for (const e of client.events.slice(-40)) app.pushEvent(e);
app.scr.flush = () => {};
app.input = 'launch icbm-warren at tatishchevo x 3';
app.cursor = app.input.length;
app.render();
const scr = app.scr;
// Draw cells on a canvas: braille cells as real dots (fonts rarely have monospace braille), text with Menlo.
const cells: [string, string, number][] = [];
for (let k = 0; k < scr.w * scr.h; k++) {
  const [r, g, b] = scr.fg[k], [br, bg, bb] = scr.bg[k];
  cells.push([scr.ch[k], `${r},${g},${b}|${br},${bg},${bb}`, scr.bold[k]]);
}
writeFileSync(out, `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">
<canvas id="c"></canvas><script>
const W=${scr.w},H=${scr.h},CW=8,CH=16,cells=${JSON.stringify(cells)};
const c=document.getElementById('c');const d=2;c.width=(W*CW+28)*d;c.height=(H*CH+28)*d;c.style.width=(W*CW+28)+'px';
const x=c.getContext('2d');x.scale(d,d);x.fillStyle='#000';x.fillRect(0,0,W*CW+28,H*CH+28);x.translate(14,14);
x.textBaseline='top';
const B=[[0x01,0x08],[0x02,0x10],[0x04,0x20],[0x40,0x80]];
cells.forEach(([ch,col,bold],k)=>{const cx=(k%W)*CW,cy=Math.floor(k/W)*CH;const [fg,bg]=col.split('|');
 if(bg!=='0,0,0'){x.fillStyle='rgb('+bg+')';x.fillRect(cx,cy,CW,CH);}
 const code=ch.charCodeAt(0);x.fillStyle='rgb('+fg+')';
 if(code>=0x2800&&code<=0x28ff){const m=code-0x2800;x.shadowColor='rgb('+fg+')';x.shadowBlur=3;
  for(let r=0;r<4;r++)for(let q=0;q<2;q++)if(m&B[r][q]){x.beginPath();x.arc(cx+2+q*4,cy+2+r*4,1.15,0,6.3);x.fill();}
  x.shadowBlur=0;}
 else if(ch!==' '){x.font=(bold?'bold ':'')+'13px Menlo, monospace';x.fillText(ch,cx,cy+1);}
});
</script></body>`);
client.close();
process.exit(0);
