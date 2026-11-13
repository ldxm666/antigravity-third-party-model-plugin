import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { adapter_for } from '../core/providers/index.js';
import { normalize_request } from '../core/translate.js';

await test('provider generation deadlines', async t => {
  let mode = 'late-headers';
  let kind = 'openai';
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const payload = kind === 'openai'
        ? { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }
        : kind === 'anthropic' ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
        : { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] };
      let timer;
      res.on('close', () => clearTimeout(timer));
      if (mode === 'late-headers') timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
      }, 45);
      else if (mode === 'late-body') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders();
        timer = setTimeout(() => res.end(JSON.stringify(payload)), 180);
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
        // A live TCP connection with no more stream data must time out.
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const gen = normalize_request({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
  const provider = { base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'test' };
  const ctx = { upstream_model: 'test', timeouts: { connect_ms: 10, request_ms: 120, stream_idle_ms: 30 } };
  try {
    for (const protocol of ['openai', 'anthropic', 'gemini']) {
      kind = protocol;
      await t.test(`${protocol}: generation may take longer than the connectivity probe deadline`, async () => {
        mode = 'late-headers';
        const result = await adapter_for(protocol).complete(provider, gen, ctx);
        assert.equal(result.parts[0].text, 'ok');
      });
      await t.test(`${protocol}: the response body remains bounded after headers arrive`, async () => {
        mode = 'late-body';
        await assert.rejects(adapter_for(protocol).complete(provider, gen,
          { ...ctx, timeouts: { ...ctx.timeouts, request_ms: 50 } }), e => e.code === 504);
      });
    }
    await t.test('stream idle deadline applies after the first response', async () => {
      kind = 'openai'; mode = 'stalled-stream';
      const deltas = [];
      await assert.rejects(async () => {
        for await (const delta of adapter_for(kind).stream(provider, gen, ctx)) deltas.push(delta);
      }, /upstream stream failed/);
      assert.equal(deltas[0].text, 'start');
    });
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});
