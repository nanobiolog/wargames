#!/usr/bin/env node
// Launcher: runs the TypeScript CLI through tsx so no build step is needed.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const child = spawn(process.execPath, [tsx, join(root, 'packages/cli/src/main.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
