import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize_provider, normalize_config } from '../core/config.js';
import { custom_picker_models, merge_available_models } from '../core/bootstrap.js';
import { read_model_metadata, catalogue_model, configure_models } from '../core/model-capabilities.js';
import { list_provider_models } from '../core/providers/index.js';

test('explicit effort lists are the entire native menu, including nonstandard levels', () => {
  const provider = normalize_provider({ id: 'p', name: 'P', models: [{ id: 'gemini-3.8-flash', reasoning_efforts: ['none', 'minimal', 'high'], reasoning_effort: 'high', supports_images: false }] });
  const config = { providers: [provider], active_provider_id: 'p', default_model: provider.models[0].id };
  const rows = custom_picker_models(config);
  assert.deepEqual(rows.map(r => r.effort), ['none', 'minimal', 'high']);
  assert.equal(rows.filter(r => r.is_default).length, 1);
  assert.equal(rows.find(r => r.is_default).effort, 'high');
  assert.match(rows[0].label, /\(None\)$/);
  const wire = merge_available_models({ models: { official: { model: 'MODEL_PLACEHOLDER_M50', supportsImages: true } } }, config);
  assert.equal(wire.models.official.supportsImages, true);
  for (const [id, row] of Object.entries(wire.models)) if (id.startsWith('agy-bridge:')) assert.equal(row.supportsImages, false);
});
test('removed default cannot reintroduce a disabled effort; one selected level remains one', () => {
  const p = normalize_provider({ id: 'p', models: [{ id: 'm', reasoning_efforts: ['none', 'none', 'bogus'], reasoning_effort: 'high' }] });
  assert.deepEqual(p.models[0].reasoning_efforts, ['none']);
  assert.equal(p.models[0].reasoning_effort, 'none');
  assert.deepEqual(custom_picker_models({ providers: [p] }).map(m => m.effort), ['none']);
});
test('legacy migration preserves the default and normalizes idempotently', () => {
  const p = normalize_provider({ id:'legacy',models:[{id:'gemini-3.8-flash',reasoning_effort:'inherit'}] });
  assert.equal(p.models[0].reasoning_effort,'inherit');
  assert.ok(p.models[0].reasoning_efforts.includes('inherit'));
  assert.deepEqual(normalize_provider(p),p);
});
test('raw request capture is opt-in, including for existing configuration', () => {
  assert.equal(normalize_config({}).capture_requests,false);
  assert.equal(normalize_config({capture_requests:true}).capture_requests,true);
  assert.equal(normalize_config({capture_requests:'true'}).capture_requests,false);
});
test('reads Gemini, Anthropic and relay metadata with explicit false and effort limits', () => {
  const g = read_model_metadata({ name: 'models/gemini-3.8-flash', inputTokenLimit: 1000000, outputTokenLimit: 64000 }, 'gemini');
  assert.equal(g.id, 'gemini-3.8-flash'); assert.equal(g.ctx, 1000000); assert.equal(g.max_out, 64000);
  const a = read_model_metadata({ id: 'claude-opus-4-6', max_input_tokens: 1000000, max_tokens: 128000, capabilities: { image_input: { supported: false }, effort: { supported: true, low: true, medium: false, high: true, max: true } } }, 'anthropic');
  assert.equal(a.supports_images, false); assert.deepEqual(a.reasoning_efforts, ['low', 'high', 'max']);
  const o = read_model_metadata({ id: 'text', context_length: 32000, top_provider: { max_completion_tokens: 4096 }, architecture: { input_modalities: ['text'] }, supported_reasoning_efforts: ['minimal', 'high'] });
  assert.equal(o.ctx, 32000); assert.equal(o.max_out, 4096); assert.equal(o.supports_images, false); assert.deepEqual(o.reasoning_efforts, ['minimal', 'high']);
});
test('fallback catalogue is bounded to known names and preserves future unknowns', () => {
  assert.equal(catalogue_model('gemini-3.8-flash').ctx, 1048576);
  assert.deepEqual(catalogue_model('gemini-3-pro-preview').reasoning_efforts, ['low', 'high']);
  assert.equal(catalogue_model('gemini-99-flash').ctx, undefined);
  assert.equal(catalogue_model('arbitrary-pro').supports_images, undefined);
});
test('auto configuration prioritizes model details, then list, then table; never adds models or saves', async () => {
  const requests = []; let active = 0, peak = 0;
  const upstream = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization }); active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5)); active--;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'gemini-3.8-flash', context_length: 80000, max_output_tokens: 10000, supports_images: true, reasoning_efforts: ['low', 'medium', 'high'] }, { id: 'not-added' }] })); return; }
    if (req.url === '/v1/models/gemini-3.8-flash') { res.end(JSON.stringify({ id: 'gemini-3.8-flash', context_length: 64000, max_output_tokens: 4096, supports_images: false, reasoning_efforts: ['none', 'high'] })); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const p = normalize_provider({ id: 'p', kind: 'openai', base_url: `http://127.0.0.1:${upstream.address().port}`, api_key: 'test-only', models: [{ id: 'gemini-3.8-flash' }, { id: 'gemini-3.1-pro-high' }, { id: 'unknown', ctx: 16000, max_out: 2000, supports_images: false, reasoning_efforts: ['inherit'] }] });
  try {
    const list = await list_provider_models(p, { connect_ms: 1000 });
    assert.equal(list.models[0].ctx, 80000, 'adapter must retain endpoint metadata');
    const result = await configure_models(p, { connect_ms: 1000 }, list);
    assert.equal(result.models.length, 3); assert.equal(result.models[0].ctx, 64000); assert.equal(result.models[0].max_out, 4096);
    assert.equal(result.models[0].supports_images, false); assert.deepEqual(result.models[0].reasoning_efforts, ['none', 'high']);
    assert.equal(result.models[0].config_sources.ctx, 'endpoint:detail');
    assert.equal(result.models[1].ctx, 1048576); assert.match(result.models[1].config_sources.ctx, /^table:/);
    assert.equal(result.models[2].ctx, 16000); assert.equal(result.models[2].max_out, 2000); assert.deepEqual(result.unknown, ['unknown']);
    assert.ok(peak <= 4); assert.ok(requests.every(r => r.method === 'GET' && r.auth === 'Bearer test-only'));
  } finally { await new Promise(r => upstream.close(r)); }
});
test('discovery warns about inconsistent endpoint capacities without fabricating limits', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(404); res.end('{}'); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const provider = normalize_provider({ base_url: `http://127.0.0.1:${upstream.address().port}`, models: [{ id: 'equal-limit' }, { id: 'excess-limit' }] });
  const rows = [{ id: 'equal-limit', ctx: 64000, max_out: 64000 }, { id: 'excess-limit', ctx: 64000, max_out: 128000 }];
  const before = JSON.stringify(provider);
  try {
    const result = await configure_models(provider, { connect_ms: 1000 }, { ok: true, models: rows });
    assert.deepEqual(result.models.map(m => [m.ctx, m.max_out]), [[64000, 64000], [64000, 128000]]);
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.every(w => w.includes('最大输出必须小于上下文窗口')));
    assert.equal(JSON.stringify(provider), before, 'discovery changes only the returned draft');
  } finally { await new Promise(r => upstream.close(r)); }
});

test('configure preview updates only draft and does not overwrite saved secrets or add returned models', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-capabilities-')); process.env.AGY_BRIDGE_HOME = home;
  const { start_server } = await import('../core/server.js');
  const upstream = http.createServer((req, res) => { res.setHeader('content-type','application/json'); if (req.url.endsWith('/models')) res.end(JSON.stringify({ data: [{ id: 'gemini-3.8-flash', context_length: 96000, max_output_tokens: 2048, reasoning_efforts: ['minimal', 'high'] }, { id: 'extra' }] })); else { res.writeHead(404); res.end('{}'); } });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const bridge = await start_server({ port: 0, config: { providers: [], log_level: 'error' } });
  const call = async (route, body) => { const res = await fetch(`http://127.0.0.1:${bridge.port}/api/${route}`, { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body) });return {status:res.status,data:await res.json()}; };
  try {
    const created = await call('providers', { name:'caps',kind:'openai',base_url:`http://127.0.0.1:${upstream.address().port}`,api_key:'keep-private',models:[{id:'gemini-3.8-flash'}] });
    const before = fs.readFileSync(bridge.state.config_path,'utf8');
    const result = await call('providers/preview', { id:created.data.provider.id,api_key:'',operation:'configure-models' });
    assert.equal(result.status,200);assert.equal(result.data.models.length,1);assert.equal(result.data.models[0].ctx,96000);
    assert.deepEqual(result.data.models[0].reasoning_efforts,['minimal','high']);assert.equal(result.data.models[0].supports_images,true);
    assert.equal(fs.readFileSync(bridge.state.config_path,'utf8'),before); assert.ok(!JSON.stringify(result.data).includes('keep-private'));
    const disabled = await fetch(`http://127.0.0.1:${bridge.port}/v1internal:generateContent`, { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:`agy-bridge:${created.data.provider.id}:gemini-3.8-flash:xhigh`,request:{contents:[{role:'user',parts:[{text:'hi'}]}]}}) });
    assert.equal(disabled.status,400,'an effort removed from the menu must not silently fall back to another model');
  } finally { await bridge.close(); await new Promise(r => upstream.close(r)); fs.rmSync(home,{recursive:true,force:true}); }
});
