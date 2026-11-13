// language: JavaScript (ESM), file: providers/anthropic.js, target: Node 24, deps: node: builtins only
//
// Anthropic Messages adapter. Handles text_delta / thinking_delta /
// input_json_delta, and buffers tool_use blocks until content_block_stop
// because Gemini's functionCall is atomic.

import { create_sse_parser } from '../sse.js';
import { read_model_metadata } from '../model-capabilities.js';
import {
  finish_reason_from_anthropic,
  parts_from_anthropic_content,
  parse_json_loose,
  to_anthropic_request,
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

export const kind = 'anthropic';

function endpoint(provider, path) {
  const base = normalize_base('anthropic', provider.base_url);
  if (!base) throw new ProviderError(400, 'provider base_url is empty');
  return join_url(base, path);
}

function headers(provider) {
  return { ...auth_headers('anthropic', provider.api_key) };
}

export async function* stream(provider, gen, ctx) {
  const url = endpoint(provider, 'messages');
  const payload = to_anthropic_request(gen, { model: ctx.upstream_model, stream: true });
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
  const tool_blocks = new Map(); // index -> {id, name, json}
  let prompt_tokens = 0;
  let output_tokens = 0;
  let finished = false;
  let stop_reason = null;

  const flush_tool = (index) => {
    const block = tool_blocks.get(index);
    if (!block) return [];
    tool_blocks.delete(index);
    if (!block.name) return [];
    return [{ kind: 'tool_call', id: block.id, name: block.name, args: parse_json_loose(block.json) }];
  };

  const handle = (evt) => {
    const out = [];
    let obj;
    try {
      obj = JSON.parse(evt.data);
    } catch {
      return out;
    }
    const type = obj.type || evt.event;

    if (type === 'error') {
      const message = obj.error && obj.error.message ? obj.error.message : 'upstream stream error';
      throw new ProviderError(502, `upstream stream error: ${message}`);
    }
    if (type === 'message_start') {
      const usage = obj.message && obj.message.usage ? obj.message.usage : null;
      if (usage) {
        prompt_tokens = Number(usage.input_tokens) || 0;
        output_tokens = Number(usage.output_tokens) || 0;
      }
      return out;
    }
    if (type === 'content_block_start') {
      const block = obj.content_block || {};
      if (block.type === 'tool_use') {
        tool_blocks.set(Number(obj.index) || 0, {
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          json: '',
        });
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        out.push({ kind: 'text', text: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        out.push({ kind: 'thought', text: block.thinking });
      }
      return out;
    }
    if (type === 'content_block_delta') {
      const delta = obj.delta || {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        out.push({ kind: 'text', text: delta.text });
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        out.push({ kind: 'thought', text: delta.thinking });
      } else if (delta.type === 'input_json_delta') {
        const slot = tool_blocks.get(Number(obj.index) || 0);
        if (slot && typeof delta.partial_json === 'string') slot.json += delta.partial_json;
      }
      return out;
    }
    if (type === 'content_block_stop') {
      out.push(...flush_tool(Number(obj.index) || 0));
      return out;
    }
    if (type === 'message_delta') {
      if (obj.delta && obj.delta.stop_reason) stop_reason = obj.delta.stop_reason;
      if (obj.usage && Number.isFinite(Number(obj.usage.output_tokens))) {
        output_tokens = Number(obj.usage.output_tokens);
      }
      return out;
    }
    if (type === 'message_stop') {
      for (const index of [...tool_blocks.keys()]) out.push(...flush_tool(index));
      out.push({ kind: 'finish', reason: finish_reason_from_anthropic(stop_reason) });
      finished = true;
      return out;
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

  for (const index of [...tool_blocks.keys()]) {
    for (const delta of flush_tool(index)) yield delta;
  }
  if (prompt_tokens || output_tokens) {
    yield { kind: 'usage', prompt: prompt_tokens, candidates: output_tokens, total: prompt_tokens + output_tokens };
  }
  if (!finished) yield { kind: 'finish', reason: finish_reason_from_anthropic(stop_reason) || 'STOP' };
}

export async function complete(provider, gen, ctx) {
  const url = endpoint(provider, 'messages');
  const payload = to_anthropic_request(gen, { model: ctx.upstream_model, stream: false });
  const { res, guard } = await request(url, {
    method: 'POST',
    headers: headers(provider),
    body: JSON.stringify(payload),
    signal: ctx.signal,
    first_ms: ctx.timeouts.request_ms,
  });
  const obj = await read_json_response(res, guard, url);
  const parts = parts_from_anthropic_content(obj.content);
  const usage = obj.usage
    ? {
        prompt: Number(obj.usage.input_tokens) || 0,
        candidates: Number(obj.usage.output_tokens) || 0,
        total: (Number(obj.usage.input_tokens) || 0) + (Number(obj.usage.output_tokens) || 0),
      }
    : null;
  return {
    parts,
    finish_reason: finish_reason_from_anthropic(obj.stop_reason),
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
      .map((row) => read_model_metadata(row, 'anthropic'))
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
