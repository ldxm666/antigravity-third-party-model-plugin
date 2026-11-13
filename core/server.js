// language: JavaScript (ESM), file: server.js, target: Node 24, deps: node: builtins only
//
// HTTP surface:
//   /v1internal:*   Google control plane + third-party inference relay
//   /api/*          config UI contract
//   everything else static from build/ui/
//
// Loopback only. The Host/Origin allowlist exists to defeat DNS rebinding: a
// page on evil.com that resolves to 127.0.0.1 still sends Host: evil.com.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

import {
  APP_VERSION,
  config_path as default_config_path,
  drop_provider_model_map,
  first_model_of,
  is_masked,
  load_config,
  mask_provider,
  normalize_config,
  normalize_provider,
  provider_by_id,
  provider_declares,
  resolve_model,
  save_config,
  sync_model_map_from_provider,
  ui_root,
} from './config.js';
import * as logger from './log.js';
import { SseWriter, sse_frame, send_json } from './sse.js';
import {
  chunk_for_delta,
  count_request_tokens,
  gemini_error,
  gemini_response,
  normalize_request,
} from './translate.js';
import * as bootstrap from './bootstrap.js';
import { capture_request } from './capture.js';
import { adapter_for, list_provider_models, probe_provider } from './providers/index.js';
import { apply_model_settings } from './model-settings.js';
import { configure_models } from './model-capabilities.js';
import { model_capacity_error } from './model-schema.js';
import { create_request_progress } from './request-progress.js';

const BODY_LIMIT = 64 * 1024 * 1024;
const API_PREFIX = '/api/';
const INTERNAL_PREFIX = '/v1internal:';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

// ---------------------------------------------------------------------------
// Small HTTP utilities
// ---------------------------------------------------------------------------

function is_loopback(addr) {
  if (!addr) return false;
  const a = String(addr).replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1';
}

function read_body(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('request body too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function read_json(req) {
  const raw = await read_body(req);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const err = new Error('request body is not valid JSON');
    err.status = 400;
    throw err;
  }
}

function cors_headers(port) {
  return {
    'Access-Control-Allow-Origin': `http://127.0.0.1:${port}`,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function host_allowed(host_header, port) {
  const host = String(host_header || '').toLowerCase().trim();
  if (!host) return true; // HTTP/1.0 without Host
  const names = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (port === 80) names.push('127.0.0.1', 'localhost', '[::1]');
  return names.includes(host);
}

function origin_allowed(origin, port) {
  const value = String(origin || '').toLowerCase().trim();
  if (!value) return true; // same-origin fetch / curl send no Origin
  const names = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
  return names.includes(value);
}

function trace_id() {
  return crypto.randomBytes(8).toString('hex');
}

function status_of_error(err) {
  if (err && Number.isFinite(Number(err.status))) return Number(err.status);
  return 500;
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function placeholder_page() {
  const root = ui_root();
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>agy-bridge</title>
<style>
  html,body{margin:0;height:100%;background:#141517;color:#e6e6e6;
    font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif}
  .wrap{max-width:640px;margin:0 auto;padding:80px 24px}
  h1{font-size:18px;font-weight:600;margin:0 0 12px}
  code{background:#1e2024;border-radius:4px;padding:2px 6px;font-size:12px}
  p{color:#9aa0a6;margin:8px 0}
  a{color:#8ab4f8}
</style></head>
<body><div class="wrap">
<h1>agy-bridge core 已启动</h1>
<p>静态资源目录还不存在：<code>${root.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></p>
<p>把配置页放进这个目录后刷新即可；现在可以直接用 API 操作：</p>
<p><a href="/api/state">/api/state</a> · <a href="/api/health">/api/health</a> · <a href="/api/logs?limit=50">/api/logs</a></p>
</div></body></html>`;
}

function serve_static(req, res, url_path) {
  const root = ui_root();
  let rel;
  try {
    rel = decodeURIComponent(url_path);
  } catch {
    rel = url_path;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(root, `.${rel.startsWith('/') ? rel : `/${rel}`}`);

  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      if (rel === '/index.html') {
        const body = placeholder_page();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(body);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(target);
    stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// /v1internal:* — Cloud Code Assist
// ---------------------------------------------------------------------------

function pick_max_output(config, resolved) {
  const provider = resolved.provider;
  const entry = provider.models.find((m) => m.id === resolved.agy_model || m.upstream === resolved.upstream);
  return entry ? entry.max_out : 8192;
}

function envelope(response) {
  // Real capture: exactly one wrapper key. Anything extra is a chance for a
  // strict protojson decoder on the other side to reject the frame.
  return { response };
}

function trace_header(trace) {
  return { 'X-Agy-Trace-Id': trace };
}

function error_payload(err) {
  if (err && typeof err.to_gemini === 'function') return err.to_gemini();
  const code = Number(err && err.status) || 500;
  return gemini_error(code, err && err.message ? err.message : 'bridge error');
}

async function handle_generate(req, res, state, method) {
  const stream = method === 'streamGenerateContent';
  const trace = trace_id();

  let raw;
  try {
    raw = await read_body(req);
  } catch (err) {
    send_json(res, status_of_error(err), gemini_error(413, err && err.message ? err.message : 'body too large'));
    return;
  }
  const raw_text = raw.toString('utf8');
  if (state.config.capture_requests === true && raw_text.trim()) {
    const file = capture_request(method, raw_text);
    if (file) logger.debug('capture_written', { file });
  }

  let body = {};
  if (raw_text.trim()) {
    try {
      body = JSON.parse(raw_text);
    } catch {
      logger.warn('bad_request_json', { method, bytes: raw.length });
      send_json(res, 400, gemini_error(400, 'request body is not valid JSON'));
      return;
    }
  }

  let gen = normalize_request(body);
  const config = state.config;

  // The LS announces model switches through setUserSettings, and it sometimes
  // echoes back the synthetic MODEL_PLACEHOLDER_* enum instead of a real id.
  let requested = gen.model || state.last_settings_model || '';
  const from_placeholder = bootstrap.model_from_placeholder(requested, state.model_aliases);
  if (from_placeholder) requested = from_placeholder;

  const official = state.official_models.get(requested);
  if (official && !Object.hasOwn(config.model_map, official)) {
    try {
      const status = await state.control_plane.relay(req, res, raw, {
        trace, first_ms: config.timeouts.connect_ms, idle_ms: config.timeouts.stream_idle_ms,
      });
      logger.info('google_inference', { trace, method, model: official, status });
    } catch (err) {
      logger.warn('google_inference_failed', { trace, method, error: err.message });
      if (!res.headersSent) send_json(res, 502, gemini_error(502, 'Google inference connection failed'), trace_header(trace));
      else res.destroy();
    }
    return;
  }

  const picker = bootstrap.resolve_picker_model(requested, config);
  if (typeof requested === 'string' && requested.startsWith('agy-bridge:') && !picker) {
    send_json(res, 400, gemini_error(400, '此第三方模型或思考档位已移除，请在模型菜单重新选择。'), trace_header(trace));
    return;
  }
  const resolved = picker ? { provider: picker.provider, agy_model: picker.model_id,
    upstream: picker.upstream, display_name: picker.display_name, mapped: true, reason: 'native-picker' }
    : resolve_model(config, requested);
  if (!resolved) {
    logger.error('no_provider_configured', { requested });
    send_json(res, 503, gemini_error(503, 'agy-bridge 尚未配置任何 provider，请先在配置页添加并选择默认模型'));
    return;
  }
  if (!resolved.mapped) {
    logger.warn('unmapped_model', {
      requested: requested || '(none)',
      fell_back_to: resolved.agy_model,
      probes: gen.model_probes,
    });
  }

  const adapter = adapter_for(resolved.provider.kind);
  let model_meta = resolved.provider.models.find(m => m.id === resolved.agy_model || m.upstream === resolved.upstream);
  if (picker && model_meta) model_meta = { ...model_meta, reasoning_effort: picker.effort };
  try { gen = apply_model_settings(gen, model_meta, resolved.provider.kind, { use_saved_output: !!picker && gen.envelope && gen.request_id.startsWith('agent/') }); }
  catch (err) { send_json(res, err.status || 400, gemini_error(err.status || 400, err.message), trace_header(trace)); return; }
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort(new Error('client disconnected'));
  });

  const ctx = {
    upstream_model: resolved.upstream,
    max_output: pick_max_output(config, resolved),
    timeouts: config.timeouts,
    signal: abort.signal,
  };

  const base_meta = {
    trace,
    agy_model: resolved.agy_model,
    upstream_model: resolved.upstream,
    provider: resolved.provider.id,
    kind: resolved.provider.kind,
    stream,
    mapped: resolved.mapped,
    envelope: gen.envelope,
    body_keys: gen.body_keys,
    probes: gen.model_probes,
    contents: gen.contents.length,
    tools: gen.tools.length,
    reasoning_effort: picker?.effort || model_meta?.reasoning_effort || 'inherit',
    max_output: gen.generation_config.maxOutputTokens,
  };
  logger.info(stream ? 'relay_stream' : 'relay_generate', base_meta);

  const started = Date.now();
  const timings = {};
  const progress = state.progress.start({ trace, request_id: gen.request_id,
    provider_name: resolved.provider.name, model: resolved.upstream, effort: base_meta.reasoning_effort });
  res.on('close', () => { if (!res.writableEnded) progress.finish('cancelled'); });
  const mark = (phase, extra = {}) => {
    progress.note(phase, extra);
    if (timings[phase] !== undefined) return;
    timings[phase] = Date.now() - started;
    logger.info('relay_progress', { trace, provider: resolved.provider.id, upstream_model: resolved.upstream, phase, ms: timings[phase], ...extra });
  };
  ctx.on_progress = (phase, extra = {}) => mark(phase, extra);
  try {
    if (!stream) {
      const result = await adapter.complete(resolved.provider, gen, ctx);
      const response = gemini_response({
        parts: result.parts,
        finish_reason: result.finish_reason,
        usage: result.usage,
        model_version: resolved.upstream,
      });
      logger.info('relay_done', { ...base_meta, ms: Date.now() - started, parts: result.parts.length, timings });
      progress.finish('complete');
      send_json(res, 200, envelope(response), trace_header(trace));
      return;
    }

    res.setHeader('X-Agy-Trace-Id', trace);
    const writer = new SseWriter(res, { detect_truncation: true });
    let wrote = false;
    try {
      for await (const delta of adapter.stream(resolved.provider, gen, ctx)) {
        if (res.destroyed) break;
        if (delta?.kind === 'text' || delta?.kind === 'thought' || delta?.kind === 'tool_call') mark('forward_' + delta.kind);
        if (delta?.kind === 'gemini_part') {
          if (delta.part?.text) mark(delta.part.thought ? 'forward_thought' : 'forward_text');
          if (delta.part?.functionCall) mark('forward_tool_call');
        }
        if (delta && delta.kind === 'done') {
          // Only ever forwarded when the upstream itself sent it.
          writer.write('data: [DONE]\n\n');
          wrote = true;
          continue;
        }
        const chunk = chunk_for_delta(delta, resolved.upstream);
        if (!chunk) continue;
        writer.send(envelope(chunk));
        wrote = true;
      }
      logger.info('relay_done', { ...base_meta, ms: Date.now() - started, frames: writer.frames, timings });
      progress.finish(res.destroyed ? 'cancelled' : 'complete');
      writer.end();
    } catch (err) {
      const payload = error_payload(err);
      progress.finish(abort.signal.aborted ? 'cancelled' : 'failed', payload.error.code || 502);
      logger.error('relay_stream_failed', {
        ...base_meta,
        ms: Date.now() - started,
        timings,
        error: err && err.message ? err.message : String(err),
      });
      if (!wrote && !writer.opened) {
        send_json(res, payload.error.code || 502, payload, trace_header(trace));
      } else {
        writer.write(sse_frame(payload));
        // Native LS ignores in-band SSE errors on an otherwise clean EOF.
        // Flush the diagnostic frame then abort the chunked body, so its API
        // retry policy sees the failure instead of starting output recovery.
        res.write('', () => res.destroy());
      }
    }
    return;
  } catch (err) {
    const payload = error_payload(err);
    progress.finish(abort.signal.aborted ? 'cancelled' : 'failed', payload.error.code || 502);
    logger.error(stream ? 'relay_stream_failed' : 'relay_generate_failed', {
      ...base_meta,
      ms: Date.now() - started,
      timings,
      error: err && err.message ? err.message : String(err),
    });
    if (!res.headersSent) send_json(res, payload.error.code || 502, payload, trace_header(trace));
    else if (!res.writableEnded) res.end();
  }
}

/** Local inference replies use the Cloud Code response envelope. */
function send_enveloped(res, payload) {
  send_json(res, 200, { response: payload });
}

async function handle_internal(req, res, state, url) {
  state.request_count += 1;
  // The LS uses two spellings: RPCs are /v1internal:<method>, while a few
  // REST-ish calls are /v1internal/<path> (and it polls bare /v1internal/).
  const method = url.pathname.startsWith(INTERNAL_PREFIX)
    ? url.pathname.slice(INTERNAL_PREFIX.length)
    : url.pathname.replace(/^\/v1internal\/?/, '').replace(/\/+$/, '');
  const trace = trace_id();

  if (method === 'generateContent' || method === 'streamGenerateContent') {
    await handle_generate(req, res, state, method);
    return;
  }

  if (method === '') {
    // 1 Hz readiness poll; answering it must stay silent in the log.
    send_json(res, 200, {});
    return;
  }

  // Keep the original bytes (including unknown fields) for Google's decoder.
  const raw = await read_body(req);
  let body = {};
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* Google handles malformed control requests. */ }

  if (method === 'countTokens') {
    const gen = normalize_request(body);
    const total = count_request_tokens(gen);
    logger.debug('count_tokens', { total, contents: gen.contents.length });
    send_enveloped(res, { totalTokens: total });
    return;
  }

  if (method === 'setUserSettings' || method === 'setCodeAssistGlobalUserSetting') {
    const model = bootstrap.model_from_user_settings(body);
    if (model) {
      state.last_settings_model = model;
      logger.info('model_from_settings', { model });
    }
  }

  const abort = new AbortController();
  const on_close = () => { if (!res.writableEnded) abort.abort(); };
  res.on('close', on_close);
  const started = Date.now();
  try {
    const upstream = await state.control_plane.exchange(req.url, {
      method: req.method, headers: req.headers, body: raw, signal: abort.signal,
    });
    let response_body = upstream.body;
    const response_headers = { ...upstream.headers, ...trace_header(trace), 'X-Agy-Control-Plane': upstream.source };
    if (method === 'fetchAvailableModels' && upstream.status === 200) {
      try {
        const decompress = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[upstream.headers['content-encoding']];
        const decoded = decompress ? decompress(response_body, { maxOutputLength: 16 * 1024 * 1024 }) : response_body;
        const merged = bootstrap.merge_available_models(JSON.parse(decoded.toString('utf8')), state.config,
          state.model_aliases, state.official_models);
        response_body = Buffer.from(JSON.stringify(merged));
        delete response_headers['content-encoding'];
        delete response_headers.etag;
        delete response_headers['content-md5'];
      } catch (err) {
        logger.warn('model_catalogue_merge_failed', { trace, error: err.message });
      }
    }
    response_headers['content-length'] = response_body.length;
    const log = ['loadCodeAssist', 'fetchAvailableModels', 'fetchUserInfo', 'retrieveUserQuota', 'onboardUser'].includes(method)
      ? logger.info : logger.debug;
    log('control_plane', { trace, method, status: upstream.status,
      source: upstream.source, ms: Date.now() - started, bytes: response_body.length });
    if (upstream.source === 'cache') logger.warn('control_plane_cache_fallback', { trace, method });
    if (!res.destroyed) { res.writeHead(upstream.status, response_headers); res.end(response_body); }
  } catch (err) {
    logger.warn('control_plane_failed', { trace, method, ms: Date.now() - started, error: err.message });
    if (!res.destroyed) send_json(res, err.name === 'AbortError' ? 504 : 502,
      gemini_error(err.name === 'AbortError' ? 504 : 502, 'Google control-plane connection failed; check your proxy and Google sign-in'), trace_header(trace));
  } finally { res.removeListener('close', on_close); }
}

// ---------------------------------------------------------------------------
// /api/* — configuration surface
// ---------------------------------------------------------------------------

function persist(state) {
  const saved = save_config(state.config, state.config_path);
  state.config = saved;
  logger.set_log_level(saved.log_level);
  return saved;
}

function find_provider(state, id) {
  return provider_by_id(state.config, id);
}

async function handle_api(req, res, state, url) {
  const port = state.port;
  const cors = cors_headers(port);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (!host_allowed(req.headers.host, port)) {
    send_json(res, 403, { ok: false, error: 'host_not_allowed', detail: `Host header must be 127.0.0.1:${port} or localhost:${port}` });
    return;
  }
  if (!origin_allowed(req.headers.origin, port)) {
    send_json(res, 403, { ok: false, error: 'origin_not_allowed', detail: `Origin must be http://127.0.0.1:${port}` });
    return;
  }

  const send = (status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...cors,
    });
    res.end(body);
  };

  const route = url.pathname.slice(API_PREFIX.length);
  const parts = route.split('/').filter(Boolean);

  try {
    if (route === 'health' && req.method === 'GET') {
      send(200, { ok: true, version: APP_VERSION });
      return;
    }

    if (route === 'state' && req.method === 'GET') {
      const cfg = state.config;
      send(200, {
        version: APP_VERSION,
        port: state.port,
        active_provider_id: cfg.active_provider_id,
        default_model: cfg.default_model,
        providers: cfg.providers.map(mask_provider),
        model_map: cfg.model_map,
        uptime_s: Math.floor((Date.now() - state.started_at) / 1000),
        request_count: state.request_count,
        control_plane: { mode: 'google-passthrough', uses_proxy: state.control_plane.uses_proxy,
          official_models: new Set(state.official_models.values()).size,
          custom_models: state.model_aliases.size },
      });
      return;
    }

    // This fixed route is already allowed by the Hub IPC proxy. It exposes
    // transport counts only, scoped by cascade ID in the native UI.
    if (route === 'providers/progress' && req.method === 'GET') {
      send(200, { requests: state.progress.snapshot() });
      return;
    }

    if (route === 'providers') {
      if (req.method === 'GET') {
        send(200, { providers: state.config.providers.map(mask_provider) });
        return;
      }
      if (req.method === 'POST') {
        const body = await read_json(req);
        const seen = new Set(state.config.providers.map((p) => p.id));
        const provider = normalize_provider({ ...body, id: '' }, seen);
        if (!provider.base_url) {
          send(400, { ok: false, error: 'base_url_required' });
          return;
        }
        const capacity_error = model_capacity_error(provider.models);
        if (capacity_error) {
          send(400, { ok: false, error: 'invalid_model_capacity', detail: capacity_error });
          return;
        }
        state.config.providers.push(provider);
        // The model picker is driven by model_map, so a provider's own models
        // must land there immediately or the LS never offers them.
        const mapped = sync_model_map_from_provider(state.config, provider);
        if (!state.config.active_provider_id) state.config.active_provider_id = provider.id;
        if (!state.config.default_model) state.config.default_model = first_model_of(provider);
        const normalized = normalize_config(state.config);
        state.config = normalized;
        persist(state);
        logger.info('provider_created', { id: provider.id, kind: provider.kind, mapped_models: mapped.length });
        send(200, {
          ok: true,
          provider: mask_provider(find_provider(state, provider.id)),
          mapped_models: mapped,
        });
        return;
      }
      send(405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    if (route === 'providers/preview' && req.method === 'POST') {
      const body = await read_json(req);
      const existing = typeof body.id === 'string' ? find_provider(state, body.id) : null;
      const key = typeof body.api_key === 'string' && body.api_key.trim() && !is_masked(body.api_key)
        ? body.api_key.trim() : existing?.api_key || '';
      const provider = normalize_provider({ ...existing, ...body, api_key: key }, null);
      if (!/^https?:\/\//i.test(provider.base_url)) { send(400, { error: '请填写有效的 API 地址' }); return; }
      if (body.operation === 'configure-models' && !provider.models.length) { send(400, { error: '请先选择或添加模型，再自动配置。' }); return; }
      let result = body.operation === 'test' ? await probe_provider(provider, state.config.timeouts)
        : await list_provider_models(provider, state.config.timeouts);
      if (body.operation === 'configure-models') result = await configure_models(provider, state.config.timeouts, result);
      logger.info('provider_preview', { id: existing?.id || '(unsaved)', operation: body.operation, ok: result.ok });
      send(200, result);
      return;
    }

    if (parts[0] === 'providers' && parts.length >= 2) {
      const id = decodeURIComponent(parts[1]);
      const provider = find_provider(state, id);
      if (!provider) {
        send(404, { ok: false, error: 'provider_not_found', id });
        return;
      }

      if (parts.length === 2 && req.method === 'PATCH') {
        const body = await read_json(req);
        // Validate a detached candidate before touching live settings or secrets.
        const candidate = normalize_provider({ ...provider, models: Array.isArray(body.models) ? body.models : provider.models }, null);
        const capacity_error = model_capacity_error(candidate.models);
        if (capacity_error) {
          send(400, { ok: false, error: 'invalid_model_capacity', detail: capacity_error });
          return;
        }
        if (typeof body.name === 'string') provider.name = body.name.trim() || provider.name;
        if (typeof body.kind === 'string' && ['openai', 'anthropic', 'gemini'].includes(body.kind)) provider.kind = body.kind;
        if (typeof body.base_url === 'string') provider.base_url = body.base_url.trim();
        // Blank password inputs mean "keep the stored secret" on an edit.
        if (typeof body.api_key === 'string' && body.api_key.trim() && !is_masked(body.api_key)) provider.api_key = body.api_key.trim();
        if (Array.isArray(body.models)) {
          const seen = new Set();
          provider.models = body.models
            .map((m) => normalize_provider({ models: [m] }, null).models[0])
            .filter((m) => {
              if (!m || seen.has(m.id)) return false;
              seen.add(m.id);
              return true;
            });
        }
        const mapped = sync_model_map_from_provider(state.config, provider);
        // Repair the default only when it was actually owned by this provider
        // (or by the active provider). Editing provider B must never silently
        // repoint a default model that lives on provider A.
        const owns_default = (state.config.model_map[state.config.default_model] || {}).provider_id === provider.id;
        if (
          (owns_default || state.config.active_provider_id === provider.id) &&
          !provider_declares(provider, state.config.default_model)
        ) {
          state.config.default_model = first_model_of(provider) || state.config.default_model;
        }
        const normalized = normalize_config(state.config);
        state.config = normalized;
        persist(state);
        const updated = find_provider(state, id);
        logger.info('provider_updated', { id, keys: Object.keys(body), mapped_models: mapped.length });
        send(200, { ok: true, provider: mask_provider(updated), mapped_models: mapped });
        return;
      }

      if (parts.length === 2 && req.method === 'DELETE') {
        const { removed, kept } = drop_provider_model_map(state.config, id);
        state.config.providers = state.config.providers.filter((p) => p.id !== id);
        if (state.config.active_provider_id === id) {
          state.config.active_provider_id = state.config.providers[0] ? state.config.providers[0].id : '';
        }
        const normalized = normalize_config(state.config);
        state.config = normalized;
        persist(state);
        logger.info('provider_deleted', { id, removed_models: removed, kept_user_mappings: kept });
        send(200, {
          ok: true,
          deleted: id,
          removed_models: removed,
          kept_user_mappings: kept,
        });
        return;
      }

      if (parts.length === 3 && parts[2] === 'test' && req.method === 'POST') {
        const result = await probe_provider(provider, state.config.timeouts);
        logger.info('provider_test', { id, ok: result.ok, http_status: result.http_status, ms: result.latency_ms });
        send(200, {
          ok: result.ok,
          latency_ms: result.latency_ms,
          detail: result.detail,
          http_status: result.http_status,
        });
        return;
      }

      if (parts.length === 3 && parts[2] === 'fetch-models' && req.method === 'POST') {
        const result = await list_provider_models(provider, state.config.timeouts);
        logger.info('provider_fetch_models', { id, ok: result.ok, count: result.models.length });
        send(200, { ok: result.ok, models: result.models, detail: result.detail });
        return;
      }

      send(405, { ok: false, error: 'method_not_allowed' });
      return;
    }

    if (route === 'model-map' && req.method === 'POST') {
      const body = await read_json(req);
      const map = body.map && typeof body.map === 'object' ? body.map : null;
      if (!map) {
        send(400, { ok: false, error: 'map_required' });
        return;
      }
      // Anything the user writes here is authoritative: _auto=false keeps the
      // provider sync from overwriting it later.
      const claimed = {};
      for (const [key, value] of Object.entries(map)) {
        claimed[key] = { ...(value && typeof value === 'object' ? value : {}), _auto: false };
      }
      state.config.model_map = claimed;
      const normalized = normalize_config(state.config);
      state.config = normalized;
      persist(state);
      logger.info('model_map_updated', { entries: Object.keys(normalized.model_map).length });
      send(200, { ok: true, model_map: normalized.model_map });
      return;
    }

    if (route === 'active' && req.method === 'POST') {
      const body = await read_json(req);
      if (typeof body.active_provider_id === 'string' && body.active_provider_id) {
        if (!find_provider(state, body.active_provider_id)) {
          send(400, { ok: false, error: 'provider_not_found', id: body.active_provider_id });
          return;
        }
        state.config.active_provider_id = body.active_provider_id;
      }

      // default_model must live under the active provider, otherwise the next
      // request silently routes at a provider the user did not choose.
      const active = find_provider(state, state.config.active_provider_id);
      const wanted = typeof body.default_model === 'string' ? body.default_model.trim() : '';
      let corrected = false;
      if (wanted) {
        const declared = provider_declares(active, wanted);
        if (declared) {
          state.config.default_model = declared.id;
        } else if (first_model_of(active)) {
          state.config.default_model = first_model_of(active);
          corrected = true;
        } else {
          state.config.default_model = wanted;
        }
      } else if (active && active.models.length && !provider_declares(active, state.config.default_model)) {
        state.config.default_model = first_model_of(active);
        corrected = true;
      }

      const normalized = normalize_config(state.config);
      state.config = normalized;
      persist(state);
      logger.info('active_updated', {
        active_provider_id: normalized.active_provider_id,
        default_model: normalized.default_model,
        corrected,
      });
      send(200, {
        ok: true,
        active_provider_id: normalized.active_provider_id,
        default_model: normalized.default_model,
        corrected,
      });
      return;
    }

    if (route === 'logs' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 200;
      send(200, logger.recent_logs(limit));
      return;
    }

    if (route === 'reload' && req.method === 'POST') {
      const result = load_config(state.config_path);
      state.config = result.config;
      logger.set_log_level(result.config.log_level);
      logger.info('config_reloaded', {
        providers: result.config.providers.length,
        models: Object.keys(result.config.model_map).length,
        recovered: result.recovered,
      });
      send(200, {
        ok: true,
        reloaded: true,
        providers: result.config.providers.length,
        model_map: Object.keys(result.config.model_map).length,
      });
      return;
    }

    send(404, { ok: false, error: 'not_found', path: url.pathname });
  } catch (err) {
    const status = status_of_error(err);
    logger.error('api_error', { path: url.pathname, error: err && err.message ? err.message : String(err) });
    if (!res.headersSent) send(status >= 400 && status < 600 ? status : 500, { ok: false, error: err.message || 'internal_error' });
    else if (!res.writableEnded) res.end();
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function handle(req, res, state) {
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${state.port}`);
  } catch {
    send_json(res, 400, { error: 'bad_request' });
    return;
  }

  if (!is_loopback(req.socket.remoteAddress)) {
    send_json(res, 403, { error: 'loopback_only' });
    return;
  }

  if (url.pathname === '/api' || url.pathname.startsWith(API_PREFIX)) {
    handle_api(req, res, state, url).catch((err) => {
      logger.error('api_unhandled', { error: err && err.message ? err.message : String(err) });
      if (!res.headersSent) send_json(res, 500, { ok: false, error: 'internal_error' });
      else if (!res.writableEnded) res.end();
    });
    return;
  }

  if (
    url.pathname === '/v1internal' ||
    url.pathname.startsWith('/v1internal/') ||
    url.pathname.startsWith(INTERNAL_PREFIX)
  ) {
    handle_internal(req, res, state, url).catch((err) => {
      logger.error('internal_unhandled', { error: err && err.message ? err.message : String(err) });
      if (!res.headersSent) send_json(res, 500, gemini_error(500, err.message || 'internal error'));
      else if (!res.writableEnded) res.end();
    });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serve_static(req, res, url.pathname);
    return;
  }

  send_json(res, 404, { error: 'not_found' });
}

/**
 * Start the bridge. `config` may be injected (selftest) or loaded from disk.
 * Returns the live handle so callers can read the bound port and shut down.
 */
export async function start_server(options = {}) {
  const cfg_path = options.config_path || default_config_path();
  let config = options.config;
  let created = false;
  let recovered = false;

  if (!config) {
    const loaded = load_config(cfg_path);
    config = loaded.config;
    created = loaded.created;
    recovered = loaded.recovered;
  }
  config = normalize_config(config);

  // port 0 is a legitimate value (ephemeral bind, used by the selftest), so it
  // must not be swallowed by a falsy check.
  const requested_port = options.port !== undefined ? Number(options.port) : Number(config.port);
  const listen_port = Number.isFinite(requested_port) ? requested_port : 18925;

  const state = {
    config,
    config_path: cfg_path,
    started_at: Date.now(),
    request_count: 0,
    progress: create_request_progress(),
    last_settings_model: '',
    model_aliases: new Map(),
    official_models: new Map(),
    control_plane: new bootstrap.ControlPlane({ origin: options.control_plane_url,
      proxy_url: options.google_proxy_url, timeout_ms: options.control_plane_timeout_ms,
      cache_ms: options.control_plane_cache_ms }),
    port: listen_port,
    created,
    recovered,
  };

  logger.set_log_level(config.log_level);

  const server = http.createServer((req, res) => handle(req, res, state));
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  await new Promise((resolve, reject) => {
    const on_error = (err) => {
      server.removeListener('listening', on_listening);
      reject(err);
    };
    const on_listening = () => {
      server.removeListener('error', on_error);
      resolve();
    };
    server.once('error', on_error);
    server.once('listening', on_listening);
    server.listen(state.port, options.host || '127.0.0.1');
  });

  const address = server.address();
  state.port = typeof address === 'object' && address ? address.port : state.port;

  return {
    server,
    state,
    port: state.port,
    config: state.config,
    created,
    recovered,
    reload() {
      const result = load_config(cfg_path);
      state.config = result.config;
      logger.set_log_level(result.config.log_level);
      return result;
    },
    close() {
      state.control_plane.close();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
