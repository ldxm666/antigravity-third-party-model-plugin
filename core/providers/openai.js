// language: JavaScript (ESM), file: providers/openai.js, target: Node 24, deps: node: builtins only
//
// OpenAI /chat/completions adapter. Covers every "OpenAI compatible" relay:
// content, reasoning_content, streaming tool_calls, and the trailing usage chunk.

import { create_sse_parser } from '../sse.js';
import { read_model_metadata } from '../model-capabilities.js';
import {
  finish_reason_from_openai,
  parts_from_openai_message,
  parse_json_loose,
  to_openai_request,
} from '../translate.js';
import {
  ProviderError,
  auth_headers,
  error_from_response,
  join_url,
  make_timeout_controller,
  normalize_base,
  read_error_detail,
  request,
  read_json_response,
} from './base.js';

export const kind = 'openai';

function endpoint(provider, path) {
  const base = normalize_base('openai', provider.base_url);
  if (!base) throw new ProviderError(400, 'provider base_url is empty');
  return join_url(base, path);
}

function headers(provider) {
  return { ...auth_headers('openai', provider.api_key) };
}

/** OpenAI streams tool arguments as fragments; hold them until the call closes. */
function absorb_tool_delta(buffer, calls) {
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    const index = Number.isFinite(Number(call.index)) ? Number(call.index) : 0;
    let slot = buffer.get(index);
    if (!slot) {
      slot = { id: '', name: '', args: '' };
      buffer.set(index, slot);
    }
    if (typeof call.id === 'string' && call.id) slot.id = call.id;
    const fn = call.function && typeof call.function === 'object' ? call.function : {};
    if (typeof fn.name === 'string' && fn.name) slot.name = fn.name;
    if (typeof fn.arguments === 'string') slot.args += fn.arguments;
  }
}

function flush_tool_calls(buffer) {
  const out = [];
  for (const index of [...buffer.keys()].sort((a, b) => a - b)) {
    const slot = buffer.get(index);
    if (!slot || !slot.name) continue;
    out.push({ kind: 'tool_call', id: slot.id, name: slot.name, args: parse_json_loose(slot.args) });
  }
  buffer.clear();
  return out;
}

function delta_text(delta) {
  if (typeof delta.content === 'string') return delta.content;
  if (Array.isArray(delta.content)) {
    let out = '';
    for (const block of delta.content) {
      if (block && typeof block === 'object' && typeof block.text === 'string') out += block.text;
    }
    return out;
  }
  return '';
}

function reasoning_text(delta) {
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    const value = delta[key];
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object' && typeof value.text === 'string' && value.text) return value.text;
  }
  return '';
}

export async function* stream(provider, gen, ctx) {
  const url = endpoint(provider, 'chat/completions');
  const payload = to_openai_request(gen, { model: ctx.upstream_model, stream: true });
  const { res, guard } = await request(url, {
    method: 'POST',
    headers: headers(provider),
    body: JSON.stringify(payload),
    signal: ctx.signal,
    first_ms: ctx.timeouts.request_ms,
    idle_ms: ctx.timeouts.stream_idle_ms,
  });
  guard.idle();

  if (!res.ok) {
    const detail = await read_error_detail(res);
    guard.clear();
    throw error_from_response(res.status, detail, url);
  }
  if (!res.body) {
    guard.clear();
    throw new ProviderError(502, `upstream returned an empty body: ${url}`, { http_status: res.status });
  }

  const events = [];
  const parser = create_sse_parser((evt) => events.push(evt));
  const tool_buffer = new Map();
  let finished = false;
  let usage = null;

  const handle = (evt) => {
    const out = [];
    if (evt.data === '[DONE]') {
      finished = true;
      return out;
    }
    let obj;
    try {
      obj = JSON.parse(evt.data);
    } catch {
      return out;
    }
    if (obj && obj.error) {
      const message = typeof obj.error === 'string' ? obj.error : obj.error.message || 'upstream stream error';
      throw new ProviderError(502, `upstream stream error: ${message}`);
    }
    if (obj && obj.usage && typeof obj.usage === 'object') {
      usage = {
        prompt: Number(obj.usage.prompt_tokens) || 0,
        candidates: Number(obj.usage.completion_tokens) || 0,
        total: Number(obj.usage.total_tokens) || 0,
      };
    }
    const choice = Array.isArray(obj && obj.choices) ? obj.choices[0] : null;
    if (!choice) return out;
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
    const thought = reasoning_text(delta);
    if (thought) out.push({ kind: 'thought', text: thought });
    const text = delta_text(delta);
    if (text) out.push({ kind: 'text', text });
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      absorb_tool_delta(tool_buffer, delta.tool_calls);
    }
    if (choice.finish_reason) {
      out.push(...flush_tool_calls(tool_buffer));
      out.push({ kind: 'finish', reason: finish_reason_from_openai(choice.finish_reason) });
      finished = true;
    }
    return out;
  };

  try {
    for await (const chunk of res.body) {
      guard.idle();
      parser.push(chunk);
      while (events.length) {
        for (const delta of handle(events.shift())) yield delta;
      }
    }
    parser.end();
    while (events.length) {
      for (const delta of handle(events.shift())) yield delta;
    }
  } catch (err) {
    guard.clear();
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(502, `upstream stream failed: ${err && err.message ? err.message : err}`);
  } finally {
    guard.clear();
  }

  // Some relays never send finish_reason. Close the stream ourselves rather
  // than leaving the LS waiting on a candidate that never terminates.
  for (const delta of flush_tool_calls(tool_buffer)) yield delta;
  if (usage) yield { kind: 'usage', ...usage };
  if (!finished) yield { kind: 'finish', reason: 'STOP' };
}

export async function complete(provider, gen, ctx) {
  const url = endpoint(provider, 'chat/completions');
  const payload = to_openai_request(gen, { model: ctx.upstream_model, stream: false });
  const { res, guard } = await request(url, {
    method: 'POST',
    headers: headers(provider),
    body: JSON.stringify(payload),
    signal: ctx.signal,
    first_ms: ctx.timeouts.request_ms,
  });
  const obj = await read_json_response(res, guard, url);
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  if (!choice) {
    throw new ProviderError(502, `upstream response has no choices: ${JSON.stringify(obj).slice(0, 400)}`);
  }
  const parts = parts_from_openai_message(choice.message || {});
  const usage = obj.usage
    ? {
        prompt: Number(obj.usage.prompt_tokens) || 0,
        candidates: Number(obj.usage.completion_tokens) || 0,
        total: Number(obj.usage.total_tokens) || 0,
      }
    : null;
  return {
    parts,
    finish_reason: finish_reason_from_openai(choice.finish_reason),
    usage,
  };
}

export async function list_models(provider, timeouts) {
  const url = endpoint(provider, 'models');
  const guard = make_timeout_controller(undefined, timeouts.connect_ms, timeouts.connect_ms);
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', headers: headers(provider), signal: guard.signal });
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      const detail = await read_error_detail(res);
      return { ok: false, latency_ms, http_status: res.status, detail, models: [] };
    }
    const obj = await res.json();
    const rows = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.models) ? obj.models : [];
    const models = rows
      .map((row) => read_model_metadata(row, 'openai'))
      .filter((row) => row.id);
    return { ok: true, latency_ms, http_status: res.status, detail: `${models.length} models`, models };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - started,
      http_status: 0,
      detail: err && err.message ? err.message : String(err),
      models: [],
    };
  } finally {
    guard.clear();
  }
}

export async function probe(provider, timeouts) {
  const result = await list_models(provider, timeouts);
  return {
    ok: result.ok,
    latency_ms: result.latency_ms,
    http_status: result.http_status,
    detail: result.ok ? `reachable, ${result.detail}` : result.detail,
  };
}
