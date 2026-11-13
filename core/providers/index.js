// language: JavaScript (ESM), file: providers/index.js, target: Node 24, deps: node: builtins only

import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';

const REGISTRY = { openai, anthropic, gemini };

export function adapter_for(kind) {
  return REGISTRY[kind] || REGISTRY.openai;
}

export function provider_kinds() {
  return Object.keys(REGISTRY);
}

export async function probe_provider(provider, timeouts) {
  const adapter = adapter_for(provider.kind);
  try {
    return await adapter.probe(provider, timeouts);
  } catch (err) {
    return {
      ok: false,
      latency_ms: 0,
      http_status: 0,
      detail: err && err.message ? err.message : String(err),
    };
  }
}

export async function list_provider_models(provider, timeouts) {
  const adapter = adapter_for(provider.kind);
  try {
    return await adapter.list_models(provider, timeouts);
  } catch (err) {
    return {
      ok: false,
      latency_ms: 0,
      http_status: 0,
      detail: err && err.message ? err.message : String(err),
      models: [],
    };
  }
}
