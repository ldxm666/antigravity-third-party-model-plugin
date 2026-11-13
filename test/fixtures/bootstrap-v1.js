// language: JavaScript (ESM), file: bootstrap.js, target: Node 24, deps: node: builtins only
//
// TEST FIXTURE ONLY: synthetic v1 wire shapes for isolated regression tests.
// Imported only by test/control-plane.mjs, never by the production bridge.
// The fixture contains deterministic test identities and entitlements; it does
// not represent a real account or establish Google authentication acceptance.
//
// Shape notes (from the captured fam_data.json):
//   fetchAvailableModels.models is an OBJECT map keyed by model id, not an array,
//   and the picker itself is driven by agentModelSorts[0].groups[0].modelIds.

import crypto from 'node:crypto';

const PROJECT_ID = 'agy-bridge-local';
const TOKENIZER = 'LLAMA_WITH_SPECIAL';

/** placeholder id -> agy model id, filled whenever we build the model list. */
const placeholder_index = new Map();

function iso_in(ms) {
  return new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function project_id(config) {
  const from_config = config && typeof config.project === 'string' ? config.project.trim() : '';
  return from_config || PROJECT_ID;
}

function model_ids(config) {
  return Object.keys(config.model_map || {});
}

/**
 * Stable synthetic enum for a model id. Hashed rather than index-based so that
 * reordering or inserting a model in the config never reshuffles the enums the
 * language server may already have cached.
 */
function placeholder_for(model_id) {
  const digest = crypto.createHash('sha1').update(String(model_id)).digest();
  const n = 100 + (digest.readUInt16BE(0) % 900);
  return `MODEL_PLACEHOLDER_M${n}`;
}

function model_configs(config) {
  const ids = model_ids(config);
  return ids.map((id, index) => {
    const entry = config.model_map[id];
    const provider = (config.providers || []).find((p) => p.id === entry.provider_id) || null;
    const model_meta = provider ? provider.models.find((m) => m.id === id || m.upstream === entry.upstream) : null;
    return {
      modelId: id,
      displayName: entry.display_name || id,
      tier: 'PRO',
      supportsTools: true,
      maxOutputTokens: model_meta ? model_meta.max_out : 8192,
      maxTokens: model_meta ? model_meta.ctx : 1048576,
      placeholder: placeholder_for(id),
    };
  });
}

/**
 * Real-machine A/B result: the language server walks its state machine only
 * when allowedTiers contains `free-tier` (it onboards with
 * `{"tierId":"free-tier"}`), `gcpManaged` is false and
 * `userDefinedCloudaicompanionProject` is true. currentTier.id only needs to be
 * a tier the server recognises.
 */
export function load_code_assist(config) {
  const configs = model_configs(config);
  const current_tier = {
    id: 'standard',
    name: 'Antigravity Standard Quota',
    description: 'AI-powered coding assistant',
    privacyNotice: { showNotice: false, noticeText: '' },
  };
  return {
    currentTier: current_tier,
    allowedTiers: [
      {
        id: 'free-tier',
        name: 'Antigravity Free Tier',
        description: 'AI-powered coding assistant',
        isDefault: true,
        userDefinedCloudaicompanionProject: true,
      },
      {
        id: 'standard',
        name: 'Antigravity Standard Quota',
        description: 'AI-powered coding assistant',
        isDefault: false,
        userDefinedCloudaicompanionProject: true,
      },
    ],
    cloudaicompanionProject: project_id(config),
    userTier: 'STANDARD',
    gcpManaged: false,
    tierId: 'standard',
    modelConfigs: configs.map((c) => ({
      modelId: c.modelId,
      displayName: c.displayName,
      tier: 'PRO',
      supportsTools: c.supportsTools,
      maxOutputTokens: c.maxOutputTokens,
    })),
  };
}

/**
 * Payload only — the caller wraps it in the outer `{"response": ...}` envelope,
 * which makes the wire form `{"response": {"done":true, ..., "response": {...}}}`.
 * The nested `response` is intentional and matches the real operation shape.
 */
export function onboard_user(config) {
  const project = project_id(config);
  return {
    done: true,
    name: 'operations/onboardUser',
    response: {
      cloudaicompanionProject: { id: project, name: project },
      status: 'SUCCESS',
    },
  };
}

export function fetch_available_models(config) {
  placeholder_index.clear();
  const ids = model_ids(config);
  const models = {};
  const reset = iso_in(24 * 3600 * 1000);

  ids.forEach((id, index) => {
    const entry = config.model_map[id];
    const provider = (config.providers || []).find((p) => p.id === entry.provider_id) || null;
    const model_meta = provider ? provider.models.find((m) => m.id === id || m.upstream === entry.upstream) : null;
    const placeholder = placeholder_for(index);
    placeholder_index.set(placeholder, id);
    models[id] = {
      displayName: entry.display_name || id,
      maxTokens: model_meta ? model_meta.ctx : 1048576,
      maxOutputTokens: model_meta ? model_meta.max_out : 65535,
      tokenizerType: TOKENIZER,
      quotaInfo: { remainingFraction: 1, resetTime: reset },
      model: placeholder,
      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      supportsImages: true,
      supportsVideo: true,
      supportsThinking: true,
      thinkingBudget: 4000,
      minThinkingBudget: 32,
      recommended: index === 0,
      tagTitle: '',
      tagDescription: '',
      modelExperiments: { experiments: {} },
    };
  });

  const first = ids[0] || '';
  const default_agent = config.default_model && models[config.default_model] ? config.default_model : first;
  // tab/mquery/command slots must not be empty: the language server opens a
  // completion or search request against these ids and errors out on a gap.
  const slot = default_agent ? [default_agent] : [];

  const pick = (pattern) => ids.filter((id) => pattern.test(id));
  const pro = pick(/pro/i);
  const flash = pick(/flash/i);

  return {
    models,
    defaultAgentModelId: default_agent,
    agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ids.slice() }] }],
    commandModelIds: slot.slice(),
    tabModelIds: slot.slice(),
    imageGenerationModelIds: [],
    mqueryModelIds: slot.slice(),
    webSearchModelIds: slot.slice(),
    commitMessageModelIds: slot.slice(),
    audioTranscriptionModelIds: [],
    deprecatedModelIds: {},
    experimentIds: [],
    tieredModelIds: {
      flashLite: slot.slice(),
      flash: flash.length ? flash : slot.slice(),
      pro: pro.length ? pro : slot.slice(),
    },
  };
}

/** Resolve a MODEL_PLACEHOLDER_Mxx the language server echoed back at us. */
export function model_from_placeholder(token) {
  if (typeof token !== 'string' || !token) return '';
  return placeholder_index.get(token) || '';
}

/**
 * Real shape is a bucket list, not a scalar daily counter. remainingAmount is a
 * string in the upstream proto, so it stays a string here.
 */
export function retrieve_user_quota(config) {
  const model = (config && config.default_model) || 'agy-bridge';
  return {
    buckets: [
      {
        modelId: model,
        tokenType: 'INPUT',
        remainingAmount: '999999',
        remainingFraction: 1,
        resetTime: '2027-01-01T00:00:00Z',
      },
      {
        modelId: model,
        tokenType: 'OUTPUT',
        remainingAmount: '999999',
        remainingFraction: 1,
        resetTime: '2027-01-01T00:00:00Z',
      },
    ],
  };
}

export function retrieve_user_quota_summary(config) {
  return retrieve_user_quota(config);
}

export function fetch_user_info() {
  return { email: 'dev@antigravity.local', tier: 'PRO', name: 'agy-bridge' };
}

export function list_experiments() {
  return { experiments: [] };
}

export function fetch_admin_controls() {
  return { adminControls: [] };
}

export function list_model_configs(config) {
  return {
    modelConfigs: model_configs(config).map((c) => ({
      modelId: c.modelId,
      displayName: c.displayName,
      tier: c.tier,
      supportsTools: c.supportsTools,
      maxOutputTokens: c.maxOutputTokens,
      maxTokens: c.maxTokens,
    })),
  };
}

/**
 * Pull the model selection out of a setUserSettings write. The LS announces a
 * model switch here instead of putting the model in the next generate request,
 * so this is a real fallback signal — but it is only ever used as a fallback.
 */
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
