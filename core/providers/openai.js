// language: JavaScript (ESM), file: providers/openai.js, target: Node 24, deps: node: builtins only
//
// OpenAI /chat/completions adapter. Covers every "OpenAI compatible" relay:
// content, reasoning_content, streaming tool_calls, and the trailing usage chunk.

import { create_sse_parser } from '../sse.js';
import { read_model_metadata } from '../model-capabilities.js';
import {
  finish_reason_from_openai,
  parts_from_openai_message,
  openai_reasoning_text,
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
  for (const [fallback_index, call] of calls.entries()) {
    if (!call || typeof call !== 'object') continue;
    const index = Number.isFinite(Number(call.index)) ? Number(call.index) : fallback_index;
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
    let args;
    try { args = JSON.parse(slot.args || '{}'); }
    catch { throw new ProviderError(422, `上游工具 ${slot.name} 的参数 JSON 未完整返回；已停止执行，避免用空参数继续调用工具。请检查输出预算或上游响应。`); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ProviderError(422, `上游工具 ${slot.name} 的参数必须是 JSON 对象。`);
    out.push({ kind: 'tool_call', id: slot.id, name: slot.name, args });
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

function request_options(provider, model, stream) {
  // Google's extension is specific to its own endpoint. A Gemini model name
  // on a generic relay is not evidence that it accepts Google's extra_body.
  const google_thinking = new URL(endpoint(provider, 'chat/completions')).hostname === 'generativelanguage.googleapis.com';
  return { model, stream, google_thinking };
}

export async function* stream(provider, gen, ctx) {
  const url = endpoint(provider, 'chat/completions');
  const payload = to_openai_request(gen, request_options(provider, ctx.upstream_model, true));
  const { res, guard } = await request(url, {
    method: 'POST',
    headers: { ...headers(provider), accept: 'text/event-stream', 'accept-encoding': 'identity' },
    body: JSON.stringify(payload),
    signal: ctx.signal,
    first_ms: ctx.timeouts.request_ms,
    idle_ms: ctx.timeouts.stream_idle_ms,
  });
  guard.idle();
  ctx.on_progress?.('upstream_headers', { status: res.status, content_type: res.headers.get('content-type'), content_encoding: res.headers.get('content-encoding') });

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
  let terminal = false;
  let has_answer = false;
  let has_payload = false;
  let usage = null;

  const handle = (evt) => {
    const out = [];
    if (evt.data === '[DONE]') {
      terminal = true;
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
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : choice.message && typeof choice.message === 'object' ? choice.message : {};
    const thought = openai_reasoning_text(delta);
    if (thought) { guard.idle(); has_payload = true; out.push({ kind: 'thought', text: thought }); }
    const text = delta_text(delta);
    if (text) { guard.idle(); has_answer = has_payload = true; out.push({ kind: 'text', text }); }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      guard.idle();
      ctx.on_progress?.('upstream_tool_fragment', { argument_chars: delta.tool_calls.reduce((n, t) => n + (t.function?.arguments?.length || 0), 0) });
      absorb_tool_delta(tool_buffer, delta.tool_calls);
    }
    if (delta.function_call) { guard.idle(); ctx.on_progress?.('upstream_tool_fragment', { argument_chars: delta.function_call.arguments?.length || 0 }); absorb_tool_delta(tool_buffer, [{ index: 0, function: delta.function_call }]); }
    if (choice.finish_reason) {
      const calls = flush_tool_calls(tool_buffer);
      if (calls.length) has_answer = has_payload = true;
      if (choice.finish_reason === 'length' && !has_answer) {
        throw new ProviderError(422, '上游耗尽输出预算（length/MAX_TOKENS），但没有返回正文或完整工具调用；预算可能被隐藏思考消耗。请核对模型的实际思考档位或增加最大输出，避免空回复自动续写。');
      }
      if (!has_answer && choice.finish_reason !== 'content_filter') {
        throw new ProviderError(422, '上游没有返回正文或完整工具调用（可能仅返回隐藏思考）；已停止，避免空回复反复续写。');
      }
      out.push(...calls);
      out.push({ kind: 'finish', reason: finish_reason_from_openai(choice.finish_reason) });
      finished = true;
    }
    return out;
  };

  if (String(res.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    const parsed = await read_json_response(res, guard, url);
    for (const obj of Array.isArray(parsed) ? parsed : [parsed]) {
      for (const delta of handle({ data: JSON.stringify(obj) })) yield delta;
    }
    for (const delta of flush_tool_calls(tool_buffer)) { has_answer = has_payload = true; yield delta; }
    if (!has_answer && has_payload) throw new ProviderError(422, '上游仅返回思考内容，没有正文或完整工具调用。');
    if (!has_payload && !finished) throw new ProviderError(502, '上游 JSON 未包含可用的聊天回复，请检查所选协议和端点。');
    if (usage) yield { kind: 'usage', ...usage };
    if (!finished) yield { kind: 'finish', reason: 'STOP' };
    return;
  }

  try {
    for await (const chunk of res.body) {
      ctx.on_progress?.('upstream_bytes', { bytes: chunk.length });
      parser.push(chunk);
      while (events.length) {
        ctx.on_progress?.('upstream_event');
        for (const delta of handle(events.shift())) yield delta;
        if (terminal) break;
      }
      // [DONE] terminates the protocol, even if a relay keeps the HTTP socket
      // alive. Exiting also cancels the remaining response body.
      if (terminal) break;
    }
    parser.end();
    while (events.length && !terminal) {
      for (const delta of handle(events.shift())) yield delta;
    }
  } catch (err) {
    guard.clear();
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(guard.signal.aborted && !ctx.signal?.aborted ? 504 : 502, `upstream stream failed: ${err && err.message ? err.message : err}`);
  } finally {
    guard.clear();
  }

  // EOF is not a protocol terminator. In particular, never execute an otherwise
  // valid tool JSON from a disconnected stream without finish_reason or DONE.
  if (!finished && !terminal) throw new ProviderError(502, '上游流提前断开，未收到 finish_reason 或 [DONE]；本次回复不完整，已停止。');
  for (const delta of flush_tool_calls(tool_buffer)) { has_answer = has_payload = true; yield delta; }
  if (!has_answer && has_payload) throw new ProviderError(422, '上游仅返回思考内容，没有正文或完整工具调用；已停止，避免空回复反复续写。');
  if (!has_payload && !finished) throw new ProviderError(502, '上游流未包含可用的聊天回复，请检查所选协议和端点。');
  if (usage) yield { kind: 'usage', ...usage };
  if (!finished) yield { kind: 'finish', reason: 'STOP' };
}

export async function complete(provider, gen, ctx) {
  const url = endpoint(provider, 'chat/completions');
  const payload = to_openai_request(gen, request_options(provider, ctx.upstream_model, false));
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
