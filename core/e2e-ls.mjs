#!/usr/bin/env node
// language: JavaScript (ESM), file: e2e-ls.mjs, target: Node 24, deps: node: builtins only
//
// End-to-end check against the REAL language server binary.
//
// Starts an isolated bridge and a local control-plane fixture, points a fresh
// language_server.exe at the bridge via CLOUD_CODE_URL, and reconstructs the
// startup sequence from its request log. The running desktop and its home are
// not modified. This fixture does not establish real Google login acceptance.
//
// What this proves, and why each assertion exists:
//   - onboardUser was reached under the isolated fixture: the LS understood
//     the envelope and advanced through the test startup state machine.
//   - loadCodeAssist count <= 3: a retry loop means the reply was rejected.
//   - zero error-level bridge logs.
//
//   node e2e-ls.mjs [--seconds 20]
//
// Skips (exit 0 with a notice) when the binary is not installed.

import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start_control_plane_mock } from '../test/control-plane.mjs';
import { google_proxy_url } from './bootstrap.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-e2e-'));
const LS_HOME = fs.mkdtempSync(path.join(os.homedir(), '.gemini', 'agy-bridge-e2e-'));
process.env.AGY_BRIDGE_HOME = TEST_HOME;

const { start_server } = await import('./server.js');

const seconds_arg = process.argv.indexOf('--seconds');
const RUN_SECONDS = seconds_arg > 0 ? Number(process.argv[seconds_arg + 1]) || 20 : 20;

const LS_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Programs',
  'antigravity',
  'resources',
  'bin',
  'language_server.exe',
);

if (!fs.existsSync(LS_PATH)) {
  process.stdout.write(`SKIP: language_server.exe not found at ${LS_PATH}\n`);
  process.exit(0);
}

let passed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

// ---------------------------------------------------------------------------
// Local inference and control-plane mocks. Google OAuth still uses the existing
// signed-in account and its normal network path, as the desktop app does.
// ---------------------------------------------------------------------------

const mock = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        payload = {};
      }
      if (payload.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'e2e-ok' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const out = JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: 'e2e-ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
      res.end(out);
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

const config = {
  port: 0,
  active_provider_id: 'p-e2e',
  default_model: 'e2e-model',
  providers: [
    {
      id: 'p-e2e',
      name: 'E2E Mock',
      kind: 'openai',
      base_url: `http://127.0.0.1:${mock.port}/v1`,
      api_key: 'sk-e2e-0000000000000000',
      models: [
        { id: 'e2e-model', display_name: 'E2E Model', upstream: 'e2e-upstream', ctx: 128000, max_out: 8192 },
        { id: 'e2e-model-2', display_name: 'E2E Model 2', upstream: 'e2e-upstream', ctx: 128000, max_out: 8192 },
      ],
    },
  ],
  model_map: {
    'e2e-model': { provider_id: 'p-e2e', upstream: 'e2e-upstream', display_name: 'E2E Model' },
    'e2e-model-2': { provider_id: 'p-e2e', upstream: 'e2e-upstream', display_name: 'E2E Model 2' },
  },
  log_level: 'debug',
  timeouts: { connect_ms: 5000, request_ms: 15000, stream_idle_ms: 15000 },
};

const control = await start_control_plane_mock(() => config);
const bridge = await start_server({
  control_plane_url: control.url,
  config,
  config_path: path.join(TEST_HOME, 'config.json'),
  port: 0,
});

const args = [
  '--standalone',
  '--override_ide_name', 'antigravity',
  '--subclient_type', 'hub',
  '--override_ide_version', '2.31.2',
  '--override_user_agent_name', 'antigravity',
  '--https_server_port', '19003',
  '--csrf_token', 't',
  '--app_data_dir', path.basename(LS_HOME),
  '--api_server_url', 'https://generativelanguage.googleapis.com',
  '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com',
  '--enable_sidecars',
  '--disable_telemetry',
];

process.stdout.write(`\nlanguage server : ${LS_PATH}`);
process.stdout.write(`\nbridge          : http://127.0.0.1:${bridge.port}`);
process.stdout.write(`\nrunning for     : ${RUN_SECONDS}s\n\n`);

const proxy = google_proxy_url();
const child = spawn(LS_PATH, args, {
  env: { ...process.env, ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1' } : {}),
    CLOUD_CODE_URL: `http://127.0.0.1:${bridge.port}` },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout_buf = '';
let stderr_buf = '';
child.stdout.on('data', (c) => {
  if (stdout_buf.length < 8000) stdout_buf += c.toString('utf8');
});
child.stderr.on('data', (c) => {
  if (stderr_buf.length < 8000) stderr_buf += c.toString('utf8');
});
child.on('error', (err) => {
  process.stdout.write(`spawn error: ${err.message}\n`);
});

// The desktop UI normally opens this stream. Merely starting an authenticated
// LS does not necessarily fetch model data; actively exercise the auth RPC.
let auth_status_bytes = 0;
const probe_auth = (async () => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const connected = await new Promise(resolve => {
      const request = https.request('https://127.0.0.1:19003/exa.language_server_pb.LanguageServerService/GetAuthStatus', {
        method: 'POST', rejectUnauthorized: false,
        headers: { 'content-type': 'application/grpc-web+json', 'x-grpc-web': '1', 'x-codeium-csrf-token': 't' },
      }, response => {
        response.once('data', data => { auth_status_bytes += data.length; request.destroy(); resolve(true); });
      });
      request.setTimeout(15000, () => { request.destroy(); resolve(true); });
      request.on('error', () => resolve(false));
      request.end(Buffer.concat([Buffer.from([0,0,0,0,2]),Buffer.from('{}')]));
    });
    if (connected) break;
    await new Promise(resolve => setTimeout(resolve,100));
  }
})();
await new Promise((resolve) => setTimeout(resolve, RUN_SECONDS * 1000));
await probe_auth;

// ---------------------------------------------------------------------------
// Collect the bridge-side call log before tearing anything down
// ---------------------------------------------------------------------------

const logs = await (await fetch(`http://127.0.0.1:${bridge.port}/api/logs?limit=500`)).json();
const state = await (await fetch(`http://127.0.0.1:${bridge.port}/api/state`)).json();

const mock_calls = logs.filter((e) => e.msg === 'control_plane' && e.meta && e.meta.method).map((e) => e.meta.method);
const relay_calls = logs
  .filter((e) => e.msg === 'relay_generate' || e.msg === 'relay_stream')
  .map((e) => (e.msg === 'relay_stream' ? 'streamGenerateContent' : 'generateContent'));
const unknown_calls = logs.filter((e) => e.msg === 'unknown_v1internal_endpoint').map((e) => e.meta && e.meta.method);
const errors = logs.filter((e) => e.level === 'error');

// Kill the whole process tree; the LS spawns sidecars.
await new Promise((resolve) => {
  const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  killer.on('exit', () => resolve());
  killer.on('error', () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    resolve();
  });
  setTimeout(resolve, 5000);
});

process.stdout.write('\nobserved call sequence (bridge side):\n');
const sequence = logs
  .filter((e) => e.msg === 'control_plane' || String(e.msg).startsWith('relay_'))
  .map((e) => (e.msg === 'control_plane' ? e.meta.method : e.msg));
process.stdout.write(`  ${sequence.join(' -> ') || '(none)'}\n`);
process.stdout.write(`\n  request_count = ${state.request_count}\n`);
process.stdout.write(`  poll entries  = ${logs.filter((e) => e.msg === 'mock' && e.meta && e.meta.method === '').length}\n`);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

process.stdout.write('\nassertions\n');

const lca_count = mock_calls.filter((m) => m === 'loadCodeAssist').length;
const onboard_count = mock_calls.filter((m) => m === 'onboardUser').length;
const fam_count = mock_calls.filter((m) => m === 'fetchAvailableModels').length;

ok('language server reached the bridge at all', state.request_count > 0, String(state.request_count));
// The legacy bootstrap fixture is deliberately not a Google login fixture.
// Auth acceptance is verified separately against the real desktop UI.
ok('onboardUser was called', onboard_count > 0, `count=${onboard_count}`);
ok('loadCodeAssist did not retry-loop (<= 3)', lca_count <= 3, `count=${lca_count}`);
ok('fetchAvailableModels was called', fam_count > 0, `count=${fam_count}`);
ok('no error-level bridge logs', errors.length === 0, errors.map((e) => e.msg).join(','));
ok(
  'no unexpected v1internal endpoints',
  unknown_calls.length === 0,
  unknown_calls.join(','),
);

if (stdout_buf.trim()) {
  process.stdout.write('\nlanguage server stdout (first 1500 chars):\n');
  process.stdout.write(stdout_buf.slice(0, 1500).split('\n').map((l) => `  ${l}`).join('\n') + '\n');
}
if (stderr_buf.trim()) {
  process.stdout.write('\nlanguage server stderr (first 6500 chars):\n');
  process.stdout.write(stderr_buf.slice(0, 6500).split('\n').map((l) => `  ${l}`).join('\n') + '\n');
}

await bridge.close();
await control.close();
await new Promise((resolve) => mock.server.close(resolve));
try {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.rmSync(LS_HOME, { recursive: true, force: true });
} catch {
  // temp dir cleanup is best effort
}

process.stdout.write('\n' + '-'.repeat(64) + '\n');
process.stdout.write(`  ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const line of failures) process.stdout.write(`   - ${line}\n`);
  process.stdout.write('-'.repeat(64) + '\n');
  process.exit(1);
}
process.stdout.write('  ALL GREEN\n');
process.stdout.write('-'.repeat(64) + '\n');
process.exit(0);
