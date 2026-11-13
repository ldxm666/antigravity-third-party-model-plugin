#!/usr/bin/env node
// Restore the original app.asar from the agy-bridge backup.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const i = args.indexOf('--asar');
const ASAR = i >= 0 && args[i + 1] ? args[i + 1]
  : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'resources', 'app.asar');
const BAK = ASAR + '.agybridge.bak';
if (!fs.existsSync(BAK)) { console.error('no backup at ' + BAK); process.exit(1); }
fs.copyFileSync(BAK, ASAR);
console.log('restored ' + ASAR + ' from backup');
console.log('restart Antigravity to apply.');
