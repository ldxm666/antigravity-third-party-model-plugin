#!/usr/bin/env node
// language: JavaScript (ESM), file: selftest.mjs, target: Node 24, deps: node: builtins only
//
// End-to-end self test. Spins up three mock upstreams (OpenAI, Anthropic,
// Gemini), boots the bridge on an ephemeral port against a throwaway
// AGY_BRIDGE_HOME, and drives both generation endpoints through every provider.
//
//   node selftest.mjs
//
// Exit code 0 means every assertion passed.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start_control_plane_mock } from '../test/control-plane.mjs';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bridge-selftest-'));
process.env.AGY_BRIDGE_HOME = TEST_HOME;

const { start_server } = await import('./server.js');
const { mask_key } = await import('./config.js');
const { normalize_base } = await import('./providers/base.js');
const { create_sse_parser } = await import('./sse.js');
const { normalize_request } = await import('./translate.js');

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
let current_section = '';

function section(name) {
  current_section = name;
  process.stdout.write(`\n${name}\n`);
}

function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    const line = `${current_section} :: ${name}${detail ? ` — ${detail}` : ''}`;
    failures.push(line);
    process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, a === e ? '' : `expected ${e}, got ${a}`);
}

function near(name, actual, expected, tolerance = 0) {
  ok(name, Math.abs(Number(actual) - Number(expected)) <= tolerance, `expected ~${expected}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// Mock upstreams
// ---------------------------------------------------------------------------

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          Promise.resolve(handler(req, res, body)).catch((err) => {
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: { message: String(err && err.message) } }));
            } else if (!res.writableEnded) {
              res.end();
            }
          });
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: String(err && err.message) } }));
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function mock_json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function mock_sse_open(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
}

// --- OpenAI ---------------------------------------------------------------
const OPENAI_TEXT = 'Hello world';
const OPENAI_THOUGHT = 'think-1';

const openai_mock = await listen(async (req, res, body) => {
  const url = new URL(req.url, 'http://mock');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    mock_json(res, 200, { data: [{ id: 'mock-gpt', owned_by: 'mock' }] });
    return;
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    mock_json(res, 404, { error: { message: 'not found' } });
    return;
  }
  const payload = JSON.parse(body || '{}');
  if (payload.model === 'boom') {
    mock_json(res, 500, { error: { message: 'mock upstream exploded' } });
    return;
  }
  if (payload.stream) {
    mock_sse_open(res);
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ id: 'c1', choices: [{ index: 0, delta: { reasoning_content: OPENAI_THOUGHT } }] });
    send({ id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' } }] });
    send({ id: 'c1', choices: [{ index: 0, delta: { content: ' world' } }] });
    send({
      id: 'c1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  mock_json(res, 200, {
    choices: [
      { index: 0, message: { role: 'assistant', content: OPENAI_TEXT, reasoning_content: OPENAI_THOUGHT }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
  });
});

// --- Anthropic ------------------------------------------------------------
const ANTHROPIC_TEXT = 'Claude says hi';

const anthropic_mock = await listen(async (req, res, body) => {
  const url = new URL(req.url, 'http://mock');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    mock_json(res, 200, { data: [{ id: 'mock-claude', display_name: 'Mock Claude' }] });
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
    mock_json(res, 404, { error: { message: 'not found' } });
    return;
  }
  const payload = JSON.parse(body || '{}');
  if (payload.model === 'boom') {
    mock_json(res, 500, { error: { message: 'mock claude exploded' } });
    return;
  }
  if (payload.stream) {
    mock_sse_open(res);
    const send = (event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
    send('message_start', { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 7, output_tokens: 0 } } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude says' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' hi' } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
    return;
  }
  mock_json(res, 200, {
    id: 'm1',
    content: [{ type: 'text', text: ANTHROPIC_TEXT }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 7, output_tokens: 3 },
  });
});

// --- Gemini ---------------------------------------------------------------
const GEMINI_TEXT = 'Gemini says hi';

const gemini_mock = await listen(async (req, res, body) => {
  const url = new URL(req.url, 'http://mock');
  if (req.method === 'GET' && url.pathname === '/v1beta/models') {
    mock_json(res, 200, { models: [{ name: 'models/mock-gemini', displayName: 'Mock Gemini' }] });
    return;
  }
  const stream = url.pathname.includes(':streamGenerateContent');
  const generate = url.pathname.includes(':generateContent');
  if (req.method !== 'POST' || (!stream && !generate)) {
    mock_json(res, 404, { error: { message: `not found: ${url.pathname}` } });
    return;
  }
  const payload = JSON.parse(body || '{}');
  if (String(url.pathname).includes('boom')) {
    mock_json(res, 500, { error: { message: 'mock gemini exploded' } });
    return;
  }
  if (!payload.contents) {
    mock_json(res, 400, { error: { message: 'contents is required' } });
    return;
  }
  if (stream) {
    mock_sse_open(res);
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini says' }] }, index: 0 }],
      modelVersion: 'mock-gemini',
    });
    send({
      candidates: [{ content: { role: 'model', parts: [{ text: ' hi' }] }, index: 0, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      modelVersion: 'mock-gemini',
    });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  mock_json(res, 200, {
    candidates: [{ content: { role: 'model', parts: [{ text: GEMINI_TEXT }] }, index: 0, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    modelVersion: 'mock-gemini',
  });
});

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

const config = {
  port: 0,
  active_provider_id: 'p-openai',
  default_model: 'mock-model-a',
  providers: [
    {
      id: 'p-openai',
      name: 'Mock OpenAI',
      kind: 'openai',
      base_url: `http://127.0.0.1:${openai_mock.port}/v1`,
      api_key: 'sk-fixture-abcd',
      models: [{ id: 'mock-model-a', display_name: 'Mock A', upstream: 'mock-gpt', ctx: 128000, max_out: 4096 }],
    },
    {
      id: 'p-anthropic',
      name: 'Mock Anthropic',
      kind: 'anthropic',
      base_url: `http://127.0.0.1:${anthropic_mock.port}`,
      api_key: 'sk-ant-selftest-00000000',
      models: [{ id: 'mock-model-b', display_name: 'Mock B', upstream: 'mock-claude', ctx: 200000, max_out: 8192 }],
    },
    {
      id: 'p-gemini',
      name: 'Mock Gemini',
      kind: 'gemini',
      base_url: `http://127.0.0.1:${gemini_mock.port}`,
      api_key: 'gemini-selftest-key',
      models: [{ id: 'mock-model-c', display_name: 'Mock C', upstream: 'mock-gemini', ctx: 1000000, max_out: 65535 }],
    },
  ],
  model_map: {
    'mock-model-a': { provider_id: 'p-openai', upstream: 'mock-gpt', display_name: 'Mock A' },
    'mock-model-b': { provider_id: 'p-anthropic', upstream: 'mock-claude', display_name: 'Mock B' },
    'mock-model-c': { provider_id: 'p-gemini', upstream: 'mock-gemini', display_name: 'Mock C' },
    'mock-model-boom': { provider_id: 'p-openai', upstream: 'boom', display_name: 'Boom' },
  },
  log_level: 'warn',
  capture_requests: true, // This isolated fixture explicitly tests diagnostic capture.
  timeouts: { connect_ms: 5000, request_ms: 15000, stream_idle_ms: 15000 },
};

const control = await start_control_plane_mock(() => config);
const bridge = await start_server({
  control_plane_url: control.url,
  config,
  config_path: path.join(TEST_HOME, 'config.json'),
  port: 0,
});
const BASE = `http://127.0.0.1:${bridge.port}`;

async function post(pathname, body, headers = {}) {
  return fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function get(pathname) {
  return fetch(`${BASE}${pathname}`);
}

/** POST and return the `response` payload, plus the raw envelope for shape checks. */
async function post_payload(pathname, body) {
  const res = await post(pathname, body);
  const raw = await res.json();
  return { status: res.status, raw, payload: raw.response };
}

// ---------------------------------------------------------------------------
// SSE client-side helpers (deliberately independent of the bridge's parser)
// ---------------------------------------------------------------------------

async function read_sse(res) {
  const text = await res.text();
  const frames = [];
  for (const block of text.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    let data = null;
    for (const line of lines) {
      if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    frames.push(data === null ? { raw: trimmed } : { data });
  }
  return frames;
}

function frames_json(frames) {
  const out = [];
  for (const frame of frames) {
    if (frame.data === undefined || frame.data === null || frame.data === '[DONE]') continue;
    try {
      out.push(JSON.parse(frame.data));
    } catch {
      out.push({ __unparsable: frame.data });
    }
  }
  return out;
}

function text_of(frames) {
  let out = '';
  for (const obj of frames_json(frames)) {
    const parts = (obj.response && obj.response.candidates && obj.response.candidates[0] &&
      obj.response.candidates[0].content && obj.response.candidates[0].content.parts) || [];
    for (const part of parts) if (typeof part.text === 'string' && !part.thought) out += part.text;
  }
  return out;
}

function thoughts_of(frames) {
  let out = '';
  for (const obj of frames_json(frames)) {
    const parts = (obj.response && obj.response.candidates && obj.response.candidates[0] &&
      obj.response.candidates[0].content && obj.response.candidates[0].content.parts) || [];
    for (const part of parts) if (typeof part.text === 'string' && part.thought) out += part.text;
  }
  return out;
}

function finish_of(frames) {
  let reason;
  for (const obj of frames_json(frames)) {
    const candidate = obj.response && obj.response.candidates && obj.response.candidates[0];
    if (candidate && candidate.finishReason) reason = candidate.finishReason;
  }
  return reason;
}

function usage_of(frames) {
  let usage;
  for (const obj of frames_json(frames)) {
    if (obj.response && obj.response.usageMetadata) usage = obj.response.usageMetadata;
  }
  return usage;
}

function envelope_keys(frames) {
  const keys = new Set();
  for (const obj of frames_json(frames)) keys.add(Object.keys(obj).join(','));
  return [...keys];
}

// ---------------------------------------------------------------------------
// 1. unit-ish checks
// ---------------------------------------------------------------------------

section('1. normalisation helpers');

eq('openai base: bare host', normalize_base('openai', 'https://x.com'), 'https://x.com/v1');
eq('openai base: trailing slash', normalize_base('openai', 'https://x.com/'), 'https://x.com/v1');
eq('openai base: /v1', normalize_base('openai', 'https://x.com/v1'), 'https://x.com/v1');
eq('openai base: /v1/', normalize_base('openai', 'https://x.com/v1/'), 'https://x.com/v1');
eq('openai base: full path', normalize_base('openai', 'https://x.com/v1/chat/completions'), 'https://x.com/v1');
eq('openai base: versioned prefix', normalize_base('openai', 'https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4');
eq('anthropic base: bare host', normalize_base('anthropic', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1');
eq('anthropic base: /v1/messages', normalize_base('anthropic', 'https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1');
eq('gemini base: bare host', normalize_base('gemini', 'https://x.com'), 'https://x.com');
eq('gemini base: /v1beta', normalize_base('gemini', 'https://x.com/v1beta'), 'https://x.com');
eq('gemini base: relay prefix', normalize_base('gemini', 'https://x.com/api/gemini'), 'https://x.com/api/gemini');

eq('mask: long key', mask_key('sk-abcdefgh1234'), 'sk-***1234');
eq('mask: short key', mask_key('short'), '***');
eq('mask: empty', mask_key(''), '');

const envelope_probe = normalize_request({
  request: { model: 'inner-model', contents: [{ role: 'user', parts: [{ text: 'x' }] }] },
  model: 'outer-model',
});
eq('normalize: request.model wins over body.model', envelope_probe.model, 'inner-model');
eq('normalize: envelope detected', envelope_probe.envelope, true);
eq('normalize: contents extracted', envelope_probe.contents.length, 1);

const flat_probe = normalize_request({
  contents: [{ role: 'user', parts: [{ text: 'y' }] }],
  generationConfig: { model: 'gc-model', temperature: 0.5 },
});
eq('normalize: flat body model from generationConfig', flat_probe.model, 'gc-model');
eq('normalize: generationConfig.model stripped', 'model' in flat_probe.generation_config, false);
eq('normalize: flat contents', flat_probe.contents.length, 1);

// ---------------------------------------------------------------------------
// 2. OpenAI upstream
// ---------------------------------------------------------------------------

section('2. openai provider — streamGenerateContent');

const openai_stream_res = await post('/v1internal:streamGenerateContent?alt=sse', {
  request: { model: 'mock-model-a', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
});
eq('status 200', openai_stream_res.status, 200);
ok('content-type is text/event-stream', String(openai_stream_res.headers.get('content-type')).startsWith('text/event-stream'), openai_stream_res.headers.get('content-type'));
ok('trace header present', Boolean(openai_stream_res.headers.get('x-agy-trace-id')));

const openai_frames = await read_sse(openai_stream_res);
eq('every frame is {"response":...} only', envelope_keys(openai_frames), ['response']);
eq('streamed text', text_of(openai_frames), OPENAI_TEXT);
eq('reasoning mapped to thought part', thoughts_of(openai_frames), OPENAI_THOUGHT);
eq('finishReason', finish_of(openai_frames), 'STOP');
eq('usageMetadata', usage_of(openai_frames), { promptTokenCount: 11, candidatesTokenCount: 2, totalTokenCount: 13 });
eq('no synthesized [DONE]', openai_frames.filter((f) => f.data === '[DONE]').length, 0);
const openai_model_version = frames_json(openai_frames)[0].response.modelVersion;
eq('modelVersion is the upstream model', openai_model_version, 'mock-gpt');

section('3. openai provider — generateContent');

const openai_res = await post('/v1internal:generateContent', {
  request: { model: 'mock-model-a', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
});
eq('status 200', openai_res.status, 200);
const openai_body = await openai_res.json();
eq('envelope has exactly one key', Object.keys(openai_body), ['response']);
const openai_candidate = openai_body.response.candidates[0];
eq('role', openai_candidate.content.role, 'model');
eq('text part', openai_candidate.content.parts.filter((p) => !p.thought).map((p) => p.text).join(''), OPENAI_TEXT);
eq('thought part', openai_candidate.content.parts.filter((p) => p.thought).map((p) => p.text).join(''), OPENAI_THOUGHT);
eq('finishReason', openai_candidate.finishReason, 'STOP');
eq('usage', openai_body.response.usageMetadata, { promptTokenCount: 11, candidatesTokenCount: 2, totalTokenCount: 13 });

// ---------------------------------------------------------------------------
// 4. Anthropic upstream
// ---------------------------------------------------------------------------

section('4. anthropic provider — streamGenerateContent');

const anthropic_stream_res = await post('/v1internal:streamGenerateContent?alt=sse', {
  request: { model: 'mock-model-b', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
});
eq('status 200', anthropic_stream_res.status, 200);
const anthropic_frames = await read_sse(anthropic_stream_res);
eq('every frame is {"response":...} only', envelope_keys(anthropic_frames), ['response']);
eq('streamed text', text_of(anthropic_frames), ANTHROPIC_TEXT);
eq('finishReason', finish_of(anthropic_frames), 'STOP');
eq('usageMetadata', usage_of(anthropic_frames), { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 });

section('5. anthropic provider — generateContent');

const anthropic_res = await post('/v1internal:generateContent', {
  request: { model: 'mock-model-b', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
});
eq('status 200', anthropic_res.status, 200);
const anthropic_body = await anthropic_res.json();
eq('text part', anthropic_body.response.candidates[0].content.parts.map((p) => p.text).join(''), ANTHROPIC_TEXT);
eq('usage', anthropic_body.response.usageMetadata, { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 });

// ---------------------------------------------------------------------------
// 6. Gemini upstream
// ---------------------------------------------------------------------------

section('6. gemini provider — streamGenerateContent');

const gemini_stream_res = await post('/v1internal:streamGenerateContent?alt=sse', {
  request: { model: 'mock-model-c', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
});
eq('status 200', gemini_stream_res.status, 200);
const gemini_frames = await read_sse(gemini_stream_res);
eq('every frame is {"response":...} only', envelope_keys(gemini_frames), ['response']);
eq('streamed text', text_of(gemini_frames), GEMINI_TEXT);
eq('finishReason', finish_of(gemini_frames), 'STOP');
eq('usageMetadata', usage_of(gemini_frames), { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 });
eq('[DONE] forwarded because upstream sent it', gemini_frames.filter((f) => f.data === '[DONE]').length, 1);

section('7. gemini provider — generateContent');

const gemini_res = await post('/v1internal:generateContent', {
  request: { model: 'mock-model-c', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
});
eq('status 200', gemini_res.status, 200);
const gemini_body = await gemini_res.json();
eq('text part', gemini_body.response.candidates[0].content.parts.map((p) => p.text).join(''), GEMINI_TEXT);

// ---------------------------------------------------------------------------
// 8. model routing
// ---------------------------------------------------------------------------

section('8. model routing');

const placeholder_res = await post('/v1internal:generateContent', {
  request: { model: 'MODEL_PLACEHOLDER_M528', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
});
eq('unknown placeholder falls back instead of failing', placeholder_res.status, 200);
const placeholder_body = await placeholder_res.json();
eq(
  'fallback routed to default_model',
  placeholder_body.response.candidates[0].content.parts.filter((p) => !p.thought).map((p) => p.text).join(''),
  OPENAI_TEXT,
);

const chat_id_res = await post('/v1internal:generateContent', {
  request: { model: 'chat_20706', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
});
eq('chat_xxxxx placeholder also falls back', chat_id_res.status, 200);

const settings_res = await post('/v1internal:setUserSettings', { userSettings: { model: 'mock-model-b' } });
eq('setUserSettings 200', settings_res.status, 200);
eq('setUserSettings body is enveloped', await settings_res.json(), { response: {} });

const no_model_res = await post('/v1internal:generateContent', {
  request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
});
eq('missing request.model still 200', no_model_res.status, 200);
const no_model_body = await no_model_res.json();
eq('routed through the setUserSettings model', no_model_body.response.candidates[0].content.parts.map((p) => p.text).join(''), ANTHROPIC_TEXT);

// restore the default for later checks
await post('/v1internal:setUserSettings', { userSettings: { model: 'mock-model-a' } });

// ---------------------------------------------------------------------------
// 9. tool calls and system instruction translation
// ---------------------------------------------------------------------------

section('9. tools / systemInstruction translation');

const tool_res = await post('/v1internal:generateContent', {
  request: {
    model: 'mock-model-a',
    systemInstruction: { parts: [{ text: 'be terse' }] },
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    tools: [{ functionDeclarations: [{ name: 'read_file', description: 'read', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } } } }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 2048 } },
  },
});
eq('tools request still 200', tool_res.status, 200);

// The mock echoes fixed text, so what we assert here is that the translation
// layer produced a valid upstream request rather than throwing.
const tool_body = await tool_res.json();
ok('tools request produced a candidate', Array.isArray(tool_body.response.candidates));

// ---------------------------------------------------------------------------
// 10. error paths
// ---------------------------------------------------------------------------

section('10. error paths');

const boom_res = await post('/v1internal:generateContent', {
  request: { model: 'mock-model-boom', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
});
eq('upstream 500 maps to 502', boom_res.status, 502);
const boom_body = await boom_res.json();
ok('error has code', Number.isFinite(boom_body.error.code), JSON.stringify(boom_body));
ok('error has google status', typeof boom_body.error.status === 'string' && boom_body.error.status.length > 0, boom_body.error.status);
ok('error message mentions the upstream', /mock upstream exploded|upstream/i.test(boom_body.error.message), boom_body.error.message);

const boom_stream_res = await post('/v1internal:streamGenerateContent?alt=sse', {
  request: { model: 'mock-model-boom', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
});
eq('stream failure before first frame is a real HTTP error', boom_stream_res.status, 502);
const boom_stream_body = await boom_stream_res.json();
ok('stream error is gemini shaped', Boolean(boom_stream_body.error && boom_stream_body.error.code));

// ---------------------------------------------------------------------------
// 11. countTokens
// ---------------------------------------------------------------------------

section('11. countTokens');

const count_res = await post('/v1internal:countTokens', {
  request: { contents: [{ role: 'user', parts: [{ text: 'abcdefgh' }] }] },
});
eq('countTokens 200', count_res.status, 200);
const count_raw = await count_res.json();
eq('countTokens is enveloped', Object.keys(count_raw), ['response']);
eq('chars/4 rounded up', count_raw.response.totalTokens, 2);

// ---------------------------------------------------------------------------
// 12. bootstrap endpoints
// ---------------------------------------------------------------------------

section('12. bootstrap endpoints');

// Real-machine A/B: every control-plane reply must carry the same
// {"response": <payload>} envelope the generate endpoints use, or the LS stalls
// on loadCodeAssist and never reaches onboardUser.
const lca_r = await post_payload('/v1internal:loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } });
eq('loadCodeAssist is enveloped', Object.keys(lca_r.raw), ['response']);
const lca = lca_r.payload;
eq('loadCodeAssist currentTier.id', lca.currentTier.id, 'standard');
const allowed_ids = lca.allowedTiers.map((t) => t.id);
ok('allowedTiers contains free-tier', allowed_ids.includes('free-tier'), JSON.stringify(allowed_ids));
ok('allowedTiers contains standard', allowed_ids.includes('standard'), JSON.stringify(allowed_ids));
ok('allowedTiers are user-defined projects', lca.allowedTiers.every((t) => t.userDefinedCloudaicompanionProject === true));
eq('gcpManaged is false', lca.gcpManaged, false);
ok('loadCodeAssist cloudaicompanionProject', typeof lca.cloudaicompanionProject === 'string' && lca.cloudaicompanionProject.length > 0);
ok('loadCodeAssist modelConfigs reflect the config', lca.modelConfigs.length === 4, String(lca.modelConfigs.length));

const onboard_r = await post_payload('/v1internal:onboardUser', { tierId: 'free-tier', metadata: { ideType: 'ANTIGRAVITY' } });
eq('onboardUser is enveloped', Object.keys(onboard_r.raw), ['response']);
const onboard = onboard_r.payload;
eq('onboardUser done', onboard.done, true);
eq('onboardUser name', onboard.name, 'operations/onboardUser');
ok('onboardUser inner response present', Boolean(onboard.response));
eq('onboardUser swallowed free-tier', onboard.response.cloudaicompanionProject.id, 'agy-bridge-local');
eq('onboardUser status', onboard.response.status, 'SUCCESS');

const fam_r = await post_payload('/v1internal:fetchAvailableModels', {});
eq('fetchAvailableModels is enveloped', Object.keys(fam_r.raw), ['response']);
const fam = fam_r.payload;
ok('fetchAvailableModels.models is an object map', fam.models && !Array.isArray(fam.models) && typeof fam.models === 'object');
eq('fetchAvailableModels exposes every mapped model', [...new Set(Object.keys(fam.models).map(id => decodeURIComponent(id.split(':')[2])))].sort(), ['mock-model-a', 'mock-model-b', 'mock-model-boom', 'mock-model-c']);
eq('agentModelSorts drives the picker', fam.agentModelSorts[0].groups[0].modelIds, Object.keys(fam.models));
eq('defaultAgentModelId', fam.defaultAgentModelId, 'agy-bridge:p-openai:mock-model-a:inherit');
ok('tabModelIds is not empty', Array.isArray(fam.tabModelIds) && fam.tabModelIds.length >= 1, JSON.stringify(fam.tabModelIds));
ok('mqueryModelIds is not empty', Array.isArray(fam.mqueryModelIds) && fam.mqueryModelIds.length >= 1, JSON.stringify(fam.mqueryModelIds));
ok('every model has a MODEL_PLACEHOLDER enum', Object.values(fam.models).every((m) => /^MODEL_PLACEHOLDER_M\d+$/.test(m.model)));
ok('every model carries apiProvider', Object.values(fam.models).every((m) => m.apiProvider === 'API_PROVIDER_GOOGLE_GEMINI'));
ok('displayName comes from the config', fam.models['agy-bridge:p-anthropic:mock-model-b:medium'].displayName === 'Mock B · Mock Anthropic (Medium)');

const quota_r = await post_payload('/v1internal:retrieveUserQuota', {});
eq('retrieveUserQuota is enveloped', Object.keys(quota_r.raw), ['response']);
const quota = quota_r.payload;
ok('quota is a bucket list', Array.isArray(quota.buckets) && quota.buckets.length > 0, JSON.stringify(quota).slice(0, 200));
eq('quota bucket modelId is the default model', quota.buckets[0].modelId, 'mock-model-a');
eq('quota remainingAmount is a string', quota.buckets[0].remainingAmount, '999999');
eq('quota remainingFraction', quota.buckets[0].remainingFraction, 1);

const quota_summary_r = await post_payload('/v1internal:retrieveUserQuotaSummary', {});
ok('quota summary is a bucket list', Array.isArray(quota_summary_r.payload.buckets));

eq('fetchUserInfo', (await post_payload('/v1internal:fetchUserInfo', {})).payload, {
  email: 'dev@antigravity.local',
  tier: 'PRO',
  name: 'agy-bridge',
});
eq('listExperiments', (await post_payload('/v1internal:listExperiments', { metadata: { updateChannel: 'stable' } })).payload, { experiments: [] });
eq('fetchAdminControls', (await post_payload('/v1internal:fetchAdminControls', {})).payload, { adminControls: [] });
eq('recordCodeAssistMetrics', (await post_payload('/v1internal:recordCodeAssistMetrics', {})).raw, { response: {} });
eq('recordClientEvent', (await post_payload('/v1internal:recordClientEvent', {})).raw, { response: {} });
eq('recordTrajectoryAnalytics', (await post_payload('/v1internal:recordTrajectoryAnalytics', {})).raw, { response: {} });
eq('registerInteraction', (await post_payload('/v1internal:registerInteraction', {})).raw, { response: {} });
eq('setCodeAssistGlobalUserSetting', (await post_payload('/v1internal:setCodeAssistGlobalUserSetting', {})).raw, { response: {} });
eq('getCodeAssistGlobalUserSetting', (await post_payload('/v1internal:getCodeAssistGlobalUserSetting', {})).raw, { response: {} });

const unknown = await post('/v1internal:totallyUnknownMethod', { a: 1 });
eq('unknown endpoint is 200', unknown.status, 200);
eq('unknown endpoint is still enveloped', await unknown.json(), { response: {} });

const root_poll = await get('/v1internal/');
eq('GET /v1internal/ poll is 200', root_poll.status, 200);
eq('GET /v1internal/ poll stays bare', await root_poll.json(), {});

const plugins = await get('/v1internal/buildWithGooglePlugins?page_size=1000');
eq('buildWithGooglePlugins 200', plugins.status, 200);
eq('buildWithGooglePlugins stays bare', await plugins.json(), { plugins: [] });

// ---------------------------------------------------------------------------
// 13. config API
// ---------------------------------------------------------------------------

section('13. config API');

const health = await (await get('/api/health')).json();
eq('health.ok', health.ok, true);
ok('health.version', typeof health.version === 'string' && health.version.length > 0);

const state = await (await get('/api/state')).json();
eq('state.active_provider_id', state.active_provider_id, 'p-openai');
eq('state.default_model', state.default_model, 'mock-model-a');
eq('state.providers masked', state.providers.find((p) => p.id === 'p-openai').api_key, 'sk-***abcd');
ok('state.model_map present', Boolean(state.model_map['mock-model-a']));
ok('state.uptime_s is a number', Number.isFinite(state.uptime_s));
ok('state.request_count counted', state.request_count > 0, String(state.request_count));

const providers_list = await (await get('/api/providers')).json();
eq('providers list length', providers_list.providers.length, 3);
ok('providers list masked', providers_list.providers.every((p) => p.api_key.includes('***')));

const created = await (await post('/api/providers', {
  name: 'Extra Provider',
  kind: 'openai',
  base_url: 'https://extra.example.com',
  api_key: 'sk-extra-1234567890',
  models: [{ id: 'extra-model', display_name: 'Extra', upstream: 'extra-upstream' }],
})).json();
eq('provider created', created.ok, true);
ok('created provider has an id', typeof created.provider.id === 'string' && created.provider.id.length > 0);
eq('created provider masked', created.provider.api_key, 'sk-***7890');
const extra_id = created.provider.id;

const patched = await (await fetch(`${BASE}/api/providers/${extra_id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Renamed', api_key: 'sk-***7890' }),
})).json();
eq('patch ok', patched.ok, true);
eq('patch renamed', patched.provider.name, 'Renamed');
eq('masked api_key on PATCH means unchanged', patched.provider.api_key, 'sk-***7890');

const deleted = await (await fetch(`${BASE}/api/providers/${extra_id}`, { method: 'DELETE' })).json();
eq('delete ok', deleted.ok, true);
eq('delete reports id', deleted.deleted, extra_id);

const map_res = await (await post('/api/model-map', {
  map: {
    'mock-model-a': { provider_id: 'p-openai', upstream: 'mock-gpt', display_name: 'Mock A' },
    'mock-model-b': { provider_id: 'p-anthropic', upstream: 'mock-claude', display_name: 'Mock B' },
    'mock-model-c': { provider_id: 'p-gemini', upstream: 'mock-gemini', display_name: 'Mock C' },
    'mock-model-boom': { provider_id: 'p-openai', upstream: 'boom', display_name: 'Boom' },
    'added-model': { provider_id: 'p-openai', upstream: 'mock-gpt', display_name: 'Added' },
  },
})).json();
eq('model-map updated', map_res.ok, true);
ok('model-map has the new entry', Boolean(map_res.model_map['added-model']));

const active_res = await (await post('/api/active', { active_provider_id: 'p-anthropic', default_model: 'mock-model-b' })).json();
eq('active updated', active_res.active_provider_id, 'p-anthropic');
eq('default model updated', active_res.default_model, 'mock-model-b');

const reloaded = await (await post('/api/reload', {})).json();
eq('reload ok', reloaded.ok, true);
ok('reload reports providers', reloaded.providers === 3, String(reloaded.providers));

const logs = await (await get('/api/logs?limit=50')).json();
ok('logs is an array', Array.isArray(logs));
ok('logs entries have ts/level/msg', logs.every((l) => l.ts && l.level && l.msg));
ok('unmapped_model was logged', logs.some((l) => l.msg === 'unmapped_model'));

// ---------------------------------------------------------------------------
// 14. loopback / rebinding guards
// ---------------------------------------------------------------------------

section('14. security guards');

function raw_request(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const bad_host = await raw_request(bridge.port, '/api/state', { host: 'evil.example.com' });
eq('DNS rebinding via Host is rejected', bad_host.status, 403);

const bad_origin = await raw_request(bridge.port, '/api/state', {
  host: `127.0.0.1:${bridge.port}`,
  origin: 'http://evil.example.com',
});
eq('foreign Origin is rejected', bad_origin.status, 403);

const good_origin = await raw_request(bridge.port, '/api/health', {
  host: `127.0.0.1:${bridge.port}`,
  origin: `http://127.0.0.1:${bridge.port}`,
});
eq('same-origin Origin is allowed', good_origin.status, 200);

// ---------------------------------------------------------------------------
// 15. static
// ---------------------------------------------------------------------------

section('15. static assets');

const root = await get('/');
eq('GET / is 200', root.status, 200);
ok('GET / is html', String(root.headers.get('content-type')).startsWith('text/html'));

const traversal = await raw_request(bridge.port, '/../core/config.js', { host: `127.0.0.1:${bridge.port}` });
ok('path traversal does not leak core/', traversal.status === 403 || traversal.status === 404, String(traversal.status));

// ---------------------------------------------------------------------------
// 16. capture files
// ---------------------------------------------------------------------------

section('16. request capture');

const capture_dir = path.join(TEST_HOME, 'captures');
const captures = fs.existsSync(capture_dir) ? fs.readdirSync(capture_dir).filter((n) => n.endsWith('.json')) : [];
ok('capture directory populated', captures.length > 0, String(captures.length));
if (captures.length) {
  const raw = fs.readFileSync(path.join(capture_dir, captures[0]), 'utf8');
  let parsed_ok = true;
  try {
    JSON.parse(raw);
  } catch {
    parsed_ok = false;
  }
  ok('capture is valid JSON of the raw body', parsed_ok);
}

// ---------------------------------------------------------------------------
// 17. SSE parser unit checks (chunk boundary safety)
// ---------------------------------------------------------------------------

section('17. sse parser');

{
  const events = [];
  const parser = create_sse_parser((evt) => events.push(evt));
  const bytes = Buffer.from('data: {"a":1}\n\ndata: {"b":"中"}\n\n', 'utf8');
  // split in the middle of the multi-byte character
  const split_at = bytes.indexOf(Buffer.from('中', 'utf8')) + 1;
  parser.push(bytes.subarray(0, split_at));
  parser.push(bytes.subarray(split_at));
  parser.end();
  eq('two frames parsed', events.length, 2);
  eq('first frame payload', events[0].data, '{"a":1}');
  eq('utf-8 survives a chunk split', JSON.parse(events[1].data).b, '中');
}

{
  const events = [];
  const parser = create_sse_parser((evt) => events.push(evt));
  parser.push(Buffer.from('event: ping\ndata: x\r\n\r\n', 'utf8'));
  parser.end();
  eq('CRLF framing parsed', events.length, 1);
  eq('event name kept', events[0].event, 'ping');
}

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

await bridge.close();
await control.close();
await new Promise((resolve) => openai_mock.server.close(resolve));
await new Promise((resolve) => anthropic_mock.server.close(resolve));
await new Promise((resolve) => gemini_mock.server.close(resolve));

try {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
} catch {
  // a temp dir we cannot remove is not a test failure
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
