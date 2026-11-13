// Read-only model discovery. Endpoint facts win over the conservative fallback
// catalogue; unknown fields keep the user's current value. Never sends prompts.
import { auth_headers, normalize_base } from './providers/base.js';
import { clean_efforts, default_effort, model_capacity_error } from './model-schema.js';

const FIELDS = ['ctx', 'max_out', 'supports_images', 'reasoning_efforts'];
function positive(...values) { for (const v of values) { const n = Number(v); if (Number.isInteger(n) && n > 0 && n <= 100000000) return n; } }
function boolean(...values) { return values.find(v => typeof v === 'boolean'); }
export function read_model_metadata(raw, kind = 'openai', source = 'endpoint:list') {
  const row = typeof raw === 'string' ? { id: raw } : raw || {};
  const id = String(row.id || row.name || '').replace(kind === 'gemini' ? /^models\// : /$^/, '');
  const caps = row.capabilities || {}, limits = row.limits || {};
  const out = { id, display_name: row.display_name || row.displayName || id, config_sources: {} };
  out.ctx = positive(row.ctx, row.context_length, row.context_window, row.max_context_length, row.max_input_tokens, row.inputTokenLimit, limits.context_window, limits.max_input_tokens, row.top_provider?.context_length);
  out.max_out = positive(row.max_out, row.max_output_tokens, row.max_tokens, row.outputTokenLimit, row.maxOutputTokens, limits.max_output_tokens, row.top_provider?.max_completion_tokens);
  if (out.max_out > 10000000) delete out.max_out;
  out.supports_images = boolean(row.supports_images, row.supportsImages, row.vision, caps.image_input?.supported, caps.vision?.supported);
  const modalities = row.input_modalities || row.architecture?.input_modalities;
  if (out.supports_images === undefined && Array.isArray(modalities)) out.supports_images = modalities.includes('image');
  let levels = row.reasoning_efforts || row.supported_reasoning_efforts || row.supported_reasoning_levels || caps.reasoning?.efforts || caps.thinking?.efforts || caps.effort?.levels;
  if (!Array.isArray(levels) && caps.effort?.supported === true) {
    const explicit = Object.entries(caps.effort).filter(([k, v]) => v === true && clean_efforts([k]).length).map(([k]) => k);
    if (explicit.length) levels = explicit;
  }
  if (Array.isArray(levels)) { const clean = clean_efforts(levels); if (clean.length) out.reasoning_efforts = clean; }
  if (boolean(row.supports_reasoning, row.supportsThinking, caps.thinking?.supported, caps.reasoning?.supported) === false) out.reasoning_efforts = ['inherit'];
  for (const key of FIELDS) { if (out[key] === undefined) delete out[key]; else out.config_sources[key] = source; }
  return out;
}

// Exact known families / documented aliases only. Do not invent capacities for
// future names returned by a relay. Endpoint values always override these.
// https://aistudio.google.com/docs/models/gemini-3.8-flash
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon
// https://ai.google.dev/gemini-api/docs/gemini-3
// https://platform.claude.com/docs/en/about-claude/models/overview
// https://developers.openai.com/api/docs/models/gpt-5.2
const CATALOGUE = [
  // Direct streaming segment limit. Longer Argon decodes require upstream
  // continuation support; an explicit saved output target remains user-owned.
  { pattern: /^gemini-4-argon(?:-(?:preview|latest|low|medium|high))?$/, key: 'gemini-4-argon', ctx: 1048576, max_out: 65536, supports_images: true, reasoning_efforts: ['low', 'medium', 'high'] },
  { pattern: /^gpt-5\.2(?:-\d{4}-\d{2}-\d{2})?$/, key: 'gpt-5.2', ctx: 400000, max_out: 128000, supports_images: true, reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  { pattern: /^claude-sonnet-4[.-]6(?:-\d{8})?$/, key: 'claude-sonnet-4.6', ctx: 1000000, max_out: 64000, supports_images: true, reasoning_efforts: ['none', 'low', 'medium', 'high'] },
  { pattern: /^claude-opus-4[.-]6(?:-\d{8})?$/, key: 'claude-opus-4.6', ctx: 1000000, max_out: 128000, supports_images: true, reasoning_efforts: ['none', 'low', 'medium', 'high', 'max'] },
  { pattern: /^gemini-3\.8-flash(?:-(?:preview|latest|low|medium|high))?$/, key: 'gemini-3.8-flash', ctx: 1048576, max_out: 65536, supports_images: true, reasoning_efforts: ['minimal', 'low', 'medium', 'high'] },
  { pattern: /^gemini-3\.1-pro(?:-preview)?(?:-(?:low|medium|high))?$/, key: 'gemini-3.1-pro', ctx: 1048576, max_out: 65536, supports_images: true, reasoning_efforts: ['low', 'medium', 'high'] },
  { pattern: /^gemini-3-pro-preview$/, key: 'gemini-3-pro', ctx: 1048576, max_out: 65536, supports_images: true, reasoning_efforts: ['low', 'high'] },
  { pattern: /^gemini-3-flash-preview$/, key: 'gemini-3-flash', ctx: 1048576, max_out: 65536, supports_images: true, reasoning_efforts: ['minimal', 'low', 'medium', 'high'] },
  { pattern: /^gemini-2\.5-(?:pro|flash)(?:-preview-[\d-]+)?$/, key: 'gemini-2.5', ctx: 1048576, max_out: 65536, supports_images: true, reasoning_efforts: ['none', 'low', 'medium', 'high', 'budget'] },
];
export function catalogue_model(id) {
  const m = String(id || '').toLowerCase().replace(/^models\//, '');
  const entry = CATALOGUE.find(row => row.pattern.test(m));
  if (!entry) return { config_sources: {} };
  return { ...Object.fromEntries(FIELDS.map(k => [k, Array.isArray(entry[k]) ? [...entry[k]] : entry[k]])), config_sources: Object.fromEntries(FIELDS.map(k => [k, 'table:' + entry.key])) };
}

function details_url(provider, model) {
  const base = normalize_base(provider.kind, provider.base_url);
  const id = String(model.upstream || model.id).replace(/^models\//, '');
  return `${base}/${provider.kind === 'gemini' ? 'v1beta/' : ''}models/${encodeURIComponent(id)}`;
}
async function read_details(provider, model, signal, timeout) {
  try {
    const res = await fetch(details_url(provider, model), { method: 'GET', headers: auth_headers(provider.kind, provider.api_key), signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]), redirect: 'error' });
    if (!res.ok) { await res.body?.cancel(); return null; }
    const reader = res.body.getReader(); const chunks = []; let size = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); return null; } chunks.push(value); }
    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const row = raw.data && !Array.isArray(raw.data) ? raw.data : raw.model && typeof raw.model === 'object' ? raw.model : raw;
    const meta = read_model_metadata(row, provider.kind, 'endpoint:detail');
    // A relay may return a list, a different model or a generic success object.
    if (!meta.id || ![model.id, model.upstream, String(model.upstream || model.id).replace(/^models\//, '')].includes(meta.id)) return null;
    return meta;
  } catch { return null; }
}
export async function configure_models(provider, timeouts, list = { ok: false, models: [] }) {
  const started = Date.now(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000); timer.unref?.();
  const rows = Array.isArray(list.models) ? list.models : [];
  const details = new Map(); let cursor = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(4, provider.models.length) }, async () => {
      while (cursor < provider.models.length && !controller.signal.aborted) {
        const index = cursor++, model = provider.models[index];
        const meta = await read_details(provider, model, controller.signal, Math.min(timeouts.connect_ms || 6000, 6000));
        if (meta) details.set(index, meta);
      }
    }));
  } finally { clearTimeout(timer); }
  let matched = 0, endpoint_count = 0, table_count = 0;
  const unknown = [], warnings = list.ok ? [] : ['模型列表接口不可用；已尝试单模型详情与能力表。'];
  const models = provider.models.map((model, i) => {
    const fallback = catalogue_model(model.upstream || model.id);
    const listed = rows.find(row => row.id === model.upstream || row.id === model.id) || {};
    const detail = details.get(i) || {};
    const out = { ...model, config_sources: { ...model.config_sources } }; let any = false;
    for (const field of FIELDS) {
      const selected = [detail, listed, fallback].find(m => m[field] !== undefined);
      if (selected) { out[field] = selected[field]; out.config_sources[field] = selected.config_sources?.[field] || 'endpoint:list'; any = true; }
      else out.config_sources[field] = model.config_sources?.[field] || 'preserved';
    }
    if (any) matched++; else unknown.push(model.id);
    if (Object.values(out.config_sources).some(s => s.startsWith('endpoint:'))) endpoint_count++;
    if (Object.values(out.config_sources).some(s => s.startsWith('table:'))) table_count++;
    // Keep endpoint facts visible in the draft; never turn an inconsistent
    // limit into an apparently valid output ceiling equal to the whole context.
    const capacity_error = model_capacity_error([out]);
    if (capacity_error) warnings.push(capacity_error);
    out.reasoning_effort = default_effort(out);
    if (out.reasoning_efforts?.includes('budget') && out.thinking_budget < 0) out.thinking_budget = Math.max(0, Math.min(4096, out.max_out - 1));
    return out;
  });
  return { ok: true, models, configured: matched, endpoint_count, table_count, unknown, latency_ms: Date.now() - started,
    detail: `已检查 ${models.length} 个模型：端点 ${endpoint_count} 个，能力表 ${table_count} 个；${unknown.length} 个未识别并保留原值。`,
    warnings };
}
