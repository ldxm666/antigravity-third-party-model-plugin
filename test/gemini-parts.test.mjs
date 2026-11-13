import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { adapter_for } from '../core/providers/index.js';
import { normalize_request, chunk_for_delta, to_gemini_request } from '../core/translate.js';
import { apply_model_settings } from '../core/model-settings.js';

test('Gemini parts retain thought signatures and function IDs through streaming and tool history', async () => {
  const parts = [
    { text: 'Considering the task', thought: true, thoughtSignature: 'fixture-thought' },
    { functionCall: { id: 'call-fixture', name: 'write_file', args: { path: 'fixture.html', content: '<svg />' } }, thoughtSignature: 'fixture-call' },
    { thoughtSignature: 'fixture-final-signature' },
  ];
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const part of parts) res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [part] } }] })}\n\n`);
      res.end('data: {"candidates":[{"finishReason":"STOP"}]}\n\n');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const gen = normalize_request({ contents: [{ role: 'user', parts: [{ text: 'create fixture' }] }] });
    const forwarded = [];
    for await (const d of adapter_for('gemini').stream({ base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'fixture' }, gen,
      { upstream_model: 'gemini-fixture', timeouts: { request_ms: 2000, stream_idle_ms: 1000 } })) {
      const frame = chunk_for_delta(d, 'fixture');
      forwarded.push(...(frame?.candidates?.[0]?.content?.parts || []));
    }
    assert.deepEqual(forwarded, parts);
    const history = normalize_request({ contents: [
      ...gen.contents, { role: 'model', parts: forwarded },
      { role: 'user', parts: [{ functionResponse: { id: 'call-fixture', name: 'write_file', response: { ok: true } } }] },
    ] });
    assert.deepEqual(to_gemini_request(history).contents[1].parts, parts);
    assert.equal(to_gemini_request(history).contents[2].parts[0].functionResponse.id, 'call-fixture');
  } finally { await new Promise(r => { server.close(r); server.closeAllConnections(); }); }
});

test('Gemini non-streaming responses preserve original parts', async () => {
  const parts = [{ functionCall: { id: 'call-1', name: 'read_file', args: { path: 'x' } }, thoughtSignature: 'signed-fixture' }];
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ content: { parts }, finishReason: 'STOP' }] })); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const result = await adapter_for('gemini').complete({ base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'fixture' }, normalize_request({ contents: [] }), { upstream_model: 'test', timeouts: { request_ms: 1000 } });
    assert.deepEqual(result.parts, parts);
  } finally { await new Promise(r => { server.close(r); server.closeAllConnections(); }); }
});

test('Gemini JSON stream fallback cannot wait forever after early headers', async () => {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(async () => {
      for await (const _ of adapter_for('gemini').stream({ base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'fixture' }, normalize_request({ contents: [] }), { upstream_model: 'test', timeouts: { request_ms: 500, stream_idle_ms: 50 } })) { /* consume */ }
    }, e => e.code === 504);
  } finally { await new Promise(r => { server.close(r); server.closeAllConnections(); }); }
});

test('Gemini reasoning override preserves the caller choice to show thought summaries', () => {
  for (const includeThoughts of [true, false]) {
    const gen = normalize_request({ contents: [], generationConfig: { thinkingConfig: { thinkingLevel: 'high', includeThoughts } } });
    const result = apply_model_settings(gen, { reasoning_effort: 'low', upstream: 'gemini-3-flash', ctx: 128000, max_out: 4096 }, 'gemini');
    assert.deepEqual(result.generation_config.thinkingConfig, { thinkingLevel: 'low', includeThoughts });
    assert.equal(gen.generation_config.thinkingConfig.thinkingLevel, 'high');
  }
});
