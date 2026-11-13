import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-passthrough-'));
process.env.AGY_BRIDGE_HOME = home;
const { start_server } = await import('../core/server.js');

await test('Google control plane and provider routing', async t => {
  const seen = [];
  let status = 200;
  const quota = '{ "response": {"buckets":[{"remainingFraction":0.13}]}, "opaque":"kept" }';
  const official = {
    response: {
      models: { 'official-model': { displayName: 'Official', model: 'MODEL_OFFICIAL', quotaInfo: { remainingFraction: 0.13 } } },
      agentModelSorts: [{ displayName: 'Google', groups: [{ displayName: 'Original', modelIds: ['official-model'] }] }],
      defaultAgentModelId: 'official-model', tabModelIds: ['official-model'],
      tieredModelIds: { pro: ['official-model'] }, opaqueFutureField: { keep: true },
    }, version: 'upstream-v99',
  };
  const sse = 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"official"}]}}]}}\n\n';
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, body });
      let output;
      let headers = { 'content-type': 'application/json', 'x-upstream-header': 'preserved' };
      let code = status;
      if (req.url.startsWith('/v1internal:fetchAvailableModels')) {
        output = JSON.stringify(official);
        if (req.url.includes('gzip')) { output = gzipSync(output); headers['content-encoding'] = 'gzip'; }
      } else if (req.url.startsWith('/v1internal:streamGenerateContent')) {
        output = sse;
        headers['content-type'] = 'text/event-stream';
      } else if (req.url === '/v1/chat/completions') {
        code = 200;
        output = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'third-party' }, finish_reason: 'stop' }] });
      } else if (req.url.includes('futureRpc')) {
        code = 404; output = '{"error":{"code":404,"message":"future method"}}';
      } else if (code >= 400) {
        output = JSON.stringify({ error: { code, message: 'real upstream rejection' } });
      } else output = quota;
      res.writeHead(code, headers); res.end(output);
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${upstream.address().port}`;
  const config = {
    default_model: 'custom-model', active_provider_id: 'p', log_level: 'error',
    providers: [{ id: 'p', name: 'Local test', kind: 'openai', base_url: url + '/v1', api_key: 'provider-only-key',
      models: [{ id: 'custom-model', display_name: 'Custom model', upstream: 'upstream-custom' }] }],
    model_map: { 'custom-model': { provider_id: 'p', upstream: 'upstream-custom', display_name: 'Custom model' } },
  };
  const bridge = await start_server({ config, port: 0, control_plane_url: url, control_plane_cache_ms: 500 });
  const local = `http://127.0.0.1:${bridge.port}`;
  const post = (name, body = '{"project":"real-project"}', account = 'google-alice') => fetch(local + '/v1internal:' + name, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${account}` }, body,
  });
  try {
    await t.test('identity, tier and quota responses keep their bytes and headers', async () => {
      for (const name of ['loadCodeAssist', 'fetchUserInfo', 'retrieveUserQuota']) {
        const r = await post(name);
        assert.equal(r.status, 200); assert.equal(await r.text(), quota);
        assert.equal(r.headers.get('x-upstream-header'), 'preserved');
        assert.equal(r.headers.get('x-agy-control-plane'), 'google');
        assert.equal(seen.at(-1).auth, 'Bearer google-alice');
      }
    });
    await t.test('unknown RPCs, query parameters and original request bytes are forwarded', async () => {
      const raw = ' {"futureField":1, "spacing": "retained"} ';
      const r = await post('futureRpc?mode=unchanged', raw);
      assert.equal(r.status, 404); assert.match(await r.text(), /future method/);
      assert.equal(seen.at(-1).path, '/v1internal:futureRpc?mode=unchanged');
      assert.equal(seen.at(-1).body, raw);
    });
    await t.test('catalogue keeps official models, groups and quota and adds the configured model', async () => {
      const r = await post('fetchAvailableModels?gzip=1');
      const data = await r.json();
      assert.equal(r.headers.get('content-encoding'), null);
      assert.equal(data.version, official.version);
      assert.deepEqual(data.response.models['official-model'], official.response.models['official-model']);
      assert.deepEqual(data.response.agentModelSorts[0].groups[0], { displayName: 'Original', modelIds: ['agy-bridge:p:custom-model:inherit', 'official-model'] });
      assert.deepEqual(data.response.opaqueFutureField, { keep: true });
      assert.deepEqual(data.response.tabModelIds, ['official-model']);
      assert.deepEqual(data.response.tieredModelIds, official.response.tieredModelIds);
      assert.equal(data.response.defaultAgentModelId, 'agy-bridge:p:custom-model:inherit');
      assert.equal(data.response.models['agy-bridge:p:custom-model:inherit'].quotaInfo, undefined);
      assert.deepEqual(official.response.agentModelSorts[0].groups[0].modelIds, ['official-model']);
    });
    await t.test('native Google model streams unchanged through the bridge', async () => {
      const before = seen.length;
      const body = '{"model":"official-model","request":{"contents":[]}}';
      const r = await post('streamGenerateContent?alt=sse', body);
      assert.equal(await r.text(), sse); assert.equal(r.status, 200);
      assert.ok(r.headers.get('x-agy-trace-id'));
      assert.equal(seen.length, before + 1); assert.equal(seen.at(-1).auth, 'Bearer google-alice');
      assert.equal(seen.at(-1).body, body);
    });
    await t.test('custom placeholder reaches only its provider using the provider key', async () => {
      const catalogue = await (await post('fetchAvailableModels')).json();
      const token = catalogue.response.models['agy-bridge:p:custom-model:inherit'].model;
      const before = seen.length;
      const r = await post('generateContent', JSON.stringify({ model: token,
        request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } }));
      const data = await r.json();
      assert.equal(r.status, 200); assert.equal(data.response.candidates[0].content.parts[0].text, 'third-party');
      assert.equal(seen.length, before + 1); assert.equal(seen.at(-1).path, '/v1/chat/completions');
      assert.equal(seen.at(-1).auth, 'Bearer provider-only-key');
      assert.equal(JSON.parse(seen.at(-1).body).model, 'upstream-custom');
    });
    await t.test('settings writes are forwarded and never replayed from cache', async () => {
      status = 200; await (await post('setUserSettings', '{"userSettings":{"model":"custom-model"}}')).text();
      assert.equal(seen.at(-1).path, '/v1internal:setUserSettings');
      status = 503;
      const r = await post('setUserSettings', '{"userSettings":{"model":"custom-model"}}');
      assert.equal(r.status, 503); assert.equal(r.headers.get('x-agy-control-plane'), 'google'); await r.text();
    });
    await t.test('brief Google failure uses only the same account and request cache', async () => {
      status = 200; await (await post('retrieveUserQuota', '{"cache":"same-request"}')).text();
      status = 503;
      const cached = await post('retrieveUserQuota', '{"cache":"same-request"}');
      assert.equal(cached.status, 200); assert.equal(await cached.text(), quota);
      assert.equal(cached.headers.get('x-agy-control-plane'), 'cache');
      const other = await post('retrieveUserQuota', '{"cache":"same-request"}', 'google-bob');
      assert.equal(other.status, 503); await other.text();
      const different = await post('retrieveUserQuota', '{"cache":"different-request"}');
      assert.equal(different.status, 503); await different.text();
    });
    for (const denial of [401, 403, 429]) await t.test(`HTTP ${denial} passes through and invalidates earlier success`, async () => {
      const body = JSON.stringify({ denial });
      status = 200; await (await post('loadCodeAssist', body)).text();
      status = denial;
      const denied = await post('loadCodeAssist', body); assert.equal(denied.status, denial); await denied.text();
      status = 503;
      const unavailable = await post('loadCodeAssist', body); assert.equal(unavailable.status, 503); await unavailable.text();
    });
    await t.test('expired cache never fabricates an authenticated response', async () => {
      status = 200; await (await post('fetchUserInfo', '{"expiry":true}')).text();
      await new Promise(resolve => setTimeout(resolve, 550));
      status = 503;
      const r = await post('fetchUserInfo', '{"expiry":true}'); assert.equal(r.status, 503); await r.text();
    });
  } finally {
    await bridge.close();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    // Only remove this test's explicitly created temporary directory.
    fs.rmSync(home, { recursive: true, force: true });
  }
});
