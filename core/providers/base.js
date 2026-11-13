// language: JavaScript (ESM), file: providers/base.js, target: Node 24, deps: node: builtins only
//
// Shared provider plumbing: base-URL normalisation, timeouts, error shaping.

import { gemini_error, google_status_for } from '../translate.js';

export class ProviderError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = Number.isFinite(Number(code)) ? Number(code) : 500;
    this.status = extra.status || google_status_for(this.code);
    this.http_status = Number.isFinite(Number(extra.http_status)) ? Number(extra.http_status) : undefined;
    this.detail = extra.detail;
  }

  to_gemini() {
    return gemini_error(this.code, this.message, this.status);
  }
}

/**
 * Accept every shape a human types into a "base URL" box:
 *   https://x.com | https://x.com/ | https://x.com/v1 | https://x.com/v1/
 *   https://x.com/v1/chat/completions | https://x.com/v1/messages
 * Returns the prefix we then append our own path to.
 */
export function normalize_base(kind, base_url) {
  let u = String(base_url || '').trim();
  if (!u) return '';
  u = u.replace(/[?#].*$/, '');
  u = u.replace(/\/+$/, '');

  if (kind === 'openai') {
    u = u.replace(/\/chat\/completions$/i, '');
    u = u.replace(/\/completions$/i, '');
    u = u.replace(/\/+$/, '');
    if (!/\/v\d+[a-z0-9._-]*$/i.test(u)) u += '/v1';
    return u;
  }

  if (kind === 'anthropic') {
    u = u.replace(/\/messages$/i, '');
    u = u.replace(/\/+$/, '');
    if (!/\/v\d+[a-z0-9._-]*$/i.test(u)) u += '/v1';
    return u;
  }

  // gemini: keep any path prefix (relay stations often mount under /api/gemini)
  u = u.replace(/\/models$/i, '');
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/v1beta$/i, '');
  u = u.replace(/\/v1$/i, '');
  u = u.replace(/\/+$/, '');
  return u;
}

export function join_url(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  const s = String(suffix || '').replace(/^\/+/, '');
  return `${b}/${s}`;
}

export function auth_headers(kind, api_key) {
  const key = String(api_key || '');
  if (kind === 'anthropic') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  if (kind === 'gemini') {
    return { 'x-goog-api-key': key };
  }
  return { authorization: `Bearer ${key}` };
}

/**
 * Abort controller with a first-byte deadline that converts into an idle
 * deadline once the response starts flowing. A slow-but-alive stream is fine; a
 * dead socket is not.
 */
export function make_timeout_controller(signal, first_ms, idle_ms) {
  const controller = new AbortController();
  let timer = null;
  let done = false;

  const on_abort = () => {
    if (!done) controller.abort(signal.reason instanceof Error ? signal.reason : new Error('client aborted'));
  };
  if (signal) {
    if (signal.aborted) on_abort();
    else signal.addEventListener('abort', on_abort, { once: true });
  }

  const arm = (ms, why) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!done) controller.abort(new Error(why));
    }, ms);
    timer.unref?.();
  };
  arm(first_ms, 'upstream first-byte timeout');

  return {
    signal: controller.signal,
    idle() {
      if (done) return;
      arm(idle_ms, 'upstream stream idle timeout');
    },
    clear() {
      done = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (signal) signal.removeEventListener('abort', on_abort);
    },
  };
}

function describe_fetch_error(err, url) {
  if (!err) return 'unknown upstream failure';
  if (err.name === 'AbortError' || /aborted|timeout/i.test(String(err.message))) {
    return `upstream aborted or timed out (${err.message}): ${url}`;
  }
  const cause = err.cause && (err.cause.code || err.cause.message);
  const code = cause ? ` (${cause})` : '';
  return `upstream connection failed${code}: ${url}`;
}

/** POST/GET with a deadline; throws ProviderError with a Gemini-shaped payload. */
export async function request(url, { method = 'POST', headers = {}, body, signal, first_ms = 20000, idle_ms = first_ms } = {}) {
  const guard = make_timeout_controller(signal, first_ms, idle_ms);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: guard.signal,
      redirect: 'follow',
    });
    return { res, guard };
  } catch (err) {
    guard.clear();
    const code = guard.signal.aborted && !signal?.aborted ? 504 : 502;
    throw new ProviderError(code, describe_fetch_error(err, url), { http_status: undefined });
  }
}

/** Keep the deadline armed until the complete JSON body has been consumed. */
export async function read_json_response(res, guard, url) {
  try {
    if (!res.ok) throw error_from_response(res.status, await read_error_detail(res), url);
    try { return await res.json(); }
    catch (err) {
      if (guard.signal.aborted) throw new ProviderError(504, `upstream response timed out: ${url}`);
      throw new ProviderError(502, `upstream returned invalid JSON: ${err.message}`);
    }
  } finally { guard.clear(); }
}

/** Read a bounded slice of an error body and try to surface the useful sentence. */
export async function read_error_detail(res, limit = 1200) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return '';
  }
  if (!text) return '';
  const clipped = text.length > limit ? `${text.slice(0, limit)}…` : text;
  try {
    const parsed = JSON.parse(text);
    const msg =
      (parsed.error && (parsed.error.message || parsed.error.msg)) ||
      parsed.message ||
      (typeof parsed.error === 'string' ? parsed.error : '');
    if (typeof msg === 'string' && msg) return msg;
  } catch {
    // not JSON; fall through to the clipped raw body
  }
  return clipped;
}

export function error_from_response(status, detail, url) {
  // These are third-party credentials, never the user's Google session.
  // Forwarding 401/403 as Cloud Code auth errors makes the native application
  // render "session expired" and offer Google login for a provider failure.
  const provider_auth_error = status === 401 || status === 403;
  const code = provider_auth_error || status >= 500 ? 502 : status === 429 ? 429 : status;
  const label = provider_auth_error ? '第三方提供商认证或账户池不可用（不是 Google 登录失效）'
    : status >= 500 ? 'upstream error' : 'upstream rejected the request';
  const message = `${label} (HTTP ${status}) from ${url}${detail ? `: ${detail}` : ''}`;
  return new ProviderError(code, message, { http_status: status });
}

/** Pull the first `data:` payload out of an error body that turned out to be SSE. */
export function first_sse_error(text) {
  if (!text) return '';
  const match = text.match(/data:\s*(\{[\s\S]*\})/);
  if (!match) return '';
  try {
    const parsed = JSON.parse(match[1]);
    const err = parsed.error || parsed;
    if (typeof err.message === 'string') return err.message;
  } catch {
    return '';
  }
  return '';
}
