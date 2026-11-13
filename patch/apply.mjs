#!/usr/bin/env node
// agy-bridge tray patch: adds a "第三方 API 设置" entry to the Antigravity tray menu
// that opens the local config page in a Hub window.
//
// Usage:
//   node apply.mjs [--asar <path>] [--bridge-url <url>] [--dry-run]
//
// Safety: keeps a byte-exact backup at <asar>.agybridge.bak, validates the repacked
// archive before swapping, and never touches app.asar.unpacked.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const patchDir = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const ASAR = arg('asar', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'resources', 'app.asar'));
const BRIDGE = arg('bridge-url', 'http://127.0.0.1:18925/');
const bridgeUrl = new URL(BRIDGE);
if (bridgeUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(bridgeUrl.hostname)
    || bridgeUrl.username || bridgeUrl.password || bridgeUrl.search || bridgeUrl.hash || bridgeUrl.pathname !== '/') {
  throw new Error('--bridge-url must be a loopback HTTP origin');
}
const ENDPOINT = bridgeUrl.origin;
const DRY = args.includes('--dry-run');
const BAK = ASAR + '.agybridge.bak';
const MARKER = 'agy-bridge-settings';
const UNPACK_DIR = 'node_modules/chrome-devtools-mcp';

const say = (m) => console.log(m);

function readHeader(p) {
  const fd = fs.openSync(p, 'r');
  const b = Buffer.alloc(16);
  fs.readSync(fd, b, 0, 16, 0);
  const jsonLen = b.readUInt32LE(12);
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, 16);
  fs.closeSync(fd);
  return JSON.parse(jb.toString('utf8'));
}
function listAll(h) {
  const files = [], unpacked = [];
  (function walk(n, p) {
    for (const [k, v] of Object.entries(n.files || {})) {
      const q = p ? p + '/' + k : k;
      if (v.files) walk(v, q);
      else { files.push(q); if (v.unpacked) unpacked.push(q); }
    }
  })(h, '');
  return { files, unpacked };
}
// Run the CLI through Node directly so paths never pass through cmd.exe.
const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
const npx = (a) => execFileSync(process.execPath, [npxCli, '--yes', '@electron/asar@3.4.1', ...a], {
  stdio: 'pipe', windowsHide: true, maxBuffer: 1 << 28,
});
function packedFile(file, name) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    let entry = readHeader(file);
    for (const part of name.split('/')) entry = entry.files[part];
    const data = Buffer.alloc(entry.size);
    fs.readSync(fd, data, 0, data.length, 8 + head.readUInt32LE(4) + Number(entry.offset));
    return data;
  } finally { fs.closeSync(fd); }
}

if (!fs.existsSync(ASAR)) { console.error('asar not found: ' + ASAR); process.exit(1); }
const before = listAll(readHeader(ASAR));
say(`asar      : ${ASAR}`);
say(`files     : ${before.files.length} (unpacked ${before.unpacked.length})`);
say(`bridge url: ${BRIDGE}`);

// --- already patched? ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agybridge-'));
const extractDir = path.join(tmp, 'extract');
say('\n[1/6] extracting...');
npx(['extract', ASAR, extractDir]);

const mainJs = path.join(extractDir, 'dist', 'main.js');
if (!fs.existsSync(mainJs)) { console.error('dist/main.js missing in archive'); process.exit(1); }
let src = fs.readFileSync(mainJs, 'utf8');
const stripIntegration = value => value.replace(/\n\/\* agy-bridge-host:start \*\/[\s\S]*?\/\* agy-bridge-host:end \*\/\n?/g, '\n');
src = stripIntegration(src);
// drop any previous injection so re-running upgrades an old patch in place
const staleRe = /\n[ \t]*\{\n[ \t]*id: 'agy-bridge-settings',[\s\S]*?\n[ \t]*\},\n(?=[ \t]*\{\n[ \t]*label: 'Quit',)/;
if (staleRe.test(src)) { src = src.replace(staleRe, '\n'); say('      removed previous injection'); }
else if (src.includes(MARKER)) { say('      WARN: marker present but block not matched, aborting'); process.exit(6); }

// --- patch: insert a tray menu item before "Quit" ---
say('[2/6] patching dist/main.js ...');
const anchor = `            {\n                label: 'Quit',`;
if (!src.includes(anchor)) {
  console.error('anchor for Quit menu item not found — archive layout changed, aborting');
  process.exit(2);
}
const injected =
`            {
                id: '${MARKER}',
                label: '第三方 API 设置',
                click: () => { void agyBridgeHost.open(); },
            },
` + anchor;
src = src.replace(anchor, injected);
src += `\n/* agy-bridge-host:start */\nconst agyBridgeHost = require('./agyBridgeMain.cjs').install({ electron: electron_1, utils: utils_1, origin: ${JSON.stringify(ENDPOINT)} });\n/* agy-bridge-host:end */\n`;
fs.writeFileSync(mainJs, src, 'utf8');
say('      inserted tray item id=' + MARKER);
const preloadJs = path.join(extractDir, 'dist', 'preload.js');
const preload = stripIntegration(fs.readFileSync(preloadJs, 'utf8'));
const pageSource = fs.readFileSync(path.join(patchDir, 'native-request-policy.js'), 'utf8') + '\n' + fs.readFileSync(path.join(patchDir, 'native-page.js'), 'utf8');
const preloadFragment = fs.readFileSync(path.join(patchDir, 'hub-preload.cjs'), 'utf8').replace('/*AGY_PAGE_SOURCE*/', JSON.stringify(pageSource));
fs.writeFileSync(preloadJs, preload + '\n/* agy-bridge-host:start */\n' + preloadFragment + '\n/* agy-bridge-host:end */\n');
const additions = [['host-main.cjs', 'agyBridgeMain.cjs']];
const obsoleteSettingsPreload = path.join(extractDir, 'dist', 'agyBridgeSettingsPreload.cjs');
if (fs.existsSync(obsoleteSettingsPreload)) fs.unlinkSync(obsoleteSettingsPreload);
for (const [source, target] of additions) fs.copyFileSync(path.join(patchDir, source), path.join(extractDir, 'dist', target));

// --- patch: point the language server at the bridge (belt and braces, env var also works) ---
const lsJs = path.join(extractDir, 'dist', 'languageServer.js');
if (fs.existsSync(lsJs)) {
  let lsrc = fs.readFileSync(lsJs, 'utf8');
  const cloud = /('--cloud_code_endpoint',\s*)'[^']*'/g;
  const api = /('--api_server_url',\s*)'([^']*)'/g;
  if ([...lsrc.matchAll(cloud)].length !== 1 || [...lsrc.matchAll(api)].length !== 1) {
    throw new Error('language server endpoint anchors changed; refusing to patch');
  }
  // Upgrade v1 safely: undo its API-server rewrite, which broke GetAuthStatus.
  lsrc = lsrc.replace(api, (match, prefix, value) => {
    if (value === 'https://generativelanguage.googleapis.com') return match;
    if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(value)) {
      return prefix + "'https://generativelanguage.googleapis.com'";
    }
    throw new Error('unrecognised api_server_url; refusing to overwrite it');
  });
  lsrc = lsrc.replace(cloud, (_, prefix) => prefix + JSON.stringify(ENDPOINT).replace(/^"|"$/g, "'"));
  fs.writeFileSync(lsJs, lsrc, 'utf8');
  say('      cloud_code_endpoint -> ' + ENDPOINT);
  say('      api_server_url -> https://generativelanguage.googleapis.com');
} else {
  throw new Error('dist/languageServer.js missing; refusing to patch');
}
execFileSync(process.execPath, ['--check', mainJs], { windowsHide: true });
execFileSync(process.execPath, ['--check', lsJs], { windowsHide: true });
for (const file of [preloadJs, ...additions.map(([, name]) => path.join(extractDir, 'dist', name))]) execFileSync(process.execPath, ['--check', file], { windowsHide: true });

// --- repack ---
say('[3/6] repacking ...');
const outDir = path.join(tmp, 'out');
fs.mkdirSync(outDir, { recursive: true });
const outAsar = path.join(outDir, 'app.asar');
npx(['pack', extractDir, outAsar, '--unpack-dir', UNPACK_DIR]);

// --- validate ---
say('[4/6] validating ...');
const after = listAll(readHeader(outAsar));
const miss = before.files.filter((f) => f !== 'dist/agyBridgeSettingsPreload.cjs' && !after.files.includes(f));
if (miss.length) { console.error('validation failed, missing entries: ' + miss.slice(0, 5).join(', ')); process.exit(3); }
const ubefore = new Set(before.unpacked), uafter = new Set(after.unpacked);
const udiff = [...ubefore].filter((x) => !uafter.has(x)).concat([...uafter].filter((x) => !ubefore.has(x)));
if (udiff.length) { console.error('unpacked set mismatch: ' + udiff.slice(0, 5).join(', ')); process.exit(4); }
for (const [name, source] of [['dist/main.js', mainJs], ['dist/languageServer.js', lsJs], ['dist/preload.js', preloadJs], ...additions.map(([, name]) => ['dist/' + name, path.join(extractDir, 'dist', name)])]) {
  if (!packedFile(outAsar, name).equals(fs.readFileSync(source))) throw new Error('packed file differs: ' + name);
}
say(`      entries ${after.files.length}/${before.files.length} ok, unpacked ${after.unpacked.length}/${before.unpacked.length} ok`);
say(`      size ${(fs.statSync(outAsar).size / 1048576).toFixed(2)} MB (was ${(fs.statSync(ASAR).size / 1048576).toFixed(2)} MB)`);

if (DRY) {
  say('\n[dry-run] would swap ' + outAsar + ' -> ' + ASAR);
  say('[dry-run] artifacts kept at ' + tmp);
  process.exit(0);
}

// --- backup + swap ---
say('[5/6] backup + swap ...');
if (!fs.existsSync(BAK)) {
  fs.copyFileSync(ASAR, BAK);
  say('      backup: ' + BAK);
} else {
  say('      backup already exists, keeping it');
}
fs.copyFileSync(outAsar, ASAR);
say('[6/6] done. restart Antigravity; Settings > 模型提供商, or model menu > 管理第三方模型.');
say('      only cloud_code_endpoint is hardwired to ' + ENDPOINT);
say('      rollback: node restore.mjs');

fs.rmSync(tmp, { recursive: true, force: true });
