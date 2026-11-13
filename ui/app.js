// agy-bridge 第三方 API 配置页 —— 原生 ES module，无框架、无外链。
// 四个分区：模型提供商 / 模型映射 / 运行日志 / 关于。

import { api, BridgeError, isMock } from './api.js';
import { icon } from './icons.js';

/* ══════════════════════════════════════════════════════════════
   常量与工具
   ══════════════════════════════════════════════════════════════ */

const KIND_ORDER = ['openai', 'anthropic', 'gemini'];
const KIND_LABEL = { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini' };
const EFFORT_LABEL = { inherit: '跟随应用', none: '关闭思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '最高', max: '最大（Max）', budget: '自定义预算' };
const EMBEDDED = new URLSearchParams(location.search).get('embedded') === '1';
const PARENT_ORIGIN = new URLSearchParams(location.search).get('parentOrigin');
function notifySaved() {
  if (EMBEDDED && PARENT_ORIGIN) window.parent.postMessage({ type: 'agy-bridge:saved' }, PARENT_ORIGIN);
}
const KIND_HINT = {
  openai: 'POST {base_url}/chat/completions',
  anthropic: 'POST {base_url}/v1/messages',
  gemini: 'POST {base_url}/v1beta/models/{model}:streamGenerateContent',
};
const BRIDGE_PORT = 18925;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = new Intl.NumberFormat('zh-CN');

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

function fmtTs(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts || '');
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h) return `${h} 小时 ${m} 分 ${rest} 秒`;
  if (m) return `${m} 分 ${rest} 秒`;
  return `${rest} 秒`;
}

function countMapped(value) {
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function isHttpUrl(v) {
  return /^https?:\/\/[^\s]+$/i.test(String(v || '').trim());
}

/* ══════════════════════════════════════════════════════════════
   状态
   ══════════════════════════════════════════════════════════════ */

const state = {
  page: 'providers',
  ready: false,
  loadError: null,

  version: '',
  healthVersion: '',
  healthOk: null,
  port: BRIDGE_PORT,
  activeProviderId: null,
  defaultModel: '',
  uptime: 0,
  requestCount: 0,
  cloudCodeUrl: '',
  configPath: '',

  providers: [],
  modelMap: {},
  mapRows: [],

  expanded: new Set(),
  drafts: new Map(),
  keys: new Map(),
  testResults: new Map(),
  saving: new Set(),
  errors: new Map(),

  addForm: null,

  logs: [],
  logLevel: 'all',
  logQuery: '',
  logAuto: true,
  logLoading: false,
  logError: null,
  logsTimer: null,

  saveActivePending: false,
};

const LOG_LEVELS = ['all', 'info', 'warn', 'error'];

/* ══════════════════════════════════════════════════════════════
   数据规整
   ══════════════════════════════════════════════════════════════ */

function toInt(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const text = String(value ?? '').trim().toLowerCase().replace(/[_,\s]/g, '');
  if (!text) return fallback;
  const hit = text.match(/^([0-9]*\.?[0-9]+)([km])?$/);
  if (!hit) return fallback;
  const scale = hit[2] === 'k' ? 1000 : hit[2] === 'm' ? 1_000_000 : 1;
  const out = Number(hit[1]) * scale;
  return Number.isFinite(out) ? Math.round(out) : fallback;
}

// 桥的模型条目是 {id, display_name, upstream, ctx, max_out}；ctx/max_out 是整数
function normalizeModel(m) {
  const knownGemini = /^gemini-(?:3\.8-flash|3\.1-pro|4-argon)(?:-(?:preview|latest|low|medium|high))*$/.test(m?.upstream || m?.upstream_model || m?.id || '');
  return {
    id: String(m?.id ?? ''),
    display_name: String(m?.display_name ?? m?.displayName ?? ''),
    upstream: String(m?.upstream ?? m?.upstream_model ?? ''),
    ctx: toInt(m?.ctx ?? m?.context_window ?? m?.max_tokens, 1048576),
    max_out: toInt(m?.max_out ?? m?.max_output ?? m?.maxOutputTokens, knownGemini ? 65536 : 131072),
    reasoning_effort: Object.hasOwn(EFFORT_LABEL, m?.reasoning_effort) ? m.reasoning_effort : 'inherit',
    thinking_budget: toInt(m?.thinking_budget, -1),
    reasoning_efforts: Array.isArray(m?.reasoning_efforts) ? [...m.reasoning_efforts] : ['inherit'],
    supports_images: m?.supports_images ?? null,
    config_sources: { ...m?.config_sources },
  };
}

function modelToWire(m) {
  return {
    id: String(m.id || '').trim(),
    display_name: String(m.display_name || '').trim() || String(m.id || '').trim(),
    upstream: String(m.upstream || '').trim() || String(m.id || '').trim(),
    ctx: toInt(m.ctx, 1048576),
    max_out: toInt(m.max_out, 131072),
    reasoning_effort: m.reasoning_effort || 'inherit',
    thinking_budget: toInt(m.thinking_budget, -1),
    reasoning_efforts: [...(m.reasoning_efforts || ['inherit'])],
    supports_images: m.supports_images ?? null,
    config_sources: { ...m.config_sources },
  };
}

function normalizeProvider(p) {
  return {
    id: String(p?.id ?? ''),
    name: String(p?.name ?? ''),
    kind: KIND_LABEL[p?.kind] ? p.kind : 'openai',
    base_url: String(p?.base_url ?? p?.baseUrl ?? ''),
    api_key: String(p?.api_key ?? p?.apiKey ?? ''),
    models: Array.isArray(p?.models) ? p.models.map(normalizeModel) : [],
  };
}

function draftOf(p) {
  return {
    name: p.name,
    kind: p.kind,
    base_url: p.base_url,
    api_key: p.api_key,
    models: clone(p.models),
  };
}

function mapToRows(map) {
  return Object.keys(map || {}).map((agy) => ({
    agy,
    provider_id: String(map[agy]?.provider_id ?? ''),
    upstream: String(map[agy]?.upstream ?? ''),
    display_name: String(map[agy]?.display_name ?? ''),
    aliases: Array.isArray(map[agy]?.aliases) ? map[agy].aliases : [],
    _auto: map[agy]?._auto === true,
  }));
}

function applyState(s) {
  state.version = String(s?.version ?? '');
  state.port = Number(s?.port) || BRIDGE_PORT;
  state.activeProviderId = s?.active_provider_id ?? null;
  state.defaultModel = String(s?.default_model ?? '');
  state.providers = Array.isArray(s?.providers) ? s.providers.map(normalizeProvider) : [];
  state.modelMap = s?.model_map && typeof s.model_map === 'object' ? s.model_map : {};
  state.mapRows = mapToRows(state.modelMap);
  state.uptime = Number(s?.uptime_s) || 0;
  state.requestCount = Number(s?.request_count) || 0;
  state.cloudCodeUrl = String(s?.cloud_code_url ?? '') || `http://127.0.0.1:${state.port}`;
  state.configPathIsDefault = !s?.config_path;
  state.configPath = String(s?.config_path ?? '') || '%APPDATA%\\agy-bridge\\config.json';

  const ids = new Set(state.providers.map((p) => p.id));
  for (const id of Array.from(state.expanded)) if (!ids.has(id)) state.expanded.delete(id);
  for (const id of Array.from(state.drafts.keys())) if (!ids.has(id)) state.drafts.delete(id);
  for (const id of Array.from(state.testResults.keys())) if (!ids.has(id)) state.testResults.delete(id);
}

/* ══════════════════════════════════════════════════════════════
   通用片段
   ══════════════════════════════════════════════════════════════ */

function bannerHtml() {
  if (!isMock()) return '';
  return `
    <div class="banner" role="status">
      <span class="banner-icon" aria-hidden="true">${icon('alert')}</span>
      <div class="banner-body">
        <span class="banner-title">桥未运行 · 正在使用本地示例数据</span>
        <span>没有探测到 <code>http://127.0.0.1:${BRIDGE_PORT}</code> 上的 agy-bridge。下面展示的是内置 mock 数据，改动只留在页面里，不会落盘。启动桥进程后点「重新连接」。</span>
      </div>
      <div class="banner-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-act="reconnect">重新连接</button>
      </div>
    </div>`;
}

function loadingHtml(text) {
  return `<div class="state-box"><span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span></div>`;
}

function errorHtml(message, actLabel, act) {
  return `
    <div class="state-box is-error">
      <span class="state-title">${esc(message)}</span>
      <span>检查桥进程是否在运行，或点下方按钮重试。</span>
      ${act ? `<button type="button" class="btn btn-secondary btn-sm" data-act="${act}">${esc(actLabel)}</button>` : ''}
    </div>`;
}

function emptyHtml(title, desc, actLabel, act) {
  return `
    <div class="state-box">
      <span class="state-title">${esc(title)}</span>
      <span>${esc(desc)}</span>
      ${act ? `<button type="button" class="btn btn-secondary btn-sm" data-act="${act}">${esc(actLabel)}</button>` : ''}
    </div>`;
}

function connPill() {
  const pill = $('#conn-pill');
  const text = $('#conn-text');
  if (!pill || !text) return;
  pill.hidden = false;
  pill.classList.toggle('is-mock', isMock());
  pill.classList.toggle('is-down', !isMock() && Boolean(state.loadError));
  if (isMock()) text.textContent = '本地预览';
  else if (state.loadError) text.textContent = '桥无响应';
  else text.textContent = `桥已连接 · :${state.port}`;
}

/* ══════════════════════════════════════════════════════════════
   页面一 · 模型提供商
   ══════════════════════════════════════════════════════════════ */

function providerRowHtml(p) {
  const open = state.expanded.has(p.id);
  const active = state.activeProviderId === p.id;
  const hasKey = Boolean(p.api_key);
  return `
    <li class="row-card" data-id="${esc(p.id)}">
      <div class="row-head">
        <span class="row-identity">
          <span class="credential-dot ${hasKey ? 'is-configured' : 'is-missing'}"
                title="${hasKey ? '已配置密钥' : '未配置密钥'}" aria-hidden="true"></span>
          <span class="row-name">${esc(p.name || p.id)}</span>
          <span class="chip">${esc(KIND_LABEL[p.kind] || p.kind)}</span>
          ${active ? '<span class="chip is-active">当前激活</span>' : ''}
        </span>
        <span class="row-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-act="toggle-provider" data-id="${esc(p.id)}"
                  aria-expanded="${open ? 'true' : 'false'}">${open ? '收起' : '编辑'}</button>
          <button type="button" class="btn btn-danger btn-sm" data-act="delete-provider" data-id="${esc(p.id)}">删除</button>
        </span>
      </div>
      ${open ? editorHtml(p) : ''}
    </li>`;
}

function editorHtml(p) {
  const d = state.drafts.get(p.id) || draftOf(p);
  const revealed = state.keys.get(p.id) === true;
  const test = state.testResults.get(p.id);
  const saving = state.saving.has(p.id);
  const err = state.errors.get(`provider:${p.id}`);

  return `
    <form class="editor" data-form="provider" data-id="${esc(p.id)}" novalidate>
      <div class="editor-header">
        <span class="editor-title">${esc(p.name || p.id)}</span>
        <span class="editor-route mono">${esc(p.id)} · ${esc(KIND_LABEL[d.kind] || d.kind)}</span>
      </div>

      <div class="field">
        <label class="field-label" for="key-${esc(p.id)}">
          API 密钥
          <button type="button" class="help-btn" aria-label="密钥说明"
                  title="优先使用此处填写的密钥；打码值原样提交表示不修改。">?</button>
        </label>
        <div class="key-input">
          <input class="input" id="key-${esc(p.id)}" type="${revealed ? 'text' : 'password'}"
                 autocomplete="new-password" spellcheck="false" placeholder="输入 API 密钥"
                 data-bind="api_key" value="${esc(d.api_key)}">
          <button type="button" class="key-toggle" data-act="toggle-key" data-id="${esc(p.id)}"
                  aria-pressed="${revealed ? 'true' : 'false'}"
                  aria-label="${revealed ? '隐藏密钥' : '显示密钥'}">${icon(revealed ? 'eyeOff' : 'eye')}</button>
        </div>
        <p class="field-hint">打码值（如 <span class="mono">sk-***abcd</span>）未改动时原样提交，桥进程识别为「不修改」。</p>
      </div>

      <div class="field">
        <label class="field-label" for="base-${esc(p.id)}">API 地址</label>
        <input class="input" id="base-${esc(p.id)}" type="text" inputmode="url" spellcheck="false"
               placeholder="没有默认地址" data-bind="base_url" value="${esc(d.base_url)}">
        <p class="field-hint">${esc(KIND_HINT[d.kind] || '')}</p>
      </div>

      <div class="field">
        <label class="field-label" for="kind-${esc(p.id)}">API 协议</label>
        <select class="input select" id="kind-${esc(p.id)}" data-bind="kind">
          ${KIND_ORDER.map(
            (k) => `<option value="${k}"${d.kind === k ? ' selected' : ''}>${esc(KIND_LABEL[k])}</option>`,
          ).join('')}
        </select>
      </div>

      <details class="disclosure" ${d.models.length ? 'open' : ''}>
        <summary>模型列表（${d.models.length}）</summary>
        <div class="disclosure-body">
          <ul class="model-list">
            ${
              d.models.length
                ? d.models.map((m, i) => modelRowHtml(p.id, m, i)).join('')
                : '<li class="model-empty">还没有模型。点「添加模型」，或从上游拉取可用模型。</li>'
            }
          </ul>
          <button type="button" class="btn-add-model" data-act="add-model" data-id="${esc(p.id)}">
            ${icon('plus', 12)} 添加模型
          </button>
          <p class="field-hint">上下文窗口与最大输出支持 <span class="mono">200K</span>、<span class="mono">1M</span> 或纯数字。上下文按文本估算，超限会报错。思考强度会按协议传给提供商；可用档位与真实容量以模型支持为准。OpenAI 兼容接口的自定义预算会折算为强度档位；新版 Claude 使用自适应思考。</p>
        </div>
      </details>

      ${test ? testResultHtml(test) : ''}
      ${err ? `<p class="field-error">${esc(err)}</p>` : ''}

      <div class="editor-actions is-split">
        <div class="actions-left">
          <button type="button" class="btn btn-secondary btn-sm" data-act="test-provider" data-id="${esc(p.id)}"
                  title="使用已保存的配置发起一次最小请求"
                  ${test && test.status === 'pending' ? 'disabled' : ''}>
            ${test && test.status === 'pending' ? '测试中…' : '测试连接'}
          </button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="fetch-models" data-id="${esc(p.id)}">获取可用模型</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="configure-models" data-id="${esc(p.id)}" title="从模型端点读取上限，按能力表补齐图片与思考档位，仅更新草稿">自动配置所有模型</button>
        </div>
        <div class="actions-right">
          <button type="button" class="btn btn-secondary" data-act="cancel-provider" data-id="${esc(p.id)}">取消</button>
          <button type="submit" class="btn btn-primary" ${saving ? 'disabled' : ''}>
            ${saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </form>`;
}

function modelRowHtml(providerId, m, i) {
  const attrs = `data-id="${esc(providerId)}" data-mi="${i}"`;
  return `
    <li class="model-entry">
      <div class="model-grid">
        <label class="model-field mg-id"><span>模型 ID</span><input class="input mg-code" type="text" spellcheck="false" placeholder="例如 gemini-3.8-flash"
               aria-label="模型 ID" data-model="id" ${attrs} value="${esc(m.id)}"></label>
        <label class="model-field mg-disp"><span>显示名称</span><input class="input" type="text" placeholder="模型在应用中的名称"
               aria-label="显示名称" data-model="display_name" ${attrs} value="${esc(m.display_name)}"></label>
        <label class="model-field mg-ups"><span>上游模型名</span><input class="input mg-code" type="text" spellcheck="false" placeholder="留空使用模型 ID"
               aria-label="上游模型名" data-model="upstream" ${attrs} value="${esc(m.upstream)}"></label>
        <label class="model-field mg-ctx"><span>上下文窗口 · tokens</span><input class="input" type="text" inputmode="numeric" placeholder="128K"
               aria-label="上下文窗口" data-model="ctx" ${attrs} value="${esc(m.ctx)}"></label>
        <label class="model-field mg-max"><span>最大输出 · tokens</span><input class="input" type="text" inputmode="numeric" placeholder="131072（128K）"
               aria-label="最大输出" data-model="max_out" ${attrs} value="${esc(m.max_out)}"></label>
        <label class="model-field mg-eff"><span>默认思考强度</span><select class="input select" aria-label="思考强度" data-model="reasoning_effort" ${attrs}>
          ${Object.entries(EFFORT_LABEL).filter(([value])=>m.reasoning_efforts.includes(value)).map(([value,label])=>`<option value="${value}"${m.reasoning_effort===value?' selected':''}>${label}</option>`).join('')}
        </select></label>
        <label class="model-field mg-budget"><span>思考预算 · tokens</span><input class="input" type="text" inputmode="numeric" placeholder="例如 4096"
               aria-label="思考预算" data-model="thinking_budget" ${attrs} value="${m.thinking_budget >= 0 ? esc(m.thinking_budget) : ''}" ${m.reasoning_efforts.includes('budget') ? '' : 'disabled'}></label>
        <button type="button" class="btn-icon is-danger mg-del" data-act="remove-model" data-id="${esc(providerId)}"
                data-mi="${i}" aria-label="删除模型">${icon('trash', 14)}</button>
      </div>
      <fieldset class="effort-choices"><legend>聊天中可选思考强度 · 多选</legend>${Object.entries(EFFORT_LABEL).map(([value,label])=>`<label><input type="checkbox" data-effort-choice="${value}" ${attrs} ${m.reasoning_efforts.includes(value)?'checked':''}>${label}</label>`).join('')}</fieldset>
      <label class="field-hint"><input type="checkbox" data-model="supports_images" ${attrs} ${m.supports_images === true ? 'checked' : ''}> 支持图片输入${m.supports_images === null ? '（未识别）' : ''}</label>
    </li>`;
}

function testResultHtml(test) {
  if (test.status === 'pending') {
    return `
      <div class="test-result is-pending">
        <span class="tr-dot" aria-hidden="true"></span>
        <div class="tr-body">正在测试连接…</div>
      </div>`;
  }
  const ok = test.status === 'ok';
  const bits = [];
  if (typeof test.latency_ms === 'number') bits.push(`延迟 ${test.latency_ms} ms`);
  if (test.http_status) bits.push(`HTTP ${test.http_status}`);
  return `
    <div class="test-result ${ok ? '' : 'is-fail'}" role="status">
      <span class="tr-dot" aria-hidden="true"></span>
      <div class="tr-body">
        <span>${ok ? '连接正常' : '连接失败'}${bits.length ? ` · ${esc(bits.join(' · '))}` : ''}</span>
        ${test.detail ? `<span class="tr-detail">${esc(test.detail)}</span>` : ''}
      </div>
    </div>`;
}

function addBlockHtml() {
  const f = state.addForm;
  return `
    <div class="add-block">
      <div class="add-actions">
        <button type="button" class="btn btn-add" data-act="open-add" data-mode="catalog" aria-expanded="${f ? 'true' : 'false'}">
          ${icon('plus', 14)} 添加提供商
        </button>
        <button type="button" class="btn btn-add" data-act="open-add" data-mode="custom" aria-expanded="${f ? 'true' : 'false'}">
          ${icon('plus', 14)} 自定义模型 API
        </button>
      </div>
      <p class="field-hint">选一种协议（OpenAI 兼容 / Anthropic / Gemini），填入地址与密钥即可接入；中转站、自部署服务同样走这里。</p>
      ${f ? addFormHtml(f) : ''}
    </div>`;
}

function addFormHtml(f) {
  const err = state.errors.get('create');
  return `
    <form class="editor" data-form="create" novalidate>
      <div class="editor-header">
        <span class="editor-title">新建提供商</span>
        <span class="editor-route">${f.mode === 'custom' ? '自定义模型 API' : '从协议开始'}</span>
      </div>

      <div class="field">
        <span class="field-label">API 协议</span>
        <div class="kind-picker">
          ${KIND_ORDER.map(
            (k) => `
            <button type="button" class="kind-opt" data-act="pick-kind" data-kind="${k}"
                    aria-pressed="${f.values.kind === k ? 'true' : 'false'}">
              <span class="kind-icon" aria-hidden="true">${icon(k === 'gemini' ? 'gem' : k === 'anthropic' ? 'brain' : 'plug')}</span>
              ${esc(KIND_LABEL[k])}
            </button>`,
          ).join('')}
        </div>
        <p class="field-hint">${esc(KIND_HINT[f.values.kind] || '')}</p>
      </div>

      <div class="form-row">
        <div class="field">
          <label class="field-label" for="new-name">名称</label>
          <input class="input" id="new-name" type="text" placeholder="如 relay-hub"
                 data-bind="new-name" value="${esc(f.values.name)}">
        </div>
        <div class="field">
          <label class="field-label" for="new-base">API 地址</label>
          <input class="input" id="new-base" type="text" inputmode="url" spellcheck="false"
                 placeholder="https://relay.example.com/v1" data-bind="new-base" value="${esc(f.values.base_url)}">
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="new-key">API 密钥</label>
        <div class="key-input">
          <input class="input" id="new-key" type="password" autocomplete="new-password" spellcheck="false"
                 placeholder="sk-…" data-bind="new-key" value="${esc(f.values.api_key)}">
          <button type="button" class="key-toggle" data-act="toggle-new-key" aria-pressed="false" aria-label="显示密钥">
            ${icon('eye')}
          </button>
        </div>
      </div>

      <div class="field">
        <span class="field-label">模型</span>
        <ul class="model-list">
          ${
            f.values.models.length
              ? f.values.models.map((m, i) => modelRowHtml('__new__', m, i)).join('')
              : '<li class="model-empty">至少添加一个模型。</li>'
          }
        </ul>
        <button type="button" class="btn-add-model" data-act="add-new-model">${icon('plus', 12)} 添加模型</button>
      </div>

      ${err ? `<p class="field-error">${esc(err)}</p>` : ''}

      <div class="editor-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel-add">取消</button>
        <button type="submit" class="btn btn-primary">创建提供商</button>
      </div>
    </form>`;
}

function renderProviders() {
  const body = $('[data-body="providers"]');
  if (!body) return;

  if (state.loadError) {
    body.innerHTML =
      bannerHtml() + errorHtml(state.loadError.message || '读取配置失败。', '重新读取', 'reload');
    return;
  }
  if (!state.ready) {
    body.innerHTML = loadingHtml('正在读取配置…');
    return;
  }

  const list = state.providers.length
    ? `<ul class="rows">${state.providers.map(providerRowHtml).join('')}</ul>`
    : emptyHtml('还没有提供商', '添加一个第三方 API，Antigravity 的请求就能转发出去。', '添加提供商', 'open-add-empty');

  body.innerHTML = bannerHtml() + addBlockHtml() + list;
}

/* ══════════════════════════════════════════════════════════════
   页面二 · 模型映射
   ══════════════════════════════════════════════════════════════ */

function providerOptions(selected, withEmpty = true) {
  const head = withEmpty ? '<option value="">未指定</option>' : '';
  return (
    head +
    state.providers
      .map(
        (p) =>
          `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name || p.id)}</option>`,
      )
      .join('')
  );
}

function renderMap() {
  const body = $('[data-body="map"]');
  if (!body) return;

  if (state.loadError) {
    body.innerHTML = bannerHtml() + errorHtml(state.loadError.message || '读取映射失败。', '重新读取', 'reload');
    return;
  }
  if (!state.ready) {
    body.innerHTML = loadingHtml('正在读取映射…');
    return;
  }

  const rows = state.mapRows.length
    ? state.mapRows.map((r, i) => mapRowHtml(r, i)).join('')
    : `<div class="state-box" style="border:none">
         <span class="state-title">还没有映射</span>
         <span>新增一条，或把现成的映射粘贴进来。</span>
       </div>`;

  body.innerHTML =
    bannerHtml() +
    `
    <div class="toolbar">
      <span class="caption">共 ${state.mapRows.length} 条映射 · 默认模型 <span class="mono">${esc(state.defaultModel || '未设置')}</span></span>
      <span class="toolbar-spacer"></span>
      <button type="button" class="btn btn-secondary btn-sm" data-act="map-import">批量粘贴导入</button>
      <button type="button" class="btn btn-secondary btn-sm" data-act="map-add">新增映射</button>
    </div>

    <form data-form="map" novalidate>
      <div class="map-table">
        ${rows}
      </div>
      <p class="field-hint">带 <span class="chip is-auto">自动</span> 标记的是保存提供商时后端自动镜像进来的映射；改动任意字段即转为手动，之后不会再被覆盖。</p>
      <p class="field-hint">未映射的模型会回落到「默认模型」。模型 ID 直接照抄 Antigravity 请求里的名字，如 <span class="mono">MODEL_PLACEHOLDER_M528</span>、<span class="mono">claude-sonnet-4-5</span>、<span class="mono">gemini-3-pro</span>。</p>
      <div class="editor-actions">
        <button type="button" class="btn btn-secondary" data-act="map-reload">还原</button>
        <button type="submit" class="btn btn-primary">保存映射</button>
      </div>
    </form>

    <details class="disclosure">
      <summary>激活提供商与默认模型</summary>
      <div class="disclosure-body">
        <div class="form-row">
          <div class="field">
            <label class="field-label" for="active-provider">激活提供商</label>
            <select class="input select" id="active-provider" data-bind="active_provider">
              ${providerOptions(state.activeProviderId, false)}
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="default-model">默认模型</label>
            <input class="input mono" id="default-model" type="text" spellcheck="false"
                   placeholder="MODEL_PLACEHOLDER_M528" data-bind="default_model" value="${esc(state.defaultModel)}">
          </div>
        </div>
        <div class="editor-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-act="save-active" ${state.saveActivePending ? 'disabled' : ''}>
            ${state.saveActivePending ? '保存中…' : '保存激活设置'}
          </button>
        </div>
      </div>
    </details>`;
}

function mapRowHtml(r, i) {
  return `
    <div class="map-row${r._auto ? ' is-auto' : ''}" data-row="${i}">
      <input class="input mono ma-agy" type="text" spellcheck="false" placeholder="MODEL_PLACEHOLDER_M528"
             aria-label="Antigravity 模型 ID" data-map="agy" data-row="${i}" value="${esc(r.agy)}">
      <select class="input select ma-prov" aria-label="提供商" data-map="provider_id" data-row="${i}">
        ${providerOptions(r.provider_id)}
      </select>
      <input class="input mono ma-ups" type="text" spellcheck="false" placeholder="上游模型 ID（留空用模型 ID）"
             aria-label="上游模型" data-map="upstream" data-row="${i}" value="${esc(r.upstream)}">
      <input class="input ma-disp" type="text" placeholder="显示名称"
             aria-label="显示名称" data-map="display_name" data-row="${i}" value="${esc(r.display_name)}">
      <span class="ma-tag" data-tag="${i}">${r._auto ? '<span class="chip is-auto" title="后端保存提供商时自动镜像，改任意字段即转为手动">自动</span>' : ''}</span>
      <button type="button" class="btn-icon is-danger ma-del" data-act="map-remove" data-row="${i}" aria-label="删除这条映射">
        ${icon('trash', 14)}
      </button>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   页面三 · 运行日志
   ══════════════════════════════════════════════════════════════ */

function visibleLogs() {
  const q = state.logQuery.trim().toLowerCase();
  return state.logs.filter((l) => {
    if (state.logLevel !== 'all' && String(l.level || '').toLowerCase() !== state.logLevel) return false;
    if (!q) return true;
    const hay = `${l.msg || ''} ${JSON.stringify(l.meta || {})}`.toLowerCase();
    return hay.includes(q);
  });
}

function logListHtml() {
  if (state.logError) {
    return errorHtml(state.logError.message || '拉取日志失败。', '重新拉取', 'log-refresh');
  }
  if (state.logLoading && !state.logs.length) return loadingHtml('正在读取日志…');

  const rows = visibleLogs();
  if (!rows.length) {
    return emptyHtml(
      state.logs.length ? '没有匹配的日志' : '暂无日志',
      state.logs.length ? '换个关键词，或把级别切回「全部」。' : '桥进程还没有写入任何日志。',
      '刷新', 'log-refresh',
    );
  }

  return `
    <ul class="log-list">
      ${rows
        .map((l) => {
          const level = String(l.level || 'info').toLowerCase();
          const lv = ['warn', 'error'].includes(level) ? level : 'info';
          const meta = l.meta && Object.keys(l.meta).length ? JSON.stringify(l.meta, null, 2) : '';
          return `
          <li class="log-row">
            <span class="log-ts">${esc(fmtTs(l.ts))}</span>
            <span class="log-lv is-${lv}">${esc(level)}</span>
            <span class="log-msg">${esc(l.msg || '')}</span>
            ${meta ? `<details class="log-meta"><summary>meta</summary><pre>${esc(meta)}</pre></details>` : ''}
          </li>`;
        })
        .join('')}
    </ul>`;
}

function renderLogs() {
  const body = $('[data-body="logs"]');
  if (!body) return;

  body.innerHTML =
    bannerHtml() +
    `
    <div class="toolbar">
      <div class="seg" role="group" aria-label="日志级别">
        ${LOG_LEVELS.map(
          (lv) =>
            `<button type="button" class="seg-btn" data-act="log-level" data-level="${lv}"
                     aria-pressed="${state.logLevel === lv ? 'true' : 'false'}">${lv === 'all' ? '全部' : lv}</button>`,
        ).join('')}
      </div>
      <div class="search-field">
        <span class="search-icon" aria-hidden="true">${icon('search', 14)}</span>
        <input class="input" id="log-search" type="search" placeholder="搜索关键词" autocomplete="off"
               data-bind="log-q" value="${esc(state.logQuery)}">
      </div>
      <span class="toolbar-spacer"></span>
      <label class="switch-label">
        <button type="button" class="switch" role="switch" aria-checked="${state.logAuto ? 'true' : 'false'}"
                data-act="log-auto" aria-label="自动刷新（2 秒）"><span class="thumb"></span></button>
        <span class="caption">自动刷新 2s</span>
      </label>
      <button type="button" class="btn btn-secondary btn-sm" data-act="log-refresh">刷新</button>
    </div>
    <div data-log-list>${logListHtml()}</div>`;
}

function updateLogList() {
  const el = $('[data-log-list]');
  if (el) el.innerHTML = logListHtml();
}

/* ══════════════════════════════════════════════════════════════
   页面四 · 关于
   ══════════════════════════════════════════════════════════════ */

function renderAbout() {
  const body = $('[data-body="about"]');
  if (!body) return;

  if (state.loadError) {
    body.innerHTML = bannerHtml() + errorHtml(state.loadError.message || '读取运行状态失败。', '重新读取', 'reload');
    return;
  }
  if (!state.ready) {
    body.innerHTML = loadingHtml('正在读取运行状态…');
    return;
  }

  body.innerHTML =
    bannerHtml() +
    `
    <div class="kv">
      <div class="kv-row"><span class="kv-key">版本</span><span class="kv-val mono">${esc(state.healthVersion || state.version || '未知')}</span></div>
      <div class="kv-row"><span class="kv-key">端口</span><span class="kv-val mono">127.0.0.1:${esc(state.port)}</span></div>
      <div class="kv-row"><span class="kv-key">请求计数</span><span class="kv-val">${nf.format(state.requestCount)} 次</span></div>
      <div class="kv-row"><span class="kv-key">运行时长</span><span class="kv-val">${esc(fmtUptime(state.uptime))}</span></div>
      <div class="kv-row"><span class="kv-key">运行状态</span><span class="kv-val">${
        state.providers.length
          ? `正常 · ${state.providers.length} 个提供商 · ${state.mapRows.length} 条映射`
          : '<span class="notice-warn">未配置任何提供商 —— 推理端点返回 503</span>'
      }</span></div>
      <div class="kv-row"><span class="kv-key">当前生效的 CLOUD_CODE_URL</span><span class="kv-val is-code">${esc(state.cloudCodeUrl)}</span></div>
      <div class="kv-row">
        <span class="kv-key">配置文件${state.configPathIsDefault ? '（默认路径）' : ''}</span>
        <span class="kv-val is-code">${esc(state.configPath)}</span>
      </div>
    </div>

    <div class="editor-actions">
      <button type="button" class="btn btn-secondary btn-sm" data-act="reload-config">重新加载配置</button>
    </div>

    <ul class="note-list">
      <li class="note">
        <span class="note-num" aria-hidden="true">1</span>
        <div class="note-body">
          <div class="note-title">启动与停止桥</div>
          <p class="note-desc">桥是本机的一个普通 Node 进程，没有服务、没有自启。</p>
          <code class="code-line">cd .agent_work/agy-bridge/build/core
node index.js
# 换端口：AGY_BRIDGE_PORT=${esc(state.port)} node index.js</code>
          <p class="note-desc">配置目录用 <span class="mono">AGY_BRIDGE_HOME</span> 指定，默认 <span class="mono">%APPDATA%\agy-bridge</span>。停止：在该终端按 <span class="mono">Ctrl+C</span>；进程卡死时 <span class="mono">taskkill /IM node.exe /F</span>（会连带杀掉其他 node 进程）。</p>
        </div>
      </li>
      <li class="note">
        <span class="note-num" aria-hidden="true">2</span>
        <div class="note-body">
          <div class="note-title">如何回滚</div>
          <p class="note-desc">改动只影响两处，回滚互不影响。</p>
          <code class="code-line"># 配置回滚：恢复上一份配置快照
copy /Y "%APPDATA%\\agy-bridge\\config.json.bak" "%APPDATA%\\agy-bridge\\config.json"

# 彻底退出接管：清掉 CLOUD_CODE_URL，重启 Antigravity
setx CLOUD_CODE_URL ""</code>
        </div>
      </li>
      <li class="note">
        <span class="note-num" aria-hidden="true">3</span>
        <div class="note-body">
          <div class="note-title">配置文件路径</div>
          <p class="note-desc">提供商、模型映射、激活项都在同一个 JSON 里；改完重启桥进程生效。</p>
          <code class="code-line">${esc(state.configPath)}</code>
          <p class="note-desc">可用环境变量 <span class="mono">AGY_BRIDGE_CONFIG</span> 指到别处。</p>
        </div>
      </li>
    </ul>`;
}

/* ══════════════════════════════════════════════════════════════
   渲染总入口
   ══════════════════════════════════════════════════════════════ */

function renderAll() {
  renderProviders();
  renderMap();
  renderLogs();
  renderAbout();
  connPill();
}

function renderPage(page) {
  if (page === 'providers') renderProviders();
  else if (page === 'map') renderMap();
  else if (page === 'logs') renderLogs();
  else if (page === 'about') renderAbout();
}

/* ══════════════════════════════════════════════════════════════
   弹窗 / Toast
   ══════════════════════════════════════════════════════════════ */

const dialogStack = [];

function openDialog({ title, desc = '', body = '', actions = [], size = '', onMount = null }) {
  const layer = document.createElement('div');
  layer.className = 'dialog-layer';
  layer.innerHTML = `
    <div class="dialog-mask" data-dialog-dismiss></div>
    <div class="dialog ${size}" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      <h2 class="dialog-title" id="dlg-title">${esc(title)}</h2>
      ${desc ? `<p class="dialog-desc">${desc}</p>` : ''}
      <button type="button" class="close-btn dialog-close" data-dialog-dismiss aria-label="关闭">${icon('close')}</button>
      <div class="dialog-body">${body}</div>
      <div class="dialog-actions">
        ${actions
          .map(
            (a) =>
              `<button type="button" class="btn ${a.cls || 'btn-secondary'}" data-dialog-act="${esc(a.id)}"${
                a.disabled ? ' disabled' : ''
              }>${esc(a.label)}</button>`,
          )
          .join('')}
      </div>
    </div>`;

  const restore = document.activeElement;
  $('#dialog-root').appendChild(layer);
  dialogStack.push({ el: layer, restore });

  layer.addEventListener('click', (e) => {
    const dismiss = e.target.closest('[data-dialog-dismiss]');
    if (dismiss) {
      closeDialog(layer);
      return;
    }
    const btn = e.target.closest('[data-dialog-act]');
    if (!btn) return;
    const act = actions.find((a) => a.id === btn.dataset.dialogAct);
    if (act && typeof act.onClick === 'function') act.onClick(layer, btn);
  });

  const focusable =
    layer.querySelector('.dialog-body input, .dialog-body textarea, .dialog-body select') ||
    layer.querySelector('.dialog-actions .btn-primary') ||
    layer.querySelector('.dialog-actions .btn') ||
    layer.querySelector('.dialog-close');
  if (focusable) focusable.focus();
  if (typeof onMount === 'function') onMount(layer);
  return layer;
}

function closeDialog(layer) {
  const idx = dialogStack.findIndex((d) => d.el === layer);
  if (idx < 0) return;
  const [entry] = dialogStack.splice(idx, 1);
  entry.el.remove();
  if (entry.restore && document.contains(entry.restore) && typeof entry.restore.focus === 'function') {
    entry.restore.focus();
  }
}

function closeTopDialog() {
  const top = dialogStack[dialogStack.length - 1];
  if (top) closeDialog(top.el);
}

function toast(message, isError = false) {
  const root = $('#toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast${isError ? ' is-error' : ''}`;
  el.innerHTML = `${icon(isError ? 'alert' : 'check', 14)}<span>${esc(message)}</span>`;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ══════════════════════════════════════════════════════════════
   数据加载
   ══════════════════════════════════════════════════════════════ */

async function loadAll() {
  state.loadError = null;
  try {
    const [s, health] = await Promise.all([api.state(), api.health().catch(() => null)]);
    applyState(s);
    if (health && health.version) state.healthVersion = String(health.version);
    state.healthOk = Boolean(health && health.ok !== false);
    if (!Array.isArray(s && s.providers)) {
      // 契约里 /api/state 一定带 providers；老版本桥只实现 /api/providers 时走这条兜底
      state.providers = (await api.providers()).map(normalizeProvider);
    }
    state.ready = true;
  } catch (err) {
    state.loadError = err instanceof BridgeError ? err : new BridgeError(String(err && err.message));
    state.ready = false;
  }
  renderAll();
}

async function loadLogs({ silent = false } = {}) {
  if (!silent) {
    state.logLoading = true;
    updateLogList();
  }
  try {
    const rows = await api.logs(200);
    state.logs = Array.isArray(rows) ? rows : [];
    state.logError = null;
  } catch (err) {
    state.logError = err instanceof BridgeError ? err : new BridgeError(String(err && err.message));
  } finally {
    state.logLoading = false;
    updateLogList();
  }
}

function syncLogTimer() {
  const want = state.page === 'logs' && state.logAuto;
  if (want && !state.logsTimer) {
    state.logsTimer = setInterval(() => {
      loadLogs({ silent: true }).catch(() => {});
    }, 2000);
  } else if (!want && state.logsTimer) {
    clearInterval(state.logsTimer);
    state.logsTimer = null;
  }
}

/* ══════════════════════════════════════════════════════════════
   动作
   ══════════════════════════════════════════════════════════════ */

function setPage(page) {
  state.page = page;
  $$('.nav-cell').forEach((btn) => {
    const on = btn.dataset.page === page;
    btn.classList.toggle('is-active', on);
    if (on) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  $$('.page').forEach((sec) => {
    sec.hidden = sec.dataset.page !== page;
  });
  if (page === 'logs' && !state.logs.length) loadLogs();
  syncLogTimer();
  const options = $('#options');
  if (options) options.scrollTop = 0;
}

function toggleProvider(id) {
  if (state.expanded.has(id)) {
    state.expanded.delete(id);
    state.drafts.delete(id);
    state.errors.delete(`provider:${id}`);
  } else {
    const p = state.providers.find((x) => x.id === id);
    if (!p) return;
    state.expanded.add(id);
    state.drafts.set(id, draftOf(p));
  }
  renderProviders();
}

function validateProviderDraft(d) {
  if (!d.name.trim()) return '请输入提供商名称。';
  // 地址可留空：留空表示「没有默认地址」，由协议适配器兜底
  if (d.base_url.trim() && !isHttpUrl(d.base_url)) return '请输入有效的 HTTP 或 HTTPS 地址。';
  const seen = new Set();
  for (const m of d.models) {
    const id = m.id.trim();
    if (!id) return '模型 ID 不能为空。';
    if (seen.has(id)) return '模型 ID 不能重复。';
    if (toInt(m.ctx, 0) <= 0 || toInt(m.max_out, 0) <= 0) return '上下文窗口和最大输出必须为正数。';
    if (toInt(m.max_out, 0) >= toInt(m.ctx, 0)) return '最大输出必须小于上下文窗口，为输入、历史消息和智能体指令预留空间。';
    if (!m.reasoning_efforts?.length) return '每个模型至少选择一个思考档位。';
    if (!m.reasoning_efforts.includes(m.reasoning_effort)) return '默认强度必须来自已选档位。';
    if (m.reasoning_efforts.includes('budget') && toInt(m.thinking_budget, -1) < 0) return '请输入思考预算（tokens）。';
    seen.add(id);
  }
  return null;
}

async function saveProvider(id) {
  const d = state.drafts.get(id);
  if (!d) return;
  const err = validateProviderDraft(d);
  if (err) {
    state.errors.set(`provider:${id}`, err);
    renderProviders();
    return;
  }
  state.errors.delete(`provider:${id}`);
  state.saving.add(id);
  renderProviders();
  try {
    const res = await api.updateProvider(id, {
      name: d.name.trim(),
      kind: d.kind,
      base_url: d.base_url.trim(),
      api_key: d.api_key,
      models: d.models.map(modelToWire),
    });
    const mapped = countMapped(res && res.mapped_models);
    toast(`已保存 ${d.name.trim() || id}${mapped ? ` · 新注册 ${mapped} 个模型映射` : ''}`);
    notifySaved();
    state.expanded.delete(id);
    state.drafts.delete(id);
    await loadAll();
  } catch (e) {
    toast(e.message || '保存失败', true);
    state.saving.delete(id);
    renderProviders();
  }
}

async function testProvider(id) {
  state.testResults.set(id, { status: 'pending' });
  renderProviders();
  try {
    const r = await api.testProvider(id);
    state.testResults.set(id, {
      status: r && r.ok ? 'ok' : 'fail',
      latency_ms: r?.latency_ms,
      http_status: r?.http_status,
      detail: r?.detail || '',
    });
  } catch (e) {
    state.testResults.set(id, { status: 'fail', detail: e.message || '测试失败' });
  }
  renderProviders();
}

async function deleteProvider(id) {
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  openDialog({
    title: `删除 ${p.name || p.id}？`,
    desc: '删除后会移除该提供商的配置；已映射到它的模型需要重新指定提供商。',
    size: 'is-sm',
    body: `<p class="field-hint">该操作立即写入配置文件，不可撤销。</p>`,
    actions: [
      { id: 'cancel', label: '取消' },
      {
        id: 'ok',
        label: '删除',
        cls: 'btn-danger',
        onClick: async (layer, btn) => {
          btn.disabled = true;
          btn.textContent = '删除中…';
          try {
            const res = await api.deleteProvider(id);
            closeDialog(layer);
            state.expanded.delete(id);
            state.drafts.delete(id);
            const removed = countMapped(res && res.removed_models);
            const kept = countMapped(res && res.kept_user_mappings);
            const bits = [];
            if (removed) bits.push(`移除 ${removed} 条自动映射`);
            if (kept) bits.push(`保留 ${kept} 条手动映射`);
            toast(`已删除 ${p.name || p.id}${bits.length ? ` · ${bits.join(' · ')}` : ''}`);
            await loadAll();
          } catch (e) {
            btn.disabled = false;
            btn.textContent = '删除';
            toast(e.message || '删除失败', true);
          }
        },
      },
    ],
  });
}

function openAddForm(mode) {
  if (state.addForm) {
    state.addForm = null;
    renderProviders();
    return;
  }
  state.addForm = {
    mode,
    values: { kind: 'openai', name: '', base_url: '', api_key: '', models: [] },
  };
  state.errors.delete('create');
  renderProviders();
  const first = $('#new-name');
  if (first) first.focus();
}

async function createProvider() {
  const f = state.addForm;
  if (!f) return;
  const v = f.values;
  let err = null;
  if (!v.name.trim()) err = '请输入提供商名称。';
  else if (!v.base_url.trim()) err = '请输入 API 地址。';
  else if (!isHttpUrl(v.base_url)) err = '请输入有效的 HTTP 或 HTTPS 地址。';
  else if (!v.models.length) err = '至少需要一个模型。';
  else if (v.models.some((m) => !m.id.trim())) err = '模型 ID 不能为空。';
  if (!err) err = validateProviderDraft(v);
  if (err) {
    state.errors.set('create', err);
    renderProviders();
    return;
  }
  state.errors.delete('create');
  try {
    const res = await api.createProvider({
      name: v.name.trim(),
      kind: v.kind,
      base_url: v.base_url.trim(),
      api_key: v.api_key,
      models: v.models.map(modelToWire),
    });
    const mapped = countMapped(res && res.mapped_models);
    toast(`已创建 ${v.name.trim()}${mapped ? ` · 已注册 ${mapped} 个模型` : ''}`);
    notifySaved();
    state.addForm = null;
    await loadAll();
  } catch (e) {
    state.errors.set('create', e.message || '创建失败');
    renderProviders();
  }
}

/* ── 获取可用模型 ── */

async function openFetchDialog(providerId) {
  const d = state.drafts.get(providerId);
  if (!d) return;

  let candidates = [];
  let checked = new Set(d.models.map((m) => m.id));
  let query = '';

  const layer = openDialog({
    title: '选择模型',
    desc: '以下是提供商返回的可用模型，勾选的模型会写入模型列表。',
    body: `
      <div class="toolbar">
        <div class="search-field">
          <span class="search-icon" aria-hidden="true">${icon('search', 14)}</span>
          <input class="input" id="cand-search" type="search" placeholder="搜索模型" autocomplete="off">
        </div>
        <button type="button" class="btn-link" data-cand="all">全选</button>
        <button type="button" class="btn-link" data-cand="none">取消全选</button>
        <button type="button" class="btn-link" data-cand="refetch">重新获取</button>
      </div>
      <div data-cand-list>${loadingHtml('正在询问提供商…')}</div>`,
    actions: [
      { id: 'cancel', label: '取消' },
      {
        id: 'apply',
        label: '更新列表',
        cls: 'btn-primary',
        onClick: () => applyCandidates(),
      },
    ],
  });

  const listBox = layer.querySelector('[data-cand-list]');
  const search = layer.querySelector('#cand-search');
  const applyBtn = layer.querySelector('[data-dialog-act="apply"]');
  applyBtn.disabled = true;

  function paint() {
    if (!candidates.length) {
      listBox.innerHTML = emptyHtml(
        '该提供商没有列出任何模型',
        '可以手动在模型列表里添加，或检查地址与密钥后重试。',
        '重新获取',
        'noop',
      );
      const retry = listBox.querySelector('[data-act="noop"]');
      if (retry) retry.addEventListener('click', fetchFromUpstream);
      return;
    }
    const q = query.trim().toLowerCase();
    const rows = candidates.filter((m) => !q || String(m.id || '').toLowerCase().includes(q));
    if (!rows.length) {
      listBox.innerHTML = `<div class="state-box"><span>没有匹配的模型。</span></div>`;
      return;
    }
    listBox.innerHTML = `
      <ul class="cand-list">
        ${rows
          .map((m) => {
            const id = String(m.id || '');
            return `
            <li>
              <label class="cand-row">
                <input type="checkbox" value="${esc(id)}" ${checked.has(id) ? 'checked' : ''}>
                <span class="cand-id">${esc(id)}</span>
                ${m.display_name ? `<span class="cand-sub">${esc(m.display_name)}</span>` : ''}
              </label>
            </li>`;
          })
          .join('')}
      </ul>
      <p class="field-hint">已选 ${checked.size} / ${candidates.length} 个模型。</p>`;
    $$('input[type="checkbox"]', listBox).forEach((box) => {
      box.addEventListener('change', () => {
        if (box.checked) checked.add(box.value);
        else checked.delete(box.value);
      });
    });
  }

  async function fetchFromUpstream() {
    listBox.innerHTML = loadingHtml('正在询问提供商…');
    applyBtn.disabled = true;
    try {
      const res = await api.fetchModels(providerId);
      candidates = Array.isArray(res?.models) ? res.models : [];
      applyBtn.disabled = !candidates.length;
      paint();
    } catch (e) {
      listBox.innerHTML = errorHtml(e.message || '获取模型失败。', '重试', 'noop');
      const retry = listBox.querySelector('[data-act="noop"]');
      if (retry) retry.addEventListener('click', fetchFromUpstream);
    }
  }

  function applyCandidates() {
    if (!checked.size) {
      toast('请至少保留一个勾选的模型。', true);
      return;
    }
    const byId = new Map(d.models.map((m) => [m.id, m]));
    d.models = Array.from(checked).map((id) => {
      const prev = byId.get(id);
      if (prev) return prev;
      const hit = candidates.find((c) => String(c.id) === id);
      return normalizeModel({
        id,
        display_name: hit?.display_name || hit?.displayName || id,
        upstream: hit?.upstream || id,
        ctx: hit?.ctx,
        max_out: hit?.max_out,
      });
    });
    state.drafts.set(providerId, d);
    closeDialog(layer);
    renderProviders();
    toast(`模型列表已更新（${d.models.length} 个）`);
  }

  layer.addEventListener('input', (e) => {
    if (e.target.id === 'cand-search') {
      query = e.target.value;
      paint();
    }
  });

  layer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cand]');
    if (!btn) return;
    const kind = btn.dataset.cand;
    if (kind === 'all') {
      candidates.forEach((m) => checked.add(String(m.id)));
      paint();
    } else if (kind === 'none') {
      checked.clear();
      paint();
    } else if (kind === 'refetch') {
      fetchFromUpstream();
    }
  });

  await fetchFromUpstream();
  if (search) search.focus();
}

/* ── 批量粘贴导入 ── */

function openImportDialog() {
  openDialog({
    title: '批量粘贴导入',
    desc: '每行一条，逗号或制表符分隔：<code>Antigravity 模型 ID, 提供商 ID, 上游模型, 显示名称</code>。显示名称可省略。',
    body: `
      <div class="field">
        <label class="field-label" for="import-text">映射文本</label>
        <textarea class="textarea" id="import-text" spellcheck="false"
          placeholder="MODEL_PLACEHOLDER_M528, ${esc(state.providers[0]?.id || 'prv_relay')}, claude-sonnet-4-5-20250929, Claude Sonnet 4.5
claude-sonnet-4-5, ${esc(state.providers[0]?.id || 'prv_relay')}, claude-sonnet-4-5-20250929
gemini-3-pro, ${esc(state.providers[1]?.id || 'prv_gemini')}, gemini-3-pro-preview"></textarea>
      </div>
      <p class="field-hint">提供商 ID 必须是已存在的提供商；留空的字段会用模型 ID 补齐。</p>`,
    actions: [
      { id: 'cancel', label: '取消' },
      {
        id: 'ok',
        label: '导入',
        cls: 'btn-primary',
        onClick: (layer) => {
          const text = layer.querySelector('#import-text').value;
          const parsed = parseImport(text);
          if (parsed.error) {
            toast(parsed.error, true);
            return;
          }
          const existing = new Set(state.mapRows.map((r) => r.agy));
          let added = 0;
          for (const row of parsed.rows) {
            if (existing.has(row.agy)) continue;
            state.mapRows.push(row);
            added += 1;
          }
          closeDialog(layer);
          renderMap();
          toast(`已导入 ${added} 条映射${parsed.skipped ? `，跳过 ${parsed.skipped} 行` : ''}`);
        },
      },
    ],
  });
}

function parseImport(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return { error: '没有可导入的内容。' };

  const known = new Set(state.providers.map((p) => p.id));
  const rows = [];
  let skipped = 0;

  for (const line of lines) {
    const parts = line.split(/\t|,|\|/).map((s) => s.trim());
    const agy = parts[0];
    const providerId = parts[1] || '';
    if (!agy) {
      skipped += 1;
      continue;
    }
    if (providerId && !known.has(providerId)) {
      skipped += 1;
      continue;
    }
    rows.push({
      agy,
      provider_id: providerId,
      upstream: parts[2] || agy,
      display_name: parts[3] || parts[2] || agy,
    });
  }

  if (!rows.length) return { error: '解析不出有效行：检查提供商 ID 是否存在。' };
  return { rows, skipped };
}

/* ══════════════════════════════════════════════════════════════
   事件
   ══════════════════════════════════════════════════════════════ */

function wireEvents() {
  // 导航
  $('#nav-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-cell');
    if (btn) setPage(btn.dataset.page);
  });

  // 主题
  $('#theme-toggle').addEventListener('click', toggleTheme);

  // 内容区：点击
  $('#options').addEventListener('click', onClick);

  // 内容区：输入
  $('#options').addEventListener('input', onInput);
  $('#options').addEventListener('change', onChange);

  // 内容区：表单提交（Enter 也能提交）
  $('#options').addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === 'provider') saveProvider(form.dataset.id);
    else if (form.dataset.form === 'create') createProvider();
    else if (form.dataset.form === 'map') saveMap();
  });

  // Esc 关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialogStack.length) {
      e.preventDefault();
      closeTopDialog();
    }
  });
}

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;

  switch (act) {
    case 'reload':
      loadAll();
      break;
    case 'reconnect':
      reconnect();
      break;
    case 'toggle-provider':
      toggleProvider(id);
      break;
    case 'cancel-provider':
      state.expanded.delete(id);
      state.drafts.delete(id);
      state.errors.delete(`provider:${id}`);
      state.testResults.delete(id);
      renderProviders();
      break;
    case 'delete-provider':
      deleteProvider(id);
      break;
    case 'test-provider':
      testProvider(id);
      break;
    case 'fetch-models':
      openFetchDialog(id);
      break;
    case 'configure-models': {
      const d = state.drafts.get(id); if (!d?.models?.length) { toast('请先添加模型。', true); break; }
      el.disabled = true; el.textContent = '正在自动配置…';
      api.configureModels({ ...d, id, models: d.models.map(modelToWire) }).then(r => {
        if (!r.ok) throw new Error(r.detail || '自动配置失败');
        d.models = r.models.map(normalizeModel); renderProviders(); toast(r.detail + ' 检查后保存。');
      }).catch(e => { toast(e.message, true); el.disabled = false; el.textContent = '自动配置所有模型'; });
      break;
    }
    case 'toggle-key': {
      const box = el.closest('.key-input');
      const input = box && box.querySelector('input');
      if (!input) break;
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      el.setAttribute('aria-pressed', String(reveal));
      el.setAttribute('aria-label', reveal ? '隐藏密钥' : '显示密钥');
      el.innerHTML = icon(reveal ? 'eyeOff' : 'eye');
      state.keys.set(id, reveal);
      break;
    }
    case 'toggle-new-key': {
      const box = el.closest('.key-input');
      const input = box && box.querySelector('input');
      if (!input) break;
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      el.setAttribute('aria-pressed', String(reveal));
      el.setAttribute('aria-label', reveal ? '隐藏密钥' : '显示密钥');
      el.innerHTML = icon(reveal ? 'eyeOff' : 'eye');
      break;
    }
    case 'add-model': {
      const d = state.drafts.get(id);
      if (!d) break;
      d.models.push(normalizeModel({ id: '' }));
      renderProviders();
      focusModel(id, d.models.length - 1);
      break;
    }
    case 'remove-model': {
      const d = state.drafts.get(id);
      const mi = Number(el.dataset.mi);
      if (!d || !d.models[mi]) break;
      d.models.splice(mi, 1);
      renderProviders();
      break;
    }
    case 'open-add':
      openAddForm(el.dataset.mode || 'catalog');
      break;
    case 'open-add-empty':
      openAddForm('catalog');
      $('#options').scrollTop = 0;
      break;
    case 'pick-kind': {
      if (!state.addForm) break;
      state.addForm.values.kind = el.dataset.kind;
      renderProviders();
      break;
    }
    case 'cancel-add':
      state.addForm = null;
      state.errors.delete('create');
      renderProviders();
      break;
    case 'add-new-model': {
      if (!state.addForm) break;
      state.addForm.values.models.push(normalizeModel({ id: '' }));
      renderProviders();
      focusModel('__new__', state.addForm.values.models.length - 1);
      break;
    }
    case 'map-add':
      state.mapRows.push({ agy: '', provider_id: state.providers[0]?.id || '', upstream: '', display_name: '' });
      renderMap();
      break;
    case 'map-remove': {
      const i = Number(el.dataset.row);
      state.mapRows.splice(i, 1);
      renderMap();
      break;
    }
    case 'map-import':
      openImportDialog();
      break;
    case 'map-reload':
      state.mapRows = mapToRows(state.modelMap);
      renderMap();
      toast('已还原为最近一次保存的映射');
      break;
    case 'save-active':
      saveActive();
      break;
    case 'log-level':
      state.logLevel = el.dataset.level;
      renderLogs();
      break;
    case 'log-auto':
      state.logAuto = !state.logAuto;
      syncLogTimer();
      renderLogs();
      if (state.logAuto) loadLogs({ silent: true });
      break;
    case 'log-refresh':
      loadLogs();
      break;
    case 'reload-config':
      reloadConfig();
      break;
    default:
      break;
  }
}

function focusModel(providerId, index) {
  const input = $(`input[data-model="id"][data-id="${providerId}"][data-mi="${index}"]`);
  if (input) input.focus();
}

function onInput(e) {
  const el = e.target;
  if (el.dataset.model) {
    const target =
      el.dataset.id === '__new__'
        ? state.addForm && state.addForm.values
        : state.drafts.get(el.dataset.id);
    const mi = Number(el.dataset.mi);
    if (target && target.models && target.models[mi]) target.models[mi][el.dataset.model] = el.type === 'checkbox' ? el.checked : el.value;
    return;
  }

  if (el.dataset.map) {
    const idx = Number(el.dataset.row);
    const row = state.mapRows[idx];
    if (!row) return;
    row[el.dataset.map] = el.value;
    if (row._auto) {
      // 用户显式改过 → 这条映射转为手动，提交时带 _auto: false
      row._auto = false;
      const line = el.closest('.map-row');
      if (line) {
        line.classList.remove('is-auto');
        const tag = line.querySelector(`[data-tag="${idx}"]`);
        if (tag) tag.innerHTML = '';
      }
    }
    return;
  }

  const bind = el.dataset.bind;
  if (!bind) return;

  if (bind === 'log-q') {
    state.logQuery = el.value;
    updateLogList();
    return;
  }
  if (bind === 'default_model') {
    state.defaultModel = el.value;
    return;
  }

  const form = el.closest('form[data-form]');
  if (!form) return;

  if (form.dataset.form === 'provider') {
    const d = state.drafts.get(form.dataset.id);
    if (d && bind in d) d[bind] = el.value;
  } else if (form.dataset.form === 'create') {
    const f = state.addForm;
    if (!f) return;
    const key = { 'new-name': 'name', 'new-base': 'base_url', 'new-key': 'api_key' }[bind];
    if (key) f.values[key] = el.value;
  }
}

function onChange(e) {
  const el = e.target;
  if (el.dataset.effortChoice) {
    const target = el.dataset.id === '__new__' ? state.addForm?.values : state.drafts.get(el.dataset.id);
    const m = target?.models?.[Number(el.dataset.mi)]; if (!m) return;
    const row = el.closest('.model-entry');
    m.reasoning_efforts = [...row.querySelectorAll('[data-effort-choice]:checked')].map(c=>c.dataset.effortChoice);
    if (!m.reasoning_efforts.includes(m.reasoning_effort)) m.reasoning_effort = m.reasoning_efforts[0] || '';
    row.querySelector('[data-model=reasoning_effort]').innerHTML = m.reasoning_efforts.map(v=>`<option value="${v}"${v===m.reasoning_effort?' selected':''}>${EFFORT_LABEL[v]}</option>`).join('');
    row.querySelector('[data-model=thinking_budget]').disabled = !m.reasoning_efforts.includes('budget');
    m.config_sources.reasoning_efforts = 'manual'; return;
  }
  if (el.dataset.model === 'reasoning_effort') {
    onInput(e);
    const budget = el.closest('.model-entry').querySelector('[data-model=thinking_budget]');
    // Budget availability follows the selected set, not just the default.
    return;
  }

  if (el.dataset.map === 'provider_id') {
    const row = state.mapRows[Number(el.dataset.row)];
    if (row) row.provider_id = el.value;
    return;
  }

  if (el.dataset.bind === 'active_provider') {
    state.activeProviderId = el.value || null;
    return;
  }

  const form = el.closest('form[data-form]');
  if (!form) return;
  if (form.dataset.form === 'provider' && el.dataset.bind === 'kind') {
    const d = state.drafts.get(form.dataset.id);
    if (d) {
      d.kind = el.value;
      renderProviders();
    }
  }
}

async function saveMap() {
  const map = {};
  for (const row of state.mapRows) {
    const agy = String(row.agy || '').trim();
    if (!agy) continue;
    map[agy] = {
      provider_id: row.provider_id || null,
      upstream: String(row.upstream || agy).trim(),
      display_name: String(row.display_name || row.upstream || agy).trim(),
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      _auto: row._auto === true,
    };
  }
  try {
    const res = await api.saveModelMap(map);
    const next = res && res.model_map && typeof res.model_map === 'object' ? res.model_map : map;
    state.modelMap = next;
    state.mapRows = mapToRows(next);
    renderMap();
    toast(`已保存 ${Object.keys(next).length} 条映射 · 已转为手动`);
  } catch (e) {
    toast(e.message || '保存映射失败', true);
  }
}

async function saveActive() {
  state.saveActivePending = true;
  renderMap();
  try {
    const res = await api.setActive({
      active_provider_id: state.activeProviderId,
      default_model: state.defaultModel.trim(),
    });
    if (res && res.default_model !== undefined) state.defaultModel = String(res.default_model || '');
    if (res && res.corrected) {
      toast(`该提供商下没有这个模型，已自动切到 ${res.default_model || '第一个模型'}`, true);
    } else {
      toast('激活设置已保存');
    }
    await loadAll();
  } catch (e) {
    toast(e.message || '保存激活设置失败', true);
  } finally {
    state.saveActivePending = false;
    renderMap();
  }
}

async function reloadConfig() {
  try {
    await api.reload();
    toast('已重新加载配置文件');
    await loadAll();
  } catch (e) {
    toast(e.message || '重新加载失败', true);
  }
}

async function reconnect() {
  const pill = $('#conn-text');
  if (pill) pill.textContent = '正在探测…';
  const alive = await api.probe();
  await loadAll();
  await loadLogs({ silent: true });
  toast(alive ? '已连接桥进程' : '仍然连不上桥进程，继续使用本地示例数据', !alive);
}

/* ══════════════════════════════════════════════════════════════
   主题
   ══════════════════════════════════════════════════════════════ */

const THEME_KEY = 'agy-bridge-theme';

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.dsTheme = next;
  const btn = $('#theme-toggle');
  if (btn) {
    btn.innerHTML = icon(next === 'dark' ? 'sun' : 'moon');
    btn.setAttribute('aria-label', next === 'light' ? '切换到深色主题' : '切换到浅色主题');
    btn.setAttribute('title', next === 'light' ? '切换到深色主题' : '切换到浅色主题');
  }
}

function initTheme() {
  // ?theme=light|dark 方便分享预览链接与截图
  const q = new URLSearchParams(location.search).get('theme');
  if (q === 'light' || q === 'dark') {
    applyTheme(q);
    try {
      localStorage.setItem(THEME_KEY, q);
    } catch {
      /* 忽略 */
    }
    return;
  }
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    saved = null;
  }
  applyTheme(saved || 'dark');
}

function toggleTheme() {
  const next = document.body.dataset.dsTheme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* 隐私模式下忽略 */
  }
}

/* ══════════════════════════════════════════════════════════════
   启动
   ══════════════════════════════════════════════════════════════ */

async function boot() {
  document.body.dataset.booted = '1';
  initTheme();
  if (EMBEDDED) {
    document.body.dataset.embedded = '1';
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'close-btn'; close.setAttribute('aria-label', '关闭模型设置');
    close.innerHTML = icon('close');
    close.onclick = () => {
      if (window.agyBridge?.close) return window.agyBridge.close();
      if (PARENT_ORIGIN) window.parent.postMessage({ type: 'agy-bridge:close' }, PARENT_ORIGIN);
    };
    document.querySelector('.header-actions').append(close);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dialogStack.length) close.click(); });
    if (window.agyBridge?.refreshModels) {
      const refresh = document.createElement('button');
      refresh.type = 'button'; refresh.className = 'btn btn-small'; refresh.textContent = '刷新模型列表';
      refresh.title = '重新加载当前应用窗口，以显示新增或删除的模型';
      refresh.onclick = () => window.agyBridge.refreshModels();
      document.querySelector('.header-actions').prepend(refresh);
    }
  }
  wireEvents();
  const qPage = new URLSearchParams(location.search).get('page');
  setPage(['providers', 'map', 'logs', 'about'].includes(qPage) ? qPage : 'providers');

  const alive = await api.probe();
  await loadAll();
  if (state.page === 'logs' || alive) await loadLogs({ silent: true });
  syncLogTimer();
  connPill();
}

boot().catch((err) => {
  state.loadError = err instanceof BridgeError ? err : new BridgeError(String(err && err.message));
  state.ready = false;
  renderAll();
});
