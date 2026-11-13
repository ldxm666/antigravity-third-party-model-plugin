import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply_model_settings } from '../core/model-settings.js';
import { normalize_request, to_openai_request, to_anthropic_request, to_gemini_request } from '../core/translate.js';
import { normalize_provider } from '../core/config.js';

const gen = () => normalize_request({ model: 'test', request: { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }], generationConfig: { temperature: .4, topP: .8, maxOutputTokens: 10000, thinkingConfig: { thinkingBudget: 30000 } } } });
const meta = (extra = {}) => ({ id: 'test', upstream: 'test', ctx: 128000, max_out: 4096, reasoning_effort: 'high', thinking_budget: -1, ...extra });
test('saved limits override the incoming request without mutating it', () => {
  const original = gen(); const result = apply_model_settings(original, meta(), 'openai');
  const wire = to_openai_request(result, { model: 'test' });
  assert.equal(wire.max_tokens, 4096); assert.equal(wire.reasoning_effort, 'high');
  assert.equal(original.generation_config.maxOutputTokens, 10000);
});
test('all OpenAI effort levels are sent explicitly; inherit preserves the application choice', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
    assert.equal(to_openai_request(apply_model_settings(gen(), meta({ reasoning_effort: effort }), 'openai'), { model: 'test' }).reasoning_effort, effort);
  }
  const inherited = gen(); inherited.generation_config.thinkingConfig = { thinkingLevel: 'low' };
  assert.equal(to_openai_request(apply_model_settings(inherited, meta({ reasoning_effort: 'inherit' }), 'openai'), { model: 'test' }).reasoning_effort, 'low');
});
test('context limit rejects before dispatch and also caps output to remaining room', () => {
  assert.throws(() => apply_model_settings(gen(), meta({ ctx: 1 }), 'openai'), /上下文/);
  const g = gen(); delete g.generation_config.thinkingConfig;
  assert.ok(apply_model_settings(g, meta({ ctx: 100 }), 'openai').generation_config.maxOutputTokens < 100);
});
test('Gemini uses level on modern models and token budget on Gemini 2.5', () => {
  assert.deepEqual(to_gemini_request(apply_model_settings(gen(), meta({ upstream: 'gemini-3-pro' }), 'gemini')).generationConfig.thinkingConfig, { thinkingLevel: 'high' });
  assert.deepEqual(to_gemini_request(apply_model_settings(gen(), meta({ upstream: 'gemini-2.5-flash', reasoning_effort: 'low' }), 'gemini')).generationConfig.thinkingConfig, { thinkingBudget: 2048 });
  assert.deepEqual(to_gemini_request(apply_model_settings(gen(), meta({ reasoning_effort: 'budget', thinking_budget: 3072 }), 'gemini')).generationConfig.thinkingConfig, { thinkingBudget: 3072 });
  assert.deepEqual(to_gemini_request(apply_model_settings(gen(), meta({ reasoning_effort: 'none' }), 'gemini')).generationConfig.thinkingConfig, { thinkingBudget: 0 });
});
test('legacy Anthropic budget never enlarges the configured output ceiling', () => {
  const out = to_anthropic_request(apply_model_settings(gen(), meta({ upstream: 'claude-sonnet-4-5' }), 'anthropic'), { model: 'claude-sonnet-4-5' });
  assert.equal(out.max_tokens, 4096); assert.deepEqual(out.thinking, { type: 'enabled', budget_tokens: 4095 });
  assert.equal(out.temperature, undefined); assert.equal(out.top_p, undefined);
  const inherited = to_anthropic_request(apply_model_settings(gen(), meta({ reasoning_effort: 'inherit' }), 'anthropic'), { model: 'test' });
  assert.equal(inherited.max_tokens, 4096); assert.equal(inherited.thinking.budget_tokens, 4095);
});
test('modern Claude supports adaptive effort; incompatible manual budgets fail clearly', () => {
  const out = to_anthropic_request(apply_model_settings(gen(), meta({ upstream: 'claude-opus-4-7', reasoning_effort: 'xhigh' }), 'anthropic'), { model: 'claude-opus-4-7' });
  assert.deepEqual(out.thinking, { type: 'adaptive' }); assert.deepEqual(out.output_config, { effort: 'xhigh' });
  assert.throws(() => apply_model_settings(gen(), meta({ upstream: 'claude-opus-4-7', reasoning_effort: 'budget', thinking_budget: 2048 }), 'anthropic'), /自适应/);
  const off = to_anthropic_request(apply_model_settings(gen(), meta({ reasoning_effort: 'none' }), 'anthropic'), { model: 'test' });
  assert.deepEqual(off.thinking, { type: 'disabled' });
});
test('normalization keeps per-model settings with safe defaults for existing configuration', () => {
  const p = normalize_provider({ models: [meta({ reasoning_effort: 'low', thinking_budget: 3000 }), { id: 'old' }] });
  assert.equal(p.models[0].reasoning_effort, 'low'); assert.equal(p.models[0].thinking_budget, 3000);
  assert.equal(p.models[1].reasoning_effort, 'inherit'); assert.equal(p.models[1].thinking_budget, -1);
});
test('capacity saves reject a full output window before changing memory, mappings or disk', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-capacity-'));
  process.env.AGY_BRIDGE_HOME = home;
  const { start_server } = await import('../core/server.js');
  const bridge = await start_server({ port: 0, config: { providers: [], log_level: 'error' } });
  const call = async (route, method, body) => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/${route}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  try {
    const valid = { name: 'Capacity fixture', kind: 'openai', base_url: 'http://127.0.0.1:1/v1', api_key: 'fixture-secret', models: [meta({ ctx: 1048576, max_out: 256000 })] };
    const created = await call('providers', 'POST', valid);
    assert.equal(created.status, 200);
    assert.equal(created.data.provider.models[0].max_out, 256000, 'valid large output limits must not be arbitrarily capped');
    const beforeDisk = fs.readFileSync(bridge.state.config_path, 'utf8');
    const beforeMemory = JSON.stringify(bridge.state.config);
    for (const max_out of [1048576, 1048577]) {
      const models = [meta({ ctx: 1048576, max_out })];
      const rejectedCreate = await call('providers', 'POST', { ...valid, models });
      assert.equal(rejectedCreate.status, 400);
      assert.equal(rejectedCreate.data.error, 'invalid_model_capacity');
      assert.match(rejectedCreate.data.detail, /最大输出必须小于上下文窗口/);
      const rejectedPatch = await call(`providers/${created.data.provider.id}`, 'PATCH', { name: 'Must not change', api_key: 'must-not-persist', models });
      assert.equal(rejectedPatch.status, 400);
      assert.equal(rejectedPatch.data.error, 'invalid_model_capacity');
      assert.equal(JSON.stringify(bridge.state.config), beforeMemory, 'a rejected save must leave names, keys, models and mappings intact');
      assert.equal(fs.readFileSync(bridge.state.config_path, 'utf8'), beforeDisk, 'a rejected save must not touch the configuration file');
    }
    const validPatch = await call(`providers/${created.data.provider.id}`, 'PATCH', { models: [meta({ ctx: 1048576, max_out: 65536 })] });
    assert.equal(validPatch.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(bridge.state.config_path)).providers[0].models[0].max_out, 65536);
  } finally { await bridge.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('API save -> disk -> generation forwards saved effort and limits, and rejects oversized context', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-model-settings-'));
  process.env.AGY_BRIDGE_HOME = home;
  const { start_server } = await import('../core/server.js');
  const seen = []; const auth = [];
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'preview-model' }] })); return; }
      seen.push(JSON.parse(Buffer.concat(chunks))); auth.push(req.headers.authorization);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const bridge = await start_server({ port: 0, config: { providers: [], log_level: 'error' } });
  const url = `http://127.0.0.1:${bridge.port}`;
  const call = async (route, method, data) => {
    const res = await fetch(url + route, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    return { status: res.status, data: await res.json() };
  };
  try {
    const created = await call('/api/providers', 'POST', { name: 'Settings integration', kind: 'openai', api_key: 'original-private-key', base_url: `http://127.0.0.1:${upstream.address().port}/v1`, models: [meta()] });
    assert.equal(created.status, 200);
    const id = created.data.provider.id;
    const saved = await call(`/api/providers/${id}`, 'PATCH', { api_key: '', models: [meta({ ctx: 8000, max_out: 3000, reasoning_effort: 'low' })] });
    assert.equal(saved.status, 200);
    const stored = JSON.parse(fs.readFileSync(bridge.state.config_path));
    assert.equal(stored.providers[0].api_key, 'original-private-key', 'blank edit must preserve the stored key');
    assert.equal(stored.providers[0].models[0].reasoning_effort, 'low');
    assert.equal(stored.providers[0].models[0].ctx, 8000); assert.equal(stored.providers[0].models[0].max_out, 3000);
    const beforePreview = fs.readFileSync(bridge.state.config_path, 'utf8');
    const preview = await call('/api/providers/preview', 'POST', { base_url: `http://127.0.0.1:${upstream.address().port}`, kind: 'openai', api_key: 'preview-only-key', operation: 'fetch-models' });
    assert.equal(preview.data.ok, true); assert.equal(preview.data.models[0].id, 'preview-model');
    assert.equal(fs.readFileSync(bridge.state.config_path, 'utf8'), beforePreview, 'preview must not persist a provider or secret');
    const request = { model: 'test', request: { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }], generationConfig: { maxOutputTokens: 9000 } } };
    assert.equal((await call('/v1internal:generateContent', 'POST', request)).status, 200);
    assert.equal(seen[0].max_tokens, 3000); assert.equal(seen[0].reasoning_effort, 'low');
    request.request.contents[0].parts[0].text = 'a'.repeat(40000);
    const rejected = await call('/v1internal:generateContent', 'POST', request);
    assert.equal(rejected.status, 400); assert.match(JSON.stringify(rejected.data), /上下文/); assert.equal(seen.length, 1);
    await call(`/api/providers/${id}`, 'PATCH', { models: [] });
    assert.equal(bridge.state.config.model_map.test, undefined, 'deleted model must leave the auto catalogue');
    const shared = meta({ id: 'gemini-3.8-flash', upstream: 'gemini-3.8-flash' });
    await call(`/api/providers/${id}`, 'PATCH', { models: [shared] });
    const second = await call('/api/providers', 'POST', { name: 'Second provider', kind: 'openai', api_key: 'second-key', base_url: `http://127.0.0.1:${upstream.address().port}/v1`, models: [shared] });
    const scoped = `agy-bridge:${encodeURIComponent(second.data.provider.id)}:gemini-3.8-flash:low`;
    request.model = scoped; request.request.contents[0].parts[0].text = 'Hi';
    assert.equal((await call('/v1internal:generateContent', 'POST', request)).status, 200);
    assert.equal(seen.at(-1).reasoning_effort, 'low', 'native selection overrides the configured high default');
    assert.equal(auth.at(-1), 'Bearer second-key', 'same model ID must still route to its selected provider');
  } finally { await bridge.close(); await new Promise(r => upstream.close(r)); fs.rmSync(home, { recursive: true, force: true }); }
});
