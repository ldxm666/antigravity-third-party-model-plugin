#!/usr/bin/env node
// language: JavaScript (ESM), file: livetest.mjs, target: Node 24, deps: node: builtins only
//
// Regression test for the "fresh install + user-configured provider" path, which
// is exactly how the bridge is used in the field:
//
//   empty config home -> POST /api/providers -> POST /api/active -> generate
//
// It reproduces the reported failure (a request for a user-declared model being
// routed at a seed provider with an empty key) and asserts it cannot happen:
// every hop must land on the local mock, and no `unmapped_model` may be logged.
//
//   node livetest.mjs

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start_control_plane_mock } from '../test/control-plane.mjs';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-livetest-'));
process.env.AGY_BRIDGE_HOME = TEST_HOME;

const { start_server } = await import('./server.js');

let passed = 0;
const failures = [];

function section(name) {
  process.stdout.write(`\n${name}\n`);
}

function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, a === e ? '' : `expected ${e}, got ${a}`);
}

// ---------------------------------------------------------------------------
// Mock relay station: the only thing that may ever be dialled.
// ---------------------------------------------------------------------------

const MOCK_TEXT = 'relay-ok';
const MOCK_THOUGHT = 'relay-think';
const hits = { chat: 0, stream: 0, models: 0, paths: [] };

const mock = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://mock');
      hits.paths.push(`${req.method} ${url.pathname}`);

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        hits.models += 1;
        const payload = JSON.stringify({ data: [{ id: 'mock-model-a', owned_by: 'mock' }] });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        let payload = {};
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          payload = {};
        }
        if (payload.stream) {
          hits.stream += 1;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          send({ choices: [{ index: 0, delta: { reasoning_content: MOCK_THOUGHT } }] });
          send({ choices: [{ index: 0, delta: { content: MOCK_TEXT } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        hits.chat += 1;
        const out = JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: MOCK_TEXT, reasoning_content: MOCK_THOUGHT }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
        res.end(out);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `mock has no route for ${req.method} ${url.pathname}` } }));
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

// ---------------------------------------------------------------------------
// Bridge with a genuinely empty home (first-run path)
// ---------------------------------------------------------------------------

const control = await start_control_plane_mock(() => bridge.state.config);
const bridge = await start_server({ port: 0, control_plane_url: control.url });
const BASE = `http://127.0.0.1:${bridge.port}`;

async function post(pathname, body) {
  return fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(pathname) {
  return fetch(`${BASE}${pathname}`);
}

function text_of_body(body) {
  const parts = body.response.candidates[0].content.parts || [];
  return parts.filter((p) => !p.thought).map((p) => p.text).join('');
}

section('0. first run leaves nothing pointed at the internet');

const config_file = path.join(TEST_HOME, 'config.json');
ok('config.json was created', fs.existsSync(config_file));
const on_disk = JSON.parse(fs.readFileSync(config_file, 'utf8'));
eq('no providers on a fresh install', on_disk.providers, []);
eq('no model_map on a fresh install', on_disk.model_map, {});
eq('no default_model on a fresh install', on_disk.default_model, '');
ok('examples kept as documentation only', Boolean(on_disk.examples && on_disk.examples.provider));

// Every /v1internal:* reply is enveloped in {"response": ...}; bootstrap
// endpoints included, which is what makes the LS state machine advance.
async function fam() {
  const raw = await (await post('/v1internal:fetchAvailableModels', {})).json();
  return raw.response;
}

const empty_fam = await fam();
eq('empty install still returns a valid models map', empty_fam.models, {});
ok('empty install still returns agentModelSorts', Array.isArray(empty_fam.agentModelSorts) && empty_fam.agentModelSorts.length === 1);
ok('empty install still returns tabModelIds', Array.isArray(empty_fam.tabModelIds));

section('1. user adds a provider through the API');

const created = await (await post('/api/providers', {
  name: 'tnt-relay',
  kind: 'openai',
  base_url: `http://127.0.0.1:${mock.port}/v1`,
  api_key: 'sk-live-0000000000009999',
  models: [{ id: 'gemini-3.8-flash', display_name: 'Gemini 3.8 Flash', upstream: 'mock-model-a', ctx: 1000000, max_out: 8192 }],
})).json();
eq('provider created', created.ok, true);
const provider_id = created.provider.id;
ok('provider id returned', typeof provider_id === 'string' && provider_id.length > 0);
eq('model was mirrored into model_map', created.mapped_models, ['gemini-3.8-flash']);
eq('active provider auto-selected', (await (await get('/api/state')).json()).active_provider_id, provider_id);

const fam_after_create = await fam();
const native_id = `agy-bridge:${encodeURIComponent(provider_id)}:gemini-3.8-flash:inherit`;
ok('picker now offers gemini-3.8-flash', Boolean(fam_after_create.models[native_id]), JSON.stringify(Object.keys(fam_after_create.models)));
eq('sort group carries it too', fam_after_create.agentModelSorts[0].groups[0].modelIds, [native_id]);
eq('display name comes from the provider with its configured effort', fam_after_create.models[native_id].displayName, 'Gemini 3.8 Flash · ' + created.provider.name + ' (Follow App)');

section('2. activating the provider and its model');

const active = await (await post('/api/active', {
  active_provider_id: provider_id,
  default_model: 'gemini-3.8-flash',
})).json();
eq('active provider applied', active.active_provider_id, provider_id);
eq('default model applied', active.default_model, 'gemini-3.8-flash');
eq('no correction needed', active.corrected, false);

const bogus_active = await (await post('/api/active', {
  active_provider_id: provider_id,
  default_model: 'a-model-that-does-not-exist',
})).json();
eq('unknown default_model is corrected to the provider model', bogus_active.default_model, 'gemini-3.8-flash');
eq('correction is reported', bogus_active.corrected, true);

section('3. generateContent reaches the mock, not the internet');

const gen_res = await post('/v1internal:generateContent', {
  model: 'gemini-3.8-flash',
  request: {
    model: 'gemini-3.8-flash',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  },
});
eq('status 200', gen_res.status, 200);
const gen_body = await gen_res.json();
eq('mock answered', text_of_body(gen_body), MOCK_TEXT);
eq('mock was dialled exactly once', hits.chat, 1);
eq('no other host could have been used', hits.paths, ['POST /v1/chat/completions']);

section('4. streaming works on the same provider');

const stream_res = await post('/v1internal:streamGenerateContent?alt=sse', {
  request: { model: 'gemini-3.8-flash', contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
});
eq('status 200', stream_res.status, 200);
const stream_text = await stream_res.text();
const frames = stream_text.split('\n\n').map((s) => s.trim()).filter(Boolean);
let streamed = '';
let saw_response_only = true;
for (const frame of frames) {
  if (!frame.startsWith('data:')) continue;
  const data = frame.slice(5).trim();
  if (data === '[DONE]') continue;
  const obj = JSON.parse(data);
  if (Object.keys(obj).join(',') !== 'response') saw_response_only = false;
  const parts = (obj.response.candidates && obj.response.candidates[0] && obj.response.candidates[0].content.parts) || [];
  for (const part of parts) if (typeof part.text === 'string' && !part.thought) streamed += part.text;
}
eq('every frame is {"response":...}', saw_response_only, true);
eq('streamed text from the mock', streamed, MOCK_TEXT);
eq('stream hit the mock', hits.stream, 1);

section('5. an unmapped placeholder still stays on the active provider');

const placeholder_res = await post('/v1internal:generateContent', {
  request: { model: 'MODEL_PLACEHOLDER_M528', contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
});
eq('status 200', placeholder_res.status, 200);
const placeholder_body = await placeholder_res.json();
eq('placeholder fell back to the provider model', text_of_body(placeholder_body), MOCK_TEXT);
eq('still only the mock was dialled', hits.chat, 2);

section('6. no unmapped_model for the configured id');

const logs = await (await get('/api/logs?limit=200')).json();
const unmapped = logs.filter((entry) => entry.msg === 'unmapped_model');
const unmapped_configured = unmapped.filter((entry) => {
  const requested = entry.meta && entry.meta.requested;
  return requested === 'gemini-3.8-flash';
});
eq('gemini-3.8-flash never logged as unmapped', unmapped_configured.length, 0);
ok(
  'the placeholder fallback was logged (expected)',
  unmapped.some((entry) => entry.meta && entry.meta.requested === 'MODEL_PLACEHOLDER_M528'),
  JSON.stringify(unmapped.map((e) => e.meta && e.meta.requested)),
);
const relay_logs = logs.filter((entry) => entry.msg === 'relay_generate');
ok('relay log carries agy_model/upstream_model/provider/body_keys', relay_logs.every((entry) => {
  const meta = entry.meta || {};
  return 'agy_model' in meta && 'upstream_model' in meta && 'provider' in meta && 'body_keys' in meta;
}), JSON.stringify(relay_logs[0] && relay_logs[0].meta));

section('7. deleting the provider cleans the map up');

const deleted = await (await fetch(`${BASE}/api/providers/${provider_id}`, { method: 'DELETE' })).json();
eq('delete ok', deleted.ok, true);
eq('auto-mapped models removed with the provider', deleted.removed_models, ['gemini-3.8-flash']);
const fam_after_delete = await fam();
eq('picker is empty again', fam_after_delete.models, {});

const no_provider_res = await post('/v1internal:generateContent', {
  request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
});
eq('no provider configured is a clear 503', no_provider_res.status, 503);
const no_provider_body = await no_provider_res.json();
ok('503 carries a human message', /尚未配置|provider/i.test(no_provider_body.error.message), no_provider_body.error.message);

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

await bridge.close();
await control.close();
await new Promise((resolve) => mock.server.close(resolve));
try {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
} catch {
  // temp dir cleanup is best effort
}

process.stdout.write('\n' + '-'.repeat(64) + '\n');
process.stdout.write(`  ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write('\n  failures:\n');
  for (const line of failures) process.stdout.write(`   - ${line}\n`);
  process.stdout.write('-'.repeat(64) + '\n');
  process.exit(1);
}
process.stdout.write('  ALL GREEN\n');
process.stdout.write('-'.repeat(64) + '\n');
process.exit(0);
