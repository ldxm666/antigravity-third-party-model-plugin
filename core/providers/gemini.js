// language: JavaScript (ESM), file: providers/gemini.js, target: Node 24, deps: node: builtins only
//
// Gemini v1beta adapter: the cheapest path, because the Cloud Code `request`
// object is already Gemini-shaped. We still re-frame every chunk through the
// canonical delta contract so the outer envelope is uniform across providers.

import { create_sse_parser } from '../sse.js';
import { read_model_metadata } from '../model-capabilities.js';
import { to_gemini_request } from '../translate.js';
import {
  ProviderError,
  auth_headers,
  error_from_response,
  make_timeout_controller,
  normalize_base,
  read_error_detail,
  request,
  read_json_response,
} from './base.js';

export const kind = 'gemini';

function model_path(model) {
  const raw = String(model || '').trim();
  return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
}

function endpoint(provider, model, method, stream) {
  const base = normalize_base('gemini', provider.base_url);
  if (!base) throw new ProviderError(400, 'provider base_url is empty');
  const path = `/v1beta/models/${encodeURIComponent(model_path(model))}:${method}`;
  return `${base}${path}${stream ? '?alt=sse' : ''}`;
}

function headers(provider) {
  return { ...auth_headers('gemini', provider.api_key) };
}

function deltas_from_gemini_chunk(chunk) {
  const out = [];
  if (!chunk || typeof chunk !== 'object') return out;
  if (chunk.error) {
    const message = typeof chunk.error === 'string' ? chunk.error : chunk.error.message || 'upstream error';
    throw new ProviderError(502, `upstream error: ${message}`);
  }
  const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      // Signatures belong to their original Part, including signature-only
      // chunks. Rebuilding text/functionCall objects loses tool-loop state.
      out.push({ kind: 'gemini_part', part });
    }
    if (candidate && candidate.finishReason) {
      out.push({ kind: 'finish', reason: candidate.finishReason });
    }
  }
  if (chunk.usageMetadata) {
    out.push({
      kind: 'usage',
      prompt: Number(chunk.usageMetadata.promptTokenCount) || 0,
      candidates: Number(chunk.usageMetadata.candidatesTokenCount) || 0,
      total: Number(chunk.usageMetadata.totalTokenCount) || 0,
    });
  }
  return out;
}

export async function* stream(provider, gen, ctx) {
  const url = endpoint(provider, ctx.upstream_model, 'streamGenerateContent', true);
  const payload = to_gemini_request(gen, { max_output_tokens: ctx.max_output });
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

  const content_type = String(res.headers.get('content-type') || '').toLowerCase();

  // Some relays ignore ?alt=sse and answer with a JSON array (the non-SSE
  // streaming form). Handle both instead of hanging on an empty parser.
  if (content_type.includes('application/json')) {
    const parsed = await read_json_response(res, guard, url);
    const chunks = Array.isArray(parsed) ? parsed : [parsed];
    for (const chunk of chunks) for (const delta of deltas_from_gemini_chunk(chunk)) yield delta;
    return;
  }

  const events = [];
  const parser = create_sse_parser((evt) => events.push(evt));
  let saw_finish = false;
  let usage = null;

  const handle = (evt) => {
    const out = [];
    if (evt.data === '[DONE]') {
      // Forward the terminator only because the upstream actually sent one.
      out.push({ kind: 'done' });
      return out;
    }
    if (!evt.data) return out;
    let obj;
    try {
      obj = JSON.parse(evt.data);
    } catch {
      return out;
    }
    for (const delta of deltas_from_gemini_chunk(obj)) {
      if (delta.kind === 'finish') saw_finish = true;
      if (delta.kind === 'usage') usage = delta;
      else out.push(delta);
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

  if (usage) yield usage;
  if (!saw_finish) yield { kind: 'finish', reason: 'STOP' };
}

export async function complete(provider, gen, ctx) {
  const url = endpoint(provider, ctx.upstream_model, 'generateContent', false);
  const payload = to_gemini_request(gen, { max_output_tokens: ctx.max_output });
  const { res, guard } = await request(url, {
    method: 'POST',
    headers: headers(provider),
    body: JSON.stringify(payload),
    signal: ctx.signal,
    first_ms: ctx.timeouts.request_ms,
  });
  const obj = await read_json_response(res, guard, url);
  const parts = [];
  let finish_reason;
  const candidate = Array.isArray(obj.candidates) ? obj.candidates[0] : null;
  if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
    for (const part of candidate.content.parts) {
      if (!part || typeof part !== 'object') continue;
      parts.push(part);
    }
    finish_reason = candidate.finishReason || 'STOP';
  }
  if (obj.promptFeedback && obj.promptFeedback.blockReason) {
    finish_reason = 'SAFETY';
  }
  const usage = obj.usageMetadata
    ? {
        prompt: Number(obj.usageMetadata.promptTokenCount) || 0,
        candidates: Number(obj.usageMetadata.candidatesTokenCount) || 0,
        total: Number(obj.usageMetadata.totalTokenCount) || 0,
      }
    : null;
  return { parts, finish_reason: finish_reason || 'STOP', usage };
}

export async function list_models(provider, timeouts) {
  const base = normalize_base('gemini', provider.base_url);
  if (!base) {
    return { ok: false, latency_ms: 0, http_status: 0, detail: 'provider base_url is empty', models: [] };
  }
  const url = `${base}/v1beta/models`;
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
    const rows = Array.isArray(obj.models) ? obj.models : [];
    const models = rows
      .map((row) => read_model_metadata(row, 'gemini'))
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
