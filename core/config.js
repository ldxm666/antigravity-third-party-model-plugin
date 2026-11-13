// language: JavaScript (ESM), file: config.js, target: Node 24, deps: node: builtins only
//
// Config home resolution, defaults, atomic persistence, secret masking and
// model-map resolution. Everything here is pure data manipulation; no HTTP.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EFFORT_KEYS, model_efforts, default_effort, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT } from './model-schema.js';
import { catalogue_model } from './model-capabilities.js';

export const APP_VERSION = '1.5.7';
export const DEFAULT_PORT = 18925;
export const PROVIDER_KINDS = ['openai', 'anthropic', 'gemini'];
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

const SEED_MODEL_IDS = ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Data directory. Honours AGY_BRIDGE_HOME (used by the selftest harness so it
 * never touches the real %LOCALAPPDATA%\agy-bridge). Falls back to
 * %LOCALAPPDATA%\agy-bridge, then to a POSIX-ish location on non-Windows.
 */
export function home_dir() {
  const override = process.env.AGY_BRIDGE_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  const base =
    process.env.LOCALAPPDATA ||
    process.env.XDG_STATE_HOME ||
    path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'agy-bridge');
}

export function config_path() {
  return path.join(home_dir(), 'config.json');
}

export function log_dir() {
  return home_dir();
}

export function ui_root() {
  // build/core/ -> build/ui/. import.meta.dirname is already a native path on
  // Windows (no percent-encoding), which matters because the workspace path is
  // not ASCII.
  const here = import.meta.dirname;
  return path.resolve(here, '..', 'ui');
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Write a file atomically: temp file in the same directory, fsync, rename.
 * rename(2) is atomic on the same filesystem; on Windows Node maps it to
 * MoveFileExW(MOVEFILE_REPLACE_EXISTING) which is also atomic.
 */
export function atomic_write_json(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const text = JSON.stringify(value, null, 2) + '\n';
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fd already gone */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* temp may never have been created */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function new_provider_id(name) {
  const slug = String(name || 'provider')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'provider';
  return `${slug}-${crypto.randomBytes(3).toString('hex')}`;
}

export function default_config() {
  // No providers, no model map, no default model. A fresh install must never
  // silently route traffic at api.openai.com; the config page is the only way
  // in. The shape below is documented under `examples`, which the runtime
  // never reads.
  return {
    _comment: [
      'agy-bridge 配置文件。改完可以直接 POST /api/reload，不必重启。',
      'providers[].api_key 可以留空，配置页里填；保存时不会回传明文。',
      'model_map 的 key 是 Antigravity 侧看到的模型 id，value.upstream 是上游真实模型名。',
      'model_map 条目带 "_auto": true 表示由 provider 的 models[] 自动生成，可被覆盖；',
      '不带该字段或 _auto:false 表示用户显式指定，provider 同步时不会改动。',
      'LS 请求里出现 MODEL_PLACEHOLDER_Mxx 之类的占位符时，会回落到当前 provider 的默认模型。',
    ],
    port: DEFAULT_PORT,
    active_provider_id: '',
    default_model: '',
    providers: [],
    model_map: {},
    log_level: 'info',
    capture_requests: false,
    timeouts: {
      connect_ms: 20000,
      request_ms: 180000,
      stream_idle_ms: 120000,
    },
    examples: {
      _comment: '仅作文档参考，运行时不会读取这一节。',
      provider: {
        id: 'example-openai',
        name: '示例 OpenAI 兼容服务',
        kind: 'openai',
        base_url: 'https://api.openai.com',
        api_key: '',
        models: SEED_MODEL_IDS.map((id) => ({
          id,
          display_name: id,
          upstream: id,
          ctx: 128000,
          max_out: 8192,
        })),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function as_int(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min || i > max) return fallback;
  return i;
}

function as_str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function normalize_model_entry(raw, fallback_id) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const id = as_str(m.id, fallback_id).trim() || fallback_id;
  const levels = model_efforts({ ...m, id });
  const configured = EFFORT_KEYS.includes(m.reasoning_effort) ? m.reasoning_effort : 'inherit';
  const known = catalogue_model(as_str(m.upstream, id));
  return {
    id,
    display_name: as_str(m.display_name, as_str(m.displayName, id)).trim() || id,
    upstream: as_str(m.upstream, as_str(m.upstream_model, id)).trim() || id,
    ctx: as_int(m.ctx, as_int(m.max_tokens, known.ctx || DEFAULT_CONTEXT_WINDOW, 1, 100_000_000), 1, 100_000_000),
    max_out: as_int(m.max_out, as_int(m.maxOutputTokens, known.max_out || DEFAULT_MAX_OUTPUT, 1, 10_000_000), 1, 10_000_000),
    reasoning_efforts: levels,
    reasoning_effort: default_effort({ reasoning_effort: configured }, levels),
    thinking_budget: as_int(m.thinking_budget, -1, -1, 1_000_000),
    supports_images: typeof m.supports_images === 'boolean' ? m.supports_images : null,
    config_sources: Object.fromEntries(['ctx', 'max_out', 'supports_images', 'reasoning_efforts'].filter(k => typeof m.config_sources?.[k] === 'string').map(k => [k, m.config_sources[k].slice(0, 160)])),
  };
}

export function normalize_provider(raw, seen_ids) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const kind = PROVIDER_KINDS.includes(p.kind) ? p.kind : 'openai';
  let id = as_str(p.id).trim();
  if (!id || (seen_ids && seen_ids.has(id))) id = new_provider_id(p.name);
  if (seen_ids) seen_ids.add(id);
  const name = as_str(p.name).trim() || id;
  const models_in = Array.isArray(p.models) ? p.models : [];
  const seen_models = new Set();
  const models = [];
  for (const m of models_in) {
    const entry = normalize_model_entry(m, `model-${models.length + 1}`);
    if (seen_models.has(entry.id)) continue;
    seen_models.add(entry.id);
    models.push(entry);
  }
  return {
    id,
    name,
    kind,
    base_url: as_str(p.base_url).trim(),
    api_key: as_str(p.api_key),
    models,
  };
}

export function normalize_config(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const providers = [];
  for (const p of Array.isArray(src.providers) ? src.providers : []) {
    providers.push(normalize_provider(p, seen));
  }

  const model_map = {};
  const src_map = src.model_map && typeof src.model_map === 'object' ? src.model_map : {};
  for (const [key, value] of Object.entries(src_map)) {
    const agy_id = String(key).trim();
    if (!agy_id) continue;
    const v = value && typeof value === 'object' ? value : {};
    const upstream = as_str(v.upstream, as_str(v.upstream_model, agy_id)).trim() || agy_id;
    const entry = {
      provider_id: as_str(v.provider_id, as_str(v.provider, '')).trim(),
      upstream,
      display_name: as_str(v.display_name, as_str(v.displayName, agy_id)).trim() || agy_id,
      aliases: Array.isArray(v.aliases) ? v.aliases.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()) : [],
    };
    // _auto marks entries this bridge generated from a provider's models[].
    // Its absence means "user owns this mapping, do not touch it".
    if (v._auto === true) entry._auto = true;
    else if (v._auto === false) entry._auto = false;
    model_map[agy_id] = entry;
  }

  const provider_ids = new Set(providers.map((p) => p.id));
  let active_provider_id = as_str(src.active_provider_id).trim();
  if (!provider_ids.has(active_provider_id)) {
    active_provider_id = providers.length ? providers[0].id : '';
  }

  // A default model is legitimate if it is either mapped or declared by one of
  // the providers. Only when neither holds do we substitute something.
  const declared_ids = new Set();
  for (const provider of providers) for (const model of provider.models) declared_ids.add(model.id);

  let default_model = as_str(src.default_model).trim();
  if (!default_model || (!model_map[default_model] && !declared_ids.has(default_model))) {
    const first_key = Object.keys(model_map)[0];
    const active = providers.find((p) => p.id === active_provider_id);
    default_model = first_key || (active && active.models[0] ? active.models[0].id : '') || '';
  }

  const log_level = LOG_LEVELS.includes(src.log_level) ? src.log_level : 'info';
  const t = src.timeouts && typeof src.timeouts === 'object' ? src.timeouts : {};

  const normalized = {
    _comment: Array.isArray(src._comment) ? src._comment.filter((x) => typeof x === 'string') : default_config()._comment,
    port: as_int(src.port, DEFAULT_PORT, 1, 65535),
    active_provider_id,
    default_model,
    providers,
    model_map,
    log_level,
    capture_requests: src.capture_requests === true,
    timeouts: {
      connect_ms: as_int(t.connect_ms, 20000, 1000, 600000),
      request_ms: as_int(t.request_ms, 180000, 1000, 3600000),
      stream_idle_ms: as_int(t.stream_idle_ms, 120000, 1000, 3600000),
    },
  };
  // Documentation-only section; carried through untouched so the generated
  // config file keeps its examples without the runtime ever reading them.
  if (src.examples && typeof src.examples === 'object') normalized.examples = src.examples;
  return normalized;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Read config from disk. Missing file -> write the default config and return it.
 * Corrupt file -> move it aside (never lose the user's bytes) and start fresh.
 */
export function load_config(file = config_path()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const fresh = normalize_config(default_config());
      atomic_write_json(file, fresh);
      return { config: fresh, created: true, recovered: false, path: file };
    }
    throw err;
  }
  try {
    return { config: normalize_config(JSON.parse(text)), created: false, recovered: false, path: file };
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, backup); } catch { /* best effort */ }
    const fresh = normalize_config(default_config());
    atomic_write_json(file, fresh);
    return { config: fresh, created: true, recovered: true, backup, path: file };
  }
}

export function save_config(config, file = config_path()) {
  const normalized = normalize_config(config);
  atomic_write_json(file, normalized);
  return normalized;
}

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------

/**
 * sk-***abcd — first 3 + *** + last 4. Anything shorter than 9 chars collapses
 * to *** so we never leak a whole short key.
 */
export function mask_key(key) {
  const s = typeof key === 'string' ? key : '';
  if (!s) return '';
  if (s.length < 9) return '***';
  return `${s.slice(0, 3)}***${s.slice(-4)}`;
}

export function is_masked(value) {
  return typeof value === 'string' && value.includes('***');
}

export function mask_provider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    base_url: provider.base_url,
    api_key: mask_key(provider.api_key),
    api_key_set: Boolean(provider.api_key),
    models: provider.models.map((m) => ({ ...m })),
  };
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Reverse index: what the LS might echo back -> our agy-side model id.
 * Covers the literal map key, every alias, and every upstream name, because a
 * proxy in the middle may hand back the upstream id instead of ours.
 */
export function build_model_index(config) {
  const index = new Map();
  for (const [agy_id, entry] of Object.entries(config.model_map)) {
    index.set(agy_id, agy_id);
    for (const alias of entry.aliases || []) {
      if (!index.has(alias)) index.set(alias, agy_id);
    }
    if (entry.upstream && !index.has(entry.upstream)) index.set(entry.upstream, agy_id);
  }
  return index;
}

export function provider_by_id(config, id) {
  return config.providers.find((p) => p.id === id) || null;
}

/** A provider can actually be dialled: it has somewhere to go and something to say. */
export function provider_usable(provider) {
  return Boolean(provider && provider.base_url && provider.api_key);
}

function resolved(provider, agy_model, upstream, display_name, mapped, reason, notes) {
  return {
    agy_model,
    provider,
    upstream: upstream || agy_model,
    display_name: display_name || agy_model,
    mapped,
    reason,
    notes,
  };
}

/**
 * Resolve a requested model id to a concrete (provider, upstream) pair.
 *
 * Precedence, in order — every step is a deliberate answer to a real failure:
 *   1. model_map[requested]            explicit mapping
 *   2. model_map alias / upstream name the LS echoed back
 *   3. a provider's own models[]       a model the user declared on a provider
 *   4. default_model, if the active provider owns it
 *   5. the active provider's first model
 *   6. any provider that can be dialled
 *   7. the requested id verbatim against the active provider
 *
 * Steps 4/5 keep traffic on the provider the user just selected; a provider
 * with an empty api_key is only ever reached when nothing else exists.
 */
export function resolve_model(config, requested_model) {
  const requested = typeof requested_model === 'string' ? requested_model.trim() : '';
  const notes = [];
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const model_map = config.model_map || {};

  // A bare ID shared by providers follows the active provider unless the user
  // wrote an explicit mapping. Native picker IDs are scoped independently.
  const active_owner = provider_by_id(config, config.active_provider_id);
  if (requested && model_map[requested]?._auto === true && active_owner) {
    const declared = active_owner.models.find(m => m.id === requested);
    if (declared) return resolved(active_owner, declared.id, declared.upstream, declared.display_name, true, 'active_provider_model', notes);
  }

  const from_entry = (agy_id, reason) => {
    const entry = model_map[agy_id];
    if (!entry) return null;
    const provider = provider_by_id(config, entry.provider_id);
    if (!provider) {
      notes.push(`model_map['${agy_id}'] points at missing provider '${entry.provider_id}'`);
      return null;
    }
    return resolved(provider, agy_id, entry.upstream, entry.display_name, true, reason, notes);
  };

  // 1. exact mapping
  if (requested && model_map[requested]) {
    const hit = from_entry(requested, 'direct');
    if (hit) return hit;
  }

  // 2. alias / upstream name recorded inside model_map
  if (requested) {
    const via_index = build_model_index(config).get(requested);
    if (via_index && via_index !== requested && model_map[via_index]) {
      const hit = from_entry(via_index, 'alias');
      if (hit) return hit;
    }
  }

  // 3. declared on a provider but never mirrored into model_map
  if (requested) {
    for (const provider of providers) {
      const declared = provider.models.find((m) => m.id === requested || m.upstream === requested);
      if (declared) {
        return resolved(
          provider,
          declared.id,
          declared.upstream || requested,
          declared.display_name || declared.id,
          true,
          'provider_model',
          notes,
        );
      }
    }
    notes.push(`unmapped_model:${requested}`);
  }

  const active = provider_by_id(config, config.active_provider_id);
  const fallback_pool = [active, ...providers.filter((p) => p && p !== active)].filter(Boolean);
  const diallable = (p) => p.models.length > 0 && provider_usable(p);
  const with_models = (p) => p.models.length > 0;

  // 4. the configured default, when the active provider actually owns it
  if (config.default_model && active) {
    const owned = active.models.find((m) => m.id === config.default_model || m.upstream === config.default_model);
    if (owned) {
      return resolved(active, owned.id, owned.upstream, owned.display_name, false, requested ? 'fallback_default' : 'default', notes);
    }
  }

  // 5. the active provider's first model, else the first provider that works
  const target = fallback_pool.find(diallable) || fallback_pool.find(with_models);
  if (target) {
    const first = target.models[0];
    return resolved(target, first.id, first.upstream, first.display_name, false, requested ? 'fallback_active_provider' : 'default_active_provider', notes);
  }

  // 6. nothing is configured with models; keep the requested id on the active
  //    provider so the upstream at least reports a useful error.
  if (active && requested) {
    notes.push('no model declared anywhere, forwarding the requested id verbatim');
    return resolved(active, requested, requested, requested, false, 'active_provider_verbatim', notes);
  }

  return null;
}

// ---------------------------------------------------------------------------
// model_map <-> provider synchronisation
// ---------------------------------------------------------------------------

/**
 * Mirror a provider's models[] into model_map so the model picker shows them
 * immediately. Entries the user owns (anything without `_auto: true`) are never
 * touched, and neither is an entry that already belongs to another provider.
 */
export function sync_model_map_from_provider(config, provider) {
  const changed = [];
  if (!provider || !Array.isArray(provider.models)) return changed;
  if (!config.model_map || typeof config.model_map !== 'object') config.model_map = {};

  // Remove only obsolete auto-generated entries owned by this provider.
  // Explicit mappings and mappings owned by other providers remain intact.
  const declared = new Set(provider.models.map(m => m.id));
  for (const [id, entry] of Object.entries(config.model_map)) {
    if (entry.provider_id === provider.id && entry._auto === true && !declared.has(id)) delete config.model_map[id];
  }

  for (const model of provider.models) {
    if (!model || !model.id) continue;
    const existing = config.model_map[model.id];
    if (existing) {
      if (existing._auto !== true) continue; // user-owned: hands off
      if (existing.provider_id && existing.provider_id !== provider.id) continue; // first provider wins
      existing.provider_id = provider.id;
      existing.upstream = model.upstream || model.id;
      existing.display_name = model.display_name || model.id;
      changed.push(model.id);
      continue;
    }
    config.model_map[model.id] = {
      provider_id: provider.id,
      upstream: model.upstream || model.id,
      display_name: model.display_name || model.id,
      aliases: [],
      _auto: true,
    };
    changed.push(model.id);
  }
  return changed;
}

/**
 * Drop the auto-generated mappings that belong to a deleted provider. Explicit
 * user mappings survive and are reported so the UI can show them as dangling.
 */
export function drop_provider_model_map(config, provider_id) {
  const removed = [];
  const kept = [];
  for (const [agy_id, entry] of Object.entries(config.model_map || {})) {
    if (entry.provider_id !== provider_id) continue;
    if (entry._auto === true) {
      delete config.model_map[agy_id];
      removed.push(agy_id);
    } else {
      kept.push(agy_id);
    }
  }
  return { removed, kept };
}

/** The first model id a provider declares, or '' when it declares none. */
export function first_model_of(provider) {
  if (!provider || !Array.isArray(provider.models) || !provider.models.length) return '';
  return provider.models[0].id;
}

/** True when the provider declares this id (or upstream name). */
export function provider_declares(provider, model_id) {
  if (!provider || !Array.isArray(provider.models)) return null;
  return provider.models.find((m) => m.id === model_id || m.upstream === model_id) || null;
}

export function new_id(prefix = 'p') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}
