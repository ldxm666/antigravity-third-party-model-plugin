(() => {
  if (window.__agyNativeRequests?.version === 1) return;
  const installed = new Map();
  function rewrite(args, models = []) {
    const config = args?.cascadeConfig, planner = config?.plannerConfig;
    if (!planner) return args;
    const names = [planner.modelName, planner.customModelInfoOverride?.modelId, planner.customModelInfoOverride?.modelName];
    const enums = [planner.planModel, planner.requestedModel].filter(v => v !== undefined && v !== null);
    const custom = names.some(v => typeof v === 'string' && v.startsWith('agy-bridge:')) || models.some(m =>
      m.modelId?.startsWith('agy-bridge:') && m.modelOrAlias?.choice?.case === 'model' && enums.includes(m.modelOrAlias.choice.value));
    if (!custom) return args;
    const retry = planner.retryConfig || {};
    return { ...args, cascadeConfig: { ...config, plannerConfig: { ...planner,
      showAllErrors: true,
      retryConfig: { $typeName: 'exa.cortex_pb.PlannerRetryConfig', ...retry,
        // A three-minute provider timeout must not silently become another
        // three-minute attempt. Let the native error UI offer the next action.
        apiRetry: { $typeName: 'exa.cortex_pb.ModelAPIRetryConfig', initialSleepDurationMs: 0, exponentialMultiplier: 0, ...retry.apiRetry, maxRetries: 0 },
      },
    } } };
  }
  function install(client, getModels) {
    if (installed.has(client)) return;
    const bindings = [];
    for (const name of ['startCascade', 'sendUserCascadeMessage']) {
      const original = client[name];
      if (typeof original !== 'function') continue;
      const wrapped = function (args, ...rest) { return original.call(this, rewrite(args, getModels()), ...rest); };
      client[name] = wrapped; bindings.push({ name, original, wrapped });
    }
    installed.set(client, bindings);
  }
  window.__agyNativeRequests = { version: 1, rewrite, install, dispose() {
    for (const [client, bindings] of installed) for (const { name, original, wrapped } of bindings) {
      if (client[name] === wrapped) client[name] = original;
    }
    installed.clear(); delete window.__agyNativeRequests;
  } };
})();
