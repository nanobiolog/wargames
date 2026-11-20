// Regenerates the command reference in README.md from the shared command table.
//   npm run docs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '@coldlaunch/shared';

const readme = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'README.md');
const where: Record<string, string> = { game: 'both', console: 'both', tui: 'terminal', gui: 'display' };
const esc = (t: string) => t.replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let md = '';
for (const g of ['ORDERS', 'MAP', 'INFO', 'SESSION'] as const) {
  md += `\n**${g[0] + g.slice(1).toLowerCase()}**\n\n| command | what it does | example | where |\n|---|---|---|---|\n`;
  for (const c of COMMANDS.filter((x) => x.group === g)) {
    const detail = c.details ? `${c.summary}. ${c.details}` : c.summary;
    md += `| \`${esc(c.syntax)}\`${c.aliases?.length ? `<br>alias: ${c.aliases.map((a) => `\`${esc(a)}\``).join(', ')}` : ''} | ${esc(detail)} | ${c.examples.map((e) => `\`${esc(e)}\``).join('<br>')} | ${where[c.scope]} |\n`;
  }
}
const src = readFileSync(readme, 'utf8');
const start = '<!-- commands:start -->', end = '<!-- commands:end -->';
if (!src.includes(start)) throw new Error('README is missing the commands markers');
writeFileSync(readme, src.replace(new RegExp(`${start}[\\s\\S]*${end}`), `${start}\n${md}\n${end}`));
console.log('README command reference updated');
