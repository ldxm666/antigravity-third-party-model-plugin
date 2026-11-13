import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../patch/native-request-policy.js', import.meta.url), 'utf8');
function policy() { const window = {}; vm.runInNewContext(source, { window }); return window.__agyNativeRequests; }
const rows = [{ modelId: 'agy-bridge:fixture:model:medium', modelOrAlias: { choice: { case: 'model', value: 999 } } }];

test('native third-party requests show errors and bound retries without mutating the caller', () => {
  const p = policy();
  const args = { cascadeId: 'fixture', cascadeConfig: { plannerConfig: { planModel: 999, requestedModel: 999, maxOutputTokens: 32768, retryConfig: { apiRetry: { maxRetries: 5, initialSleepDurationMs: 4000 }, modelOutputRetry: { maxRetries: 3, forbidToolUse: true } } } } };
  const before = JSON.stringify(args), result = p.rewrite(args, rows), config = result.cascadeConfig.plannerConfig;
  assert.equal(config.showAllErrors, true); assert.equal(config.retryConfig.apiRetry.maxRetries, 0);
  assert.equal(config.retryConfig.apiRetry.initialSleepDurationMs, 4000);
  assert.equal(config.retryConfig.modelOutputRetry, args.cascadeConfig.plannerConfig.retryConfig.modelOutputRetry);
  assert.equal(config.maxOutputTokens, 32768); assert.equal(JSON.stringify(args), before);
  assert.equal(config.retryConfig.$typeName, 'exa.cortex_pb.PlannerRetryConfig');
  assert.equal(config.retryConfig.apiRetry.$typeName, 'exa.cortex_pb.ModelAPIRetryConfig');
});
test('Google and incomplete requests keep their original objects and policy', () => {
  const p = policy();
  for (const args of [{}, { cascadeConfig: {} }, { cascadeConfig: { plannerConfig: { planModel: 50, retryConfig: { apiRetry: { maxRetries: 5 } } } } }]) assert.equal(p.rewrite(args, rows), args);
  const scoped = { cascadeConfig: { plannerConfig: { modelName: 'agy-bridge:fixture:model:low', retryConfig: { modelOutputRetry: { maxRetries: 0 } } } } };
  assert.equal(p.rewrite(scoped).cascadeConfig.plannerConfig.retryConfig.modelOutputRetry.maxRetries, 0);
});
test('native client hooks preserve arguments, binding, return value and safe disposal', async () => {
  const p = policy(); let received, binding;
  const original = function (args, options) { binding = this; received = { args, options }; return Promise.resolve('sent'); };
  const client = { sendUserCascadeMessage: original }; p.install(client, () => rows); const first = client.sendUserCascadeMessage;
  p.install(client, () => rows); assert.equal(client.sendUserCascadeMessage, first);
  assert.equal(await client.sendUserCascadeMessage({ cascadeConfig: { plannerConfig: { planModel: 999 } } }, 'options'), 'sent');
  assert.equal(binding, client); assert.equal(received.options, 'options'); assert.equal(received.args.cascadeConfig.plannerConfig.showAllErrors, true);
  p.dispose(); assert.equal(client.sendUserCascadeMessage, original);
});
