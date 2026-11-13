import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapter_for } from '../core/providers/index.js';
import { normalize_request } from '../core/translate.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-provider-auth-'));
process.env.AGY_BRIDGE_HOME = home;
const { start_server } = await import('../core/server.js');
const gen = normalize_request({ contents: [{ role: 'user', parts: [{ text: 'fixture' }] }] });
const ctx = { upstream_model: 'fixture', timeouts: { request_ms: 1000, stream_idle_ms: 500 } };
let status = 401;
const upstream = http.createServer((req, res) => {
  req.resume(); req.on('end', () => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: status === 401 ? 'All available accounts exhausted' : 'Provider key has no permission' } }));
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const provider = { base_url: `http://127.0.0.1:${upstream.address().port}`, api_key: 'fixture' };
try {
  await test('third-party credentials never become Google authentication errors', async t => {
    for (const kind of ['openai', 'anthropic', 'gemini']) for (const denial of [401, 403]) for (const mode of ['stream', 'complete']) {
      await t.test(`${kind} ${mode}: upstream ${denial} stays a provider failure`, async () => {
        status = denial;
        const invoke = async () => {
          if (mode === 'complete') return adapter_for(kind).complete(provider, gen, ctx);
          for await (const ignored of adapter_for(kind).stream(provider, gen, ctx)) { /* consume fixture */ }
        };
        await assert.rejects(invoke, error => {
          assert.equal(error.code, 502); assert.equal(error.http_status, denial);
          const payload = error.to_gemini().error;
          assert.equal(payload.status, 'UNAVAILABLE'); assert.match(payload.message, /第三方提供商/);
          assert.match(payload.message, new RegExp(`HTTP ${denial}`));
          return true;
        });
      });
    }
  });

  await test('native inference HTTP exposes provider 401 as 502 while Google auth remains 401', async () => {
    status = 401;
    const bridge = await start_server({ port: 0, control_plane_url: provider.base_url,
      config: { log_level: 'error', active_provider_id: 'fixture', default_model: 'model',
        providers: [{ ...provider, id: 'fixture', name: 'fixture', kind: 'openai', models: [{ id: 'model' }] }] } });
    try {
      const origin = `http://127.0.0.1:${bridge.port}`;
      const response = await fetch(origin + '/v1internal:streamGenerateContent', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'agy-bridge:fixture:model:inherit',
          request: { contents: [{ role: 'user', parts: [{ text: 'fixture' }] }] } }) });
      assert.equal(response.status, 502);
      const error = (await response.json()).error;
      assert.equal(error.code, 502); assert.equal(error.status, 'UNAVAILABLE'); assert.match(error.message, /All available accounts exhausted/);
      const google = await fetch(origin + '/v1internal:loadCodeAssist', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(google.status, 401); assert.equal(google.headers.get('x-agy-control-plane'), 'google');
    } finally { await bridge.close(); }
  });
} finally {
  await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  fs.rmSync(home, { recursive: true, force: true });
}
