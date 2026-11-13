// 与本地桥进程（http://127.0.0.1:18925）通信的唯一出口。
// 只有显式 ?demo=1 才启用演示数据。离线必须显示真实错误。

export class BridgeError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'BridgeError';
    this.status = extra.status || 0;
    this.code = extra.code || 'error';
  }
}

const TIMEOUT_MS = 30000;

let mode = 'live'; // 'live' | 'mock'

export const isMock = () => mode === 'mock';
export const getMode = () => mode;

function setMode(next) {
  mode = next;
}

function errText(data, res) {
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string') return data.error;
    if (typeof data.message === 'string') return data.message;
    if (typeof data.raw === 'string' && data.raw.trim()) return data.raw.trim().slice(0, 300);
  }
  return `桥进程返回 HTTP ${res.status}`;
}

async function http(method, path, body) {
  const ctrl = new AbortController();
  const deadline = body?.operation === 'configure-models' ? 65000 : TIMEOUT_MS;
  const timer = setTimeout(() => ctrl.abort(), deadline);
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    if (!res.ok) throw new BridgeError(errText(data, res), { status: res.status, code: 'http' });
    return data;
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    if (err && err.name === 'AbortError') {
      throw new BridgeError(`请求超时（${deadline / 1000} 秒）`, { code: 'timeout' });
    }
    throw new BridgeError('无法连接本地桥进程（127.0.0.1:18925）', { code: 'offline' });
  } finally {
    clearTimeout(timer);
  }
}

/* ══════════════════════════════════════════════════════════════
   本地 mock：桥未启动时使用，形状与 HTTP 契约一致
   ══════════════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}`;

const MOCK_MODELS = {
  openai: [
    { id: 'gpt-5.1', display_name: 'GPT-5.1', upstream: 'gpt-5.1', context_window: '400K', max_output: '128K' },
    { id: 'gpt-5-mini', display_name: 'GPT-5 mini', upstream: 'gpt-5-mini', context_window: '272K', max_output: '64K' },
    { id: 'o4-mini', display_name: 'o4-mini', upstream: 'o4-mini', context_window: '200K', max_output: '100K' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', upstream: 'claude-sonnet-4-5-20250929', context_window: '200K', max_output: '64K' },
    { id: 'claude-opus-4-1', display_name: 'Claude Opus 4.1', upstream: 'claude-opus-4-1-20250805', context_window: '200K', max_output: '32K' },
  ],
  gemini: [
    { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro', upstream: 'gemini-3-pro-preview', context_window: '1M', max_output: '64K' },
    { id: 'gemini-2.5-flash', display_name: 'Gemini 2.5 Flash', upstream: 'gemini-2.5-flash', context_window: '1M', max_output: '32K' },
  ],
};

const mock = {
  version: '0.4.2',
  port: 18925,
  active_provider_id: 'prv_relay',
  default_model: 'MODEL_PLACEHOLDER_M528',
  cloud_code_url: 'http://127.0.0.1:18925',
  config_path: '%APPDATA%\\agy-bridge\\config.json',
  uptime_s: 7462,
  request_count: 1284,
  providers: [
    {
      id: 'prv_relay',
      name: 'relay-hub',
      kind: 'anthropic',
      base_url: 'https://relay.example.com/anthropic',
      api_key: 'sk-***9f2a',
      models: [
        { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', upstream: 'claude-sonnet-4-5-20250929', context_window: '200K', max_output: '64K' },
        { id: 'claude-opus-4-1', display_name: 'Claude Opus 4.1', upstream: 'claude-opus-4-1-20250805', context_window: '200K', max_output: '32K' },
      ],
    },
    {
      id: 'prv_gemini',
      name: 'gemini-direct',
      kind: 'gemini',
      base_url: 'https://generativelanguage.googleapis.com',
      api_key: 'AIza***7Qd1',
      models: [
        { id: 'gemini-3-pro', display_name: 'Gemini 3 Pro', upstream: 'gemini-3-pro-preview', context_window: '1M', max_output: '64K' },
      ],
    },
    {
      id: 'prv_local',
      name: '本地 vLLM',
      kind: 'openai',
      base_url: 'http://127.0.0.1:8000/v1',
      api_key: '',
      models: [],
    },
  ],
  model_map: {
    MODEL_PLACEHOLDER_M528: { provider_id: 'prv_relay', upstream: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', _auto: true },
    'claude-sonnet-4-5': { provider_id: 'prv_relay', upstream: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', _auto: true },
    'gemini-3-pro': { provider_id: 'prv_gemini', upstream: 'gemini-3-pro-preview', display_name: 'Gemini 3 Pro', _auto: false },
  },
  logs: [],
};

function seedLogs() {
  const now = Date.now();
  const lines = [
    ['info', 'agy-bridge 启动，监听 127.0.0.1:18925', { pid: 19432 }],
    ['info', '已加载配置：3 个提供商，3 条模型映射', { source: 'config.json' }],
    ['info', 'POST /v1internal:loadCodeAssist 200 12ms', { tier: 'PRO', user: 'local' }],
    ['info', 'POST /v1internal:streamGenerateContent → anthropic relay-hub', { model: 'claude-sonnet-4-5-20250929' }],
    ['warn', '上游返回 429，退避 800ms 后重试（第 1 次）', { provider: 'relay-hub', retry_after: 0.8 }],
    ['info', '重试成功，流式响应已建立', { upstream_status: 200 }],
    ['info', 'GET /v1internal:fetchUserInfo 401（Google 硬编码端点，预期行为）', { handled: true }],
    ['warn', '模型 MODEL_PLACEHOLDER_M36 未映射，回落到默认模型', { fallback: 'MODEL_PLACEHOLDER_M528' }],
    ['error', '上游连接被重置：ECONNRESET（上游 10.0.0.7:443）', { attempt: 3, provider: 'relay-hub' }],
    ['info', 'GET /api/health 200 1ms', { ua: 'agy-bridge-ui' }],
  ];
  mock.logs = lines.map(([level, msg, meta], i) => ({
    ts: new Date(now - (lines.length - i) * 41_000).toISOString(),
    level,
    msg,
    meta,
  }));
}
seedLogs();

function mockState() {
  return {
    version: mock.version,
    port: mock.port,
    active_provider_id: mock.active_provider_id,
    default_model: mock.default_model,
    providers: clone(mock.providers),
    model_map: clone(mock.model_map),
    uptime_s: mock.uptime_s,
    request_count: mock.request_count,
    cloud_code_url: mock.cloud_code_url,
    config_path: mock.config_path,
  };
}

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

function mockLog(line) {
  mock.logs.push({
    ts: new Date().toISOString(),
    level: line.level || 'info',
    msg: line.msg,
    meta: line.meta || {},
  });
  if (mock.logs.length > 500) mock.logs.splice(0, mock.logs.length - 500);
}

/* ══════════════════════════════════════════════════════════════
   对外 API
   ══════════════════════════════════════════════════════════════ */

export const api = {
  /** 探测桥是否在跑；失败则切 mock 并返回 false。 */
  async probe() {
    try {
      await http('GET', '/api/health');
      setMode('live');
      return true;
    } catch {
      setMode(new URLSearchParams(location.search).get('demo') === '1' ? 'mock' : 'live');
      return false;
    }
  },

  async health() {
    if (isMock()) {
      await sleep(60);
      return { ok: true, version: mock.version, mock: true };
    }
    return http('GET', '/api/health');
  },

  async state() {
    if (isMock()) {
      await sleep(180);
      return mockState();
    }
    return http('GET', '/api/state');
  },

  async providers() {
    if (isMock()) {
      await sleep(140);
      return clone(mock.providers);
    }
    const data = await http('GET', '/api/providers');
    return Array.isArray(data) ? data : (data && data.providers) || [];
  },

  async createProvider(payload) {
    if (isMock()) {
      await sleep(320);
      const provider = {
        id: rid('prv'),
        name: payload.name || '未命名提供商',
        kind: payload.kind || 'openai',
        base_url: payload.base_url || '',
        api_key: payload.api_key ? mask(payload.api_key) : '',
        models: clone(payload.models || []),
      };
      mock.providers.push(provider);
      for (const m of provider.models) {
        if (m.id) mock.model_map[m.id] = { provider_id: provider.id, upstream: m.upstream || m.id, display_name: m.display_name || m.id, _auto: true };
      }
      mockLog({ msg: `新建提供商 ${provider.name}（${provider.kind}）`, meta: { id: provider.id } });
      return { ok: true, provider: clone(provider), mapped_models: provider.models.filter((m) => m.id).length };
    }
    return http('POST', '/api/providers', payload);
  },

  async updateProvider(id, payload) {
    if (isMock()) {
      await sleep(280);
      const p = mock.providers.find((x) => x.id === id);
      if (!p) throw new BridgeError('提供商不存在', { status: 404 });
      Object.assign(p, clone(payload));
      let mirrored = 0;
      for (const m of p.models || []) {
        if (!m.id) continue;
        if (!mock.model_map[m.id]) {
          mock.model_map[m.id] = { provider_id: p.id, upstream: m.upstream || m.id, display_name: m.display_name || m.id, _auto: true };
          mirrored += 1;
        }
      }
      mockLog({ msg: `更新提供商 ${p.name}`, meta: { id } });
      return { ok: true, provider: clone(p), mapped_models: mirrored };
    }
    return http('PATCH', `/api/providers/${encodeURIComponent(id)}`, payload);
  },

  async deleteProvider(id) {
    if (isMock()) {
      await sleep(220);
      const i = mock.providers.findIndex((x) => x.id === id);
      let removed = 0;
      let kept = 0;
      if (i >= 0) {
        const [gone] = mock.providers.splice(i, 1);
        for (const [agy, entry] of Object.entries(mock.model_map)) {
          if (entry.provider_id !== id) continue;
          if (entry._auto) {
            delete mock.model_map[agy];
            removed += 1;
          } else {
            kept += 1;
          }
        }
        if (mock.active_provider_id === id) mock.active_provider_id = mock.providers[0]?.id || null;
        mockLog({ level: 'warn', msg: `删除提供商 ${gone.name}`, meta: { id } });
      }
      return { ok: true, deleted: id, removed_models: removed, kept_user_mappings: kept };
    }
    return http('DELETE', `/api/providers/${encodeURIComponent(id)}`);
  },

  async testProvider(id) {
    if (isMock()) {
      const p = mock.providers.find((x) => x.id === id);
      const t0 = performance.now();
      await sleep(420 + Math.random() * 380);
      const latency = Math.round(performance.now() - t0);
      if (!p || !p.base_url) {
        return { ok: false, latency_ms: latency, detail: '缺少 API 地址：无法确定请求端点。', http_status: 0 };
      }
      if (!p.api_key) {
        return { ok: false, latency_ms: latency, detail: '上游返回 401：no api key provided', http_status: 401 };
      }
      return {
        ok: true,
        latency_ms: latency,
        detail: `pong · 上游 ${p.kind} · 可用模型 ${(MOCK_MODELS[p.kind] || []).length} 个`,
        http_status: 200,
      };
    }
    return http('POST', `/api/providers/${encodeURIComponent(id)}/test`, {});
  },

  async fetchModels(id) {
    if (isMock()) {
      const p = mock.providers.find((x) => x.id === id);
      await sleep(620);
      if (!p) throw new BridgeError('提供商不存在', { status: 404 });
      if (!p.base_url) throw new BridgeError('请先填写 API 地址，再获取。', { status: 400 });
      return { ok: true, models: clone(MOCK_MODELS[p.kind] || []) };
    }
    return http('POST', `/api/providers/${encodeURIComponent(id)}/fetch-models`, {});
  },

  async configureModels(draft) {
    if (isMock()) throw new BridgeError('自动配置需要连接真实桥进程。');
    return http('POST', '/api/providers/preview', { ...draft, operation: 'configure-models' });
  },

  async saveModelMap(map) {
    if (isMock()) {
      await sleep(260);
      mock.model_map = clone(map);
      mockLog({ msg: `保存模型映射，共 ${Object.keys(map).length} 条` });
      return { ok: true, count: Object.keys(map).length };
    }
    return http('POST', '/api/model-map', { map });
  },

  async setActive(payload) {
    if (isMock()) {
      await sleep(200);
      if (payload.active_provider_id !== undefined) mock.active_provider_id = payload.active_provider_id;
      if (payload.default_model !== undefined) mock.default_model = payload.default_model;
      mockLog({ msg: `切换激活提供商 → ${payload.active_provider_id || '无'}` });
      return {
        ok: true,
        active_provider_id: mock.active_provider_id,
        default_model: mock.default_model,
        corrected: false,
      };
    }
    return http('POST', '/api/active', payload);
  },

  async reload() {
    if (isMock()) {
      await sleep(180);
      mockLog({ msg: '重新加载配置文件' });
      return { ok: true, reloaded: true };
    }
    return http('POST', '/api/reload', {});
  },

  async logs(limit = 200) {
    if (isMock()) {
      await sleep(120);
      return clone(mock.logs.slice(-limit));
    }
    const data = await http('GET', `/api/logs?limit=${encodeURIComponent(limit)}`);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.logs)) return data.logs;
    return [];
  },
};

function mask(key) {
  if (key.length <= 7) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

export const mockMeta = {
  get port() {
    return mock.port;
  },
  get configPath() {
    return mock.config_path;
  },
};
