// Google owns authentication, provisioning and quota. Only the model catalogue
// is extended locally. OAuth headers never enter a third-party provider adapter.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { model_efforts, default_effort } from './model-schema.js';
import { execFileSync } from 'node:child_process';

export const GOOGLE_ORIGIN = 'https://daily-cloudcode-pa.googleapis.com';
const READ_METHODS = new Set([
  'loadCodeAssist', 'fetchAvailableModels', 'fetchUserInfo', 'retrieveUserQuota',
  'retrieveUserQuotaSummary', 'listExperiments', 'fetchAdminControls',
  'listModelConfigs', 'getCodeAssistGlobalUserSetting',
]);
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export function forward_headers(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const key of String(headers.connection || '').split(',')) blocked.add(key.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key, value]) =>
    value !== undefined && !blocked.has(key.toLowerCase())));
}

/** Node 24's native proxy support; GUI startup often has no proxy env vars. */
export function google_proxy_url(env = process.env) {
  const explicit = env.AGY_BRIDGE_GOOGLE_PROXY;
  if (explicit) return explicit === 'direct' ? '' : explicit;
  const from_env = env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY || env.http_proxy || env.HTTP_PROXY;
  if (from_env) return from_env;
  if (process.platform !== 'win32') return '';
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const query = name => execFileSync('reg.exe', ['query', key, '/v', name], {
      encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(query('ProxyEnable'))) return '';
    const server = query('ProxyServer').match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
    if (!server) return '';
    const parts = server.split(';');
    const selected = parts.find(p => p.startsWith('https='))?.slice(6)
      || parts.find(p => p.startsWith('http='))?.slice(5)
      || (!server.includes('=') ? server : '');
    return selected ? (/^https?:\/\//i.test(selected) ? selected : `http://${selected}`) : '';
  } catch { return ''; }
}

/** Raw, bounded control-plane forwarding with an account-scoped memory cache. */
export class ControlPlane {
  constructor({ origin = GOOGLE_ORIGIN, proxy_url, cache_ms = 60000, timeout_ms = 20000 } = {}) {
    this.origin = new URL(origin);
    // HTTP origins are used by the isolated test harness, never by config.json.
    const proxy = proxy_url ?? (this.origin.protocol === 'https:' ? google_proxy_url() : '');
    const proxyEnv = proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy,
      NO_PROXY: process.env.no_proxy || process.env.NO_PROXY || 'localhost,127.0.0.1,::1' } : {};
    this.agent = this.origin.protocol === 'https:'
      ? new https.Agent({ keepAlive: true, proxyEnv }) : new http.Agent({ keepAlive: true });
    this.cache = new Map();
    this.cache_ms = cache_ms;
    this.timeout_ms = timeout_ms;
    this.uses_proxy = Boolean(proxy);
  }

  open(url_path, { method, headers, body, signal }) {
    // Concatenation keeps even //host paths on the fixed upstream origin and
    // preserves the query string verbatim.
    if (!url_path.startsWith('/v1internal')) throw new Error('invalid control-plane path');
    const client = this.origin.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = client.request(this.origin.origin + url_path, {
        method, headers: forward_headers(headers), agent: this.agent, signal,
      }, response => resolve(response));
      request.on('error', reject);
      request.end(body);
    });
  }

  async exchange(url_path, { method = 'POST', headers = {}, body = Buffer.alloc(0), signal } = {}) {
    const name = url_path.split('?')[0].replace(/^\/v1internal[:/]?/, '');
    const can_cache = READ_METHODS.has(name);
    // Hash credentials into the key; keep no raw credentials in cache keys,
    // logs or files. Cache entries are scoped to the entire original request.
    const key = crypto.createHash('sha256').update(JSON.stringify([method, url_path, headers])).update(body).digest('hex');
    const prior = this.cache.get(key);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Google control-plane timeout')), this.timeout_ms);
    timeout.unref?.();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let result;
    try {
      const response = await this.open(url_path, { method, headers, body, signal: combined });
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { response.destroy(); throw new Error('Google response exceeds 16 MiB'); }
        chunks.push(chunk);
      }
      result = { status: response.statusCode, headers: forward_headers(response.headers), body: Buffer.concat(chunks), source: 'google' };
      if (can_cache && result.status >= 200 && result.status < 300 && size <= 1024 * 1024) {
        this.cache.delete(key);
        this.cache.set(key, { result, at: Date.now() });
        if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
      } else if (result.status < 500) {
        // Never mask authentication or quota rejections with an older success.
        this.cache.delete(key);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!can_cache || !prior || Date.now() - prior.at > this.cache_ms) throw error;
    } finally { clearTimeout(timeout); }
    if ((!result || result.status >= 500) && can_cache && prior && Date.now() - prior.at <= this.cache_ms) {
      return { ...prior.result, headers: { ...prior.result.headers }, source: 'cache' };
    }
    return result;
  }

  /** Stream native Google inference without buffering or changing SSE frames. */
  async relay(req, res, body, { trace, first_ms = 20000, idle_ms = 120000 } = {}) {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    const timer = setTimeout(() => controller.abort(), first_ms);
    timer.unref?.();
    try {
      const upstream = await this.open(req.url, { method: req.method, headers: req.headers, body, signal: controller.signal });
      clearTimeout(timer);
      upstream.setTimeout(idle_ms, () => upstream.destroy(new Error('Google stream idle timeout')));
      res.writeHead(upstream.statusCode, { ...forward_headers(upstream.headers), 'X-Agy-Trace-Id': trace });
      await new Promise((resolve, reject) => {
        upstream.on('error', reject);
        res.on('error', reject);
        res.once('close', resolve);
        upstream.on('end', resolve);
        upstream.pipe(res);
      });
      return upstream.statusCode;
    } finally { clearTimeout(timer); res.removeListener('close', abort); }
  }

  close() { this.agent.destroy(); this.cache.clear(); }
}

function placeholder_for(id, used) {
  const start = crypto.createHash('sha1').update(id).digest().readUInt32BE(0) % 300;
  // Prefer the newer placeholder range, away from the UI's built-in named
  // Google effort presets. Always reserve all enums advertised by Google.
  const slots = [...Array.from({ length: 300 }, (_, i) => 700 + (start + i) % 300), ...Array.from({ length: 600 }, (_, i) => 100 + i)];
  for (const slot of slots) {
    const token = `MODEL_PLACEHOLDER_M${slot}`;
    if (!used.has(token)) { used.add(token); return token; }
  }
  throw new Error('too many custom models (900 placeholder slots)');
}

const EFFORT_LABELS = { inherit: 'Follow App', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', budget: 'Budget' };
export function custom_picker_models(config) {
  const result = [];
  for (const provider of config.providers) {
    const owned = provider.models.map(meta => ({ meta, id: meta.id, upstream: meta.upstream, display_name: meta.display_name }));
    for (const [id, entry] of Object.entries(config.model_map || {})) {
      if (entry.provider_id === provider.id && entry._auto !== true && !owned.some(m => m.id === id)) {
        owned.push({ id, upstream: entry.upstream, display_name: entry.display_name, meta: provider.models.find(m => m.upstream === entry.upstream) });
      }
    }
    for (const row of owned) {
      const levels = model_efforts(row.meta || { id: row.id, upstream: row.upstream });
      const supports = levels.some(e => !['inherit', 'none'].includes(e));
      const preferred = default_effort(row.meta || {}, levels);
      const base = (row.display_name || row.id) + ' · ' + provider.name;
      for (const effort of levels) {
        const id = `agy-bridge:${encodeURIComponent(provider.id)}:${encodeURIComponent(row.id)}:${effort}`;
        const suffix = ` (${EFFORT_LABELS[effort]})`;
        result.push({ ...row, id, model_id: row.id, provider, effort, supports, label: base + suffix,
          is_default: provider.id === config.active_provider_id && row.id === config.default_model && effort === preferred });
      }
    }
  }
  return result;
}

export function resolve_picker_model(id, config) {
  if (typeof id !== 'string' || !id.startsWith('agy-bridge:')) return null;
  return custom_picker_models(config).find(row => row.id === id) || null;
}

/** Preserve Google's fields and official model groups; prepend custom models. */
export function merge_available_models(wire, config, aliases = new Map(), official = new Map()) {
  const payload = wire.response && typeof wire.response === 'object' ? wire.response : wire;
  if (!payload.models || typeof payload.models !== 'object' || Array.isArray(payload.models)) return wire;
  const merged = structuredClone(wire);
  const out = merged.response && typeof merged.response === 'object' ? merged.response : merged;
  aliases.clear(); official.clear();
  const used = new Set(Object.values(payload.models).map(m => m.model).filter(Boolean));
  for (const [id, model] of Object.entries(payload.models)) {
    official.set(id, id);
    if (model.model) official.set(model.model, id);
  }
  const custom = custom_picker_models(config);
  const ids = custom.map(row => row.id);
  // Hash the ID, never its array index. Reserve enums owned by Google too.
  const tokens = new Map([...ids].sort().map(id => [id, placeholder_for(id, used)]));
  for (const row of custom) {
    const { id, meta } = row;
    const token = tokens.get(id);
    aliases.set(token, id);
    out.models[id] = {
      displayName: row.label,
      maxTokens: meta?.ctx || 128000,
      maxOutputTokens: meta?.max_out || 8192,
      tokenizerType: 'LLAMA_WITH_SPECIAL',
      model: token,
      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', modelProvider: 'MODEL_PROVIDER_GOOGLE',
      supportsImages: meta?.supports_images === true,
      supportsThinking: row.effort !== 'none' && row.supports,
      recommended: row.is_default,
    };
  }
  if (!ids.length) return merged;
  const local = new Set(ids);
  const sorts = Array.isArray(out.agentModelSorts) && out.agentModelSorts.length
    ? out.agentModelSorts : [{ displayName: 'Recommended', groups: [] }];
  out.agentModelSorts = sorts.map(sort => {
    const groups = (sort.groups || []).map(g => ({ ...g, modelIds: (g.modelIds || []).filter(id => !local.has(id)) }));
    if (!groups.length) groups.push({ modelIds: [] });
    // The desktop picker reads the first group. Keep official models visible
    // in that group when adding custom entries.
    groups[0].modelIds.unshift(...ids);
    return { ...sort, groups };
  });
  const selectedDefault = custom.find(row => row.is_default);
  if (selectedDefault) out.defaultAgentModelId = selectedDefault.id;
  const slot = [out.defaultAgentModelId || ids[0]];
  for (const key of ['commandModelIds', 'tabModelIds', 'mqueryModelIds', 'webSearchModelIds', 'commitMessageModelIds']) {
    if (!out[key]?.length) out[key] = slot.slice();
  }
  return merged;
}

export function model_from_placeholder(token, aliases) {
  return typeof token === 'string' ? aliases?.get(token) || '' : '';
}

export function model_from_user_settings(body) {
  if (!body || typeof body !== 'object') return '';
  const settings = body.userSettings && typeof body.userSettings === 'object' ? body.userSettings : body;
  for (const key of ['model', 'modelId', 'agentModelId', 'defaultModel']) {
    const value = settings[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      for (const inner of ['model', 'modelId', 'id']) {
        if (typeof value[inner] === 'string' && value[inner].trim()) return value[inner].trim();
      }
    }
  }
  return '';
}
