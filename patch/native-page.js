(() => {
  if (window.__agyProviderUi) return;
  const efforts = { inherit: '跟随应用', none: '关闭思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '最高', max: '最大（Max）', budget: '自定义 token 预算' };
  const kinds = { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini' };
  const S = { root: null, hidden: [], data: null, id: '', draft: null, dirty: false, busy: false, requested: false, active: false, msg: '', error: false };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = v => JSON.parse(JSON.stringify(v));
  function number(v, fallback) {
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    const m = String(v ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
    return m ? Math.round(Number(m[1]) * ({ k: 1000, m: 1000000 }[m[2]?.toLowerCase()] || 1)) : fallback;
  }
  const model = m => {
    const levels = Array.isArray(m?.reasoning_efforts) ? Object.keys(efforts).filter(e => m.reasoning_efforts.includes(e)) : ['inherit'];
    const preferred = levels.includes(m?.reasoning_effort) ? m.reasoning_effort : levels.includes('medium') ? 'medium' : levels[0];
    return { id: m?.id || '', display_name: m?.display_name || m?.displayName || '', upstream: m?.upstream || m?.id || '', ctx: m?.ctx || 128000, max_out: m?.max_out || 8192, reasoning_efforts: levels, reasoning_effort: preferred, thinking_budget: m?.thinking_budget ?? -1, supports_images: m?.supports_images ?? null, config_sources: { ...m?.config_sources } };
  };
  function installEffortSupport() {
    if (window.__agyEffortSupport?.version === 15) return true;
    if (typeof Z5 !== 'function' || typeof RLc !== 'function' || typeof NLc === 'undefined' || typeof Y5 !== 'object') return false;
    const parse = Z5, group = RLc;
    // Extend only bridge labels; retain native parsing for official models.
    Z5 = option => {
      const m = !option.isCustom && /^(.+ · .+) \((Follow App|None|Minimal|Budget)\)$/.exec(option.label || '');
      if (m) return { base: m[1], effort: ({ 'Follow App': 'inherit', None: 'none', Minimal: 'minimal', Budget: 'budget' })[m[2]] };
      return parse(option);
    };
    RLc = (option, index) => {
      const original = group(option, index); if (original) return original;
      const parsed = Z5(option), byEffort = parsed && index.get(parsed.base);
      return parsed?.base.includes(' · ') && byEffort?.size === 1 ? { base: parsed.base, efforts: NLc.filter(e => byEffort.has(e)), byEffort } : original;
    };
    NLc.splice(0, NLc.length, ...Object.keys(efforts));
    Object.assign(Y5, { inherit: '跟随应用', none: '关闭思考', minimal: '最低', budget: '自定义预算' });
    window.__agyEffortSupport = { version: 15 };
    return true;
  }
  async function api(path, method = 'GET', body) {
    const r = await window.agyBridge.api({ path, method, body });
    if (!r || r.status >= 400) throw new Error(r?.data?.detail || r?.data?.error || '本地桥请求失败');
    return r.data;
  }
  function runtime() {
    const el = document.querySelector('#root') || document.body.firstElementChild;
    const key = Object.keys(el || {}).find(k => k.startsWith('__reactContainer'));
    const fiber = key ? el[key] : null;
    const queue = [fiber?.stateNode?.current || fiber], seen = new Set(); let store, client, services;
    while (queue.length && seen.size < 18000) {
      const n = queue.pop(); if (!n || seen.has(n)) continue; seen.add(n);
      const v = n.memoizedProps?.value;
      if (v?.store?.dispatch && v.store.getState) store = v.store;
      if (typeof v?.getUserStatus === 'function') client = v;
      if (v?.core?.cloudCodeService) services = v;
      if (store && client && services) break;
      queue.push(n.sibling, n.child);
    }
    if (!store || !client || !services?.core.cloudCodeService?.getAvailableModels) throw new Error('当前应用版本的模型刷新接口未找到');
    window.__agyNativeRequests?.install(client, () => store.getState().userStatus?.cascadeModelConfigData?.clientModelConfigs || []);
    return { store, client, services };
  }
  async function refreshModels() {
    if (!installEffortSupport()) throw new Error('当前应用版本的思考档位菜单接口未找到');
    const { store, client, services } = runtime();
    await services.core.cloudCodeService.getAvailableModels();
    const r = await client.getUserStatus({});
    if (!r.userStatus?.cascadeModelConfigData) throw new Error('模型列表尚未就绪，请稍后再试');
    // Use the native protobuf result and native Redux action. The conversation
    // and its input editor remain mounted throughout the refresh.
    store.dispatch({ type: 'userStatus/setUserStatus', payload: r.userStatus });
    if (services && typeof m3c !== 'undefined' && typeof m3c.delete === 'function') m3c.delete(services.core.cloudCodeService);
    return r.userStatus.cascadeModelConfigData.clientModelConfigs?.length || 0;
  }
  function status(text, error = false) {
    S.msg = text; S.error = error;
    const el = S.root?.querySelector('[data-agy-status]');
    if (el) { el.textContent = text; el.setAttribute('role', error ? 'alert' : 'status'); el.dataset.error = String(error); }
  }
  function choose(id) {
    S.id = id; const p = S.data?.providers.find(p => p.id === id);
    S.draft = p ? { ...clone(p), api_key: '' } : { name: '', kind: 'openai', base_url: '', api_key: '', models: [] };
    S.draft.models = S.draft.models.map(model); S.dirty = false;
  }
  async function load(select = S.id) {
    const data = await api('/api/state');
    const [major, minor] = String(data.version || '0.0').split('.').map(Number);
    if (!(major > 1 || major === 1 && minor >= 5)) { S.data = null; throw new Error('后台桥仍为 ' + (data.version || '旧版本') + '。请运行项目目录中的 restart-bridge.cmd 重启本地桥，然后点击“重试”；不需要退出 Antigravity。'); }
    S.data = data;
    choose(select && S.data.providers.some(p => p.id === select) ? select : S.data.active_provider_id || S.data.providers[0]?.id || ''); render();
  }
  const options = (values, selected) => Object.entries(values).map(([v, label]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const field = (label, key, value, extra = '') => `<label class="agy-field"><span>${label}</span><input data-field="${key}" value="${esc(value)}" ${extra}></label>`;
  function modelRow(m, i) {
    const source = key => { const value = m.config_sources?.[key]; return value?.startsWith('endpoint:') ? '端点返回' : value?.startsWith('table:') ? '能力表 · ' + value.slice(6) : value === 'manual' ? '手动设置' : '保留原值 / 未识别'; };
    return `<fieldset class="agy-model" data-model-index="${i}"><legend>模型 ${i + 1}</legend><div class="agy-grid">
      ${field('模型 ID', 'id', m.id, 'required spellcheck="false"')}${field('显示名称', 'display_name', m.display_name)}
      ${field('上游模型名', 'upstream', m.upstream, 'spellcheck="false"')}<button class="agy-action agy-remove" type="button" data-action="remove-model" data-index="${i}" aria-label="删除模型 ${i + 1}">删除模型</button>
      ${field('上下文窗口 · tokens', 'ctx', m.ctx, 'inputmode="numeric" placeholder="128K 或 1M"')}${field('最大输出 · tokens', 'max_out', m.max_out, 'inputmode="numeric" placeholder="8192"')}
      <fieldset class="agy-wide agy-effort-options"><legend>聊天中可选的思考强度 · 可多选</legend><div>${Object.entries(efforts).map(([value, label]) => `<label><input type="checkbox" data-effort-choice="${value}" ${m.reasoning_efforts.includes(value) ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('')}</div></fieldset>
      <label class="agy-field"><span>默认思考强度</span><select data-field="reasoning_effort">${options(Object.fromEntries(Object.entries(efforts).filter(([e]) => m.reasoning_efforts.includes(e))), m.reasoning_effort)}</select></label>
      ${field('思考预算 · tokens', 'thinking_budget', m.thinking_budget >= 0 ? m.thinking_budget : '', `inputmode="numeric" placeholder="例如 4096" ${!m.reasoning_efforts.includes('budget') ? 'disabled' : ''}`)}
      <label class="agy-image-option agy-wide"><input type="checkbox" data-field="supports_images" ${m.supports_images === true ? 'checked' : ''}><span>支持图片输入${m.supports_images === null ? '（未识别，可手动设置）' : ''}</span></label>
      <p class="agy-source agy-wide">窗口：${esc(source('ctx'))}；输出：${esc(source('max_out'))}；图片：${esc(source('supports_images'))}；档位：${esc(source('reasoning_efforts'))}</p>
    </div></fieldset>`;
  }
  function render() {
    if (!S.root) return;
    const d = S.draft, active = S.data?.active_provider_id === S.id;
    S.root.innerHTML = `<div class="agy-page"><div class="agy-heading"><div><h2>模型提供商</h2><p>连接第三方模型 API，并按模型配置思考和容量。</p></div><button type="button" class="agy-action" data-action="refresh">刷新模型列表</button></div>
      <div data-agy-status role="status" data-error="${S.error}">${esc(S.msg)}</div>
      <div class="agy-provider-picker"><label class="agy-field"><span>提供商</span><select data-provider-select>${S.data?.providers.map(p => `<option value="${esc(p.id)}"${p.id === S.id ? ' selected' : ''}>${esc(p.name)}${p.id === S.data.active_provider_id ? ' · 默认' : ''}</option>`).join('') || ''}${S.id ? '' : '<option value="" selected>新提供商</option>'}</select></label><button type="button" class="agy-action" data-action="new">添加提供商</button></div>
      ${d ? `<form data-agy-form><div class="agy-grid">${field('提供商名称', 'name', d.name, 'required placeholder="例如 我的 API"')}
        <label class="agy-field"><span>接口协议</span><select data-field="kind">${options(kinds, d.kind)}</select></label>
        <div class="agy-wide">${field('API 地址', 'base_url', d.base_url, 'type="url" placeholder="https://example.com/v1" spellcheck="false"')}</div>
        <div class="agy-wide">${field('API Key', 'api_key', d.api_key, `type="password" autocomplete="off" placeholder="${S.id ? '已保存的密钥保持不变；输入新密钥可替换' : '输入提供商密钥（本地服务可留空）'}"`)}</div>
      </div><div class="agy-subheading"><h3>模型</h3><button type="button" class="agy-action" data-action="add-model">添加模型</button></div>
      <div data-agy-models>${d.models.length ? d.models.map(modelRow).join('') : '<p>添加模型，或从已保存的提供商获取可用模型。</p>'}</div>
      <p class="agy-help">聊天菜单仅显示上面勾选的档位，默认值也从已选档位中选择。容量支持 K、M 或整数，单位为 tokens。自动配置优先读取端点容量与能力，缺失项按已知模型能力表补齐；未识别项保留原值。上下文按文本估算，实际能力以提供商为准。</p>
      <div class="agy-actions"><div><button type="button" class="agy-action" data-action="fetch">获取可用模型</button><button type="button" class="agy-action" data-action="configure" title="为列表中每个模型从端点读取上限，并按模型能力表补齐图片与思考档位；仅更新草稿">自动配置所有模型</button><button type="button" class="agy-action" data-action="test">测试连接</button></div><div><button type="button" class="agy-action" data-action="cancel">还原</button><button type="submit" class="agy-action agy-primary">保存</button></div></div>
      ${S.id ? `<div class="agy-default"><label class="agy-field"><span>默认模型</span><select data-default-model>${d.models.map(m => `<option value="${esc(m.id)}"${m.id === S.data.default_model ? ' selected' : ''}>${esc(m.display_name || m.id)}</option>`).join('')}</select></label><button type="button" class="agy-action" data-action="activate">${active ? '更新默认模型' : '设为默认提供商'}</button><button type="button" class="agy-action agy-danger" data-action="delete">删除提供商</button></div>` : ''}</form>` : '<p>正在读取本地桥配置…</p>'}</div>`;
    setBusy(S.busy);
  }
  function setBusy(busy) {
    S.busy = busy;
    S.root?.querySelectorAll('button').forEach(b => { b.disabled = busy; });
    S.root?.querySelector('form')?.setAttribute('aria-busy', String(busy));
  }
  function validate() {
    const d = S.draft;
    if (!d.name.trim()) throw new Error('请填写提供商名称');
    if (d.base_url && !/^https?:\/\//i.test(d.base_url)) throw new Error('API 地址必须使用 HTTP 或 HTTPS');
    const ids = new Set();
    for (const m of d.models) {
      m.id = m.id.trim(); if (!m.id || ids.has(m.id)) throw new Error('模型 ID 不能为空或重复'); ids.add(m.id);
      m.ctx = number(m.ctx, 0); m.max_out = number(m.max_out, 0); m.thinking_budget = number(m.thinking_budget, -1);
      if (m.ctx < 1 || m.ctx > 100000000 || m.max_out < 1 || m.max_out > 10000000) throw new Error('请填写有效的上下文窗口和最大输出容量');
      if (m.max_out >= m.ctx) throw new Error('最大输出必须小于上下文窗口，为输入、历史消息和智能体指令预留空间。');
      if (!m.reasoning_efforts.length) throw new Error('每个模型至少选择一个可用思考档位，可选择“跟随应用”。');
      if (!m.reasoning_efforts.includes(m.reasoning_effort)) throw new Error('默认思考强度必须是已勾选的档位。');
      if (m.reasoning_efforts.includes('budget') && (m.thinking_budget < 0 || m.thinking_budget > 1000000)) throw new Error('思考预算必须在 0 到 1000000 tokens 之间');
      m.display_name = m.display_name.trim() || m.id; m.upstream = m.upstream.trim() || m.id;
    }
  }
  function selectFetchedModels(rows) {
    const existing = new Set(S.draft.models.map(m => m.id));
    const unique = [...new Map(rows.map(m => [m.id, m])).values()];
    const selected = new Set();
    return new Promise(resolve => {
      const dialog = document.createElement('dialog'); dialog.className = 'agy-model-picker';
      dialog.setAttribute('aria-labelledby', 'agy-picker-title'); dialog.dataset.testid = 'agy-bridge-model-picker';
      const panel = S.root.closest('.settings-modal-container');
      dialog.style.backgroundColor = getComputedStyle(panel).backgroundColor;
      dialog.style.color = getComputedStyle(panel).color;
      dialog.innerHTML = `<h3 id="agy-picker-title">选择要添加的模型</h3><p class="agy-picker-help">仅将勾选的模型加入草稿，保存后才会出现在对话菜单中。</p>
        <label class="agy-field"><span>搜索模型</span><input type="search" data-picker-search placeholder="输入模型名称或 ID" autocomplete="off"></label>
        <div class="agy-picker-toolbar"><button type="button" class="agy-action" data-picker-all>全选可见项</button><button type="button" class="agy-action" data-picker-none>取消选择</button><span data-picker-count role="status"></span></div>
        <div class="agy-picker-list" data-picker-list></div>
        <div class="agy-picker-footer"><button type="button" class="agy-action" data-picker-cancel>取消</button><button type="button" class="agy-action agy-primary" data-picker-add disabled>添加所选（0）</button></div>`;
      let done = false;
      const finish = values => {
        if (done) return; done = true; S.pickerCancel = null;
        dialog.close(); dialog.remove(); resolve(values);
      };
      S.pickerCancel = () => finish([]);
      const visible = () => { const term = dialog.querySelector('[data-picker-search]').value.toLowerCase(); return unique.filter(m => (m.id + ' ' + (m.display_name || '')).toLowerCase().includes(term)); };
      const count = () => {
        dialog.querySelector('[data-picker-count]').textContent = `共 ${unique.length} 个 · 已选择 ${selected.size} 个`;
        const add = dialog.querySelector('[data-picker-add]'); add.textContent = `添加所选（${selected.size}）`; add.disabled = selected.size === 0;
      };
      const renderRows = () => {
        const list = visible();
        dialog.querySelector('[data-picker-list]').innerHTML = list.length ? list.map(m => `<label class="agy-picker-row"><input type="checkbox" data-picker-id="${esc(m.id)}" ${existing.has(m.id) ? 'checked disabled' : selected.has(m.id) ? 'checked' : ''}><span><span>${esc(m.display_name || m.id)}</span>${m.display_name && m.display_name !== m.id ? `<small>${esc(m.id)}</small>` : ''}</span>${existing.has(m.id) ? '<small>已添加</small>' : ''}</label>`).join('') : '<p class="agy-picker-help">没有匹配的模型</p>';
        count();
      };
      dialog.querySelector('[data-picker-search]').oninput = renderRows;
      dialog.addEventListener('change', e => { const id = e.target.dataset.pickerId; if (id) { if (e.target.checked) selected.add(id); else selected.delete(id); count(); } });
      dialog.querySelector('[data-picker-all]').onclick = () => { for (const m of visible()) if (!existing.has(m.id)) selected.add(m.id); renderRows(); };
      dialog.querySelector('[data-picker-none]').onclick = () => { selected.clear(); renderRows(); };
      dialog.querySelector('[data-picker-cancel]').onclick = () => finish([]);
      dialog.querySelector('[data-picker-add]').onclick = () => finish(unique.filter(m => selected.has(m.id)));
      dialog.addEventListener('cancel', e => { e.preventDefault(); e.stopPropagation(); finish([]); });
      dialog.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); });
      S.root.append(dialog); renderRows(); dialog.showModal(); dialog.querySelector('[data-picker-search]').focus();
    });
  }
  async function savedRefresh(message = '已保存') {
    status(message + '，正在刷新应用模型…');
    try { const count = await refreshModels(); status(`${message}，模型菜单已刷新（${count} 个模型），无需重启`); }
    catch (e) { status(message + '；模型刷新失败：' + e.message + '。可以点击“刷新模型列表”重试。', true); }
  }
  async function save(e) {
    e.preventDefault(); if (S.busy) return;
    try {
      validate(); setBusy(true); status('正在保存…');
      const payload = clone(S.draft);
      if (S.id && !payload.api_key.trim()) delete payload.api_key;
      const r = await api(S.id ? '/api/providers/' + encodeURIComponent(S.id) : '/api/providers', S.id ? 'PATCH' : 'POST', payload);
      await load(r.provider?.id || S.id); await savedRefresh();
    } catch (e) { status(e.message, true); } finally { setBusy(false); }
  }
  async function action(name, button) {
    if (S.busy) return;
    if (['new', 'cancel'].includes(name)) {
      if (S.dirty && !confirm('放弃尚未保存的修改？')) return;
      if (name === 'cancel' && !S.data) { void mount(true); return; }
      choose(name === 'new' ? '' : S.id); S.msg = ''; render(); return;
    }
    if (name === 'add-model') { S.draft.models.push(model()); S.dirty = true; render(); return; }
    if (name === 'remove-model') { S.draft.models.splice(Number(button.dataset.index), 1); S.dirty = true; render(); return; }
    try {
      setBusy(true);
      if (name === 'refresh') await savedRefresh('配置未更改');
      if (name === 'configure') {
        if (!S.draft.models.length) throw new Error('请先选择或添加模型，再自动配置。');
        status('正在读取模型端点配置并匹配能力表…');
        const r = await api('/api/providers/preview', 'POST', { ...S.draft, id: S.id, operation: 'configure-models' });
        if (!r.ok) throw new Error(r.detail || '自动配置失败');
        S.draft.models = r.models.map(model); S.dirty = true; render();
        status(r.detail + (r.warnings?.length ? '\n' + r.warnings.join('\n') : '') + '\n已更新草稿，检查后点击“保存”生效。');
      }
      if (name === 'test') { status('正在测试当前填写的提供商…'); const r = await api('/api/providers/preview', 'POST', { ...S.draft, id: S.id, operation: 'test' }); status(r.ok ? `连接正常 · ${r.latency_ms} ms` : r.detail || '连接失败', !r.ok); }
      if (name === 'fetch') {
        status('正在从当前填写的提供商获取模型…');
        const r = await api('/api/providers/preview', 'POST', { ...S.draft, id: S.id, operation: 'fetch-models' });
        if (!r.ok) throw new Error(r.detail || '提供商未返回模型列表');
        if (!r.models.length) { status('提供商返回了空模型列表'); return; }
        const chosen = await selectFetchedModels(r.models);
        if (!chosen.length) { status('未添加模型'); return; }
        for (const m of chosen) S.draft.models.push(model(m));
        S.dirty = true; render(); status(`已将 ${chosen.length} 个所选模型加入草稿。点击保存后加入应用模型菜单。`);
      }
      if (name === 'activate') { if (S.dirty) throw new Error('请先保存模型修改，再设置默认模型'); const selected = S.root.querySelector('[data-default-model]').value; await api('/api/active', 'POST', { active_provider_id: S.id, default_model: selected }); await load(); await savedRefresh('已更新默认模型'); }
      if (name === 'delete' && confirm('删除此提供商及其自动模型映射？')) { await api('/api/providers/' + encodeURIComponent(S.id), 'DELETE'); await load(''); await savedRefresh('已删除'); }
    } catch (e) { status(e.message, true); } finally { setBusy(false); }
  }
  function input(e) {
    if (e.target.dataset.effortChoice) {
      const row = e.target.closest('[data-model-index]'), m = S.draft.models[Number(row.dataset.modelIndex)];
      m.reasoning_efforts = Object.keys(efforts).filter(level => row.querySelector(`[data-effort-choice="${level}"]`).checked);
      if (!m.reasoning_efforts.includes(m.reasoning_effort)) m.reasoning_effort = m.reasoning_efforts.includes('medium') ? 'medium' : m.reasoning_efforts[0] || '';
      row.querySelector('[data-field=reasoning_effort]').innerHTML = options(Object.fromEntries(Object.entries(efforts).filter(([level]) => m.reasoning_efforts.includes(level))), m.reasoning_effort);
      row.querySelector('[data-field=thinking_budget]').disabled = !m.reasoning_efforts.includes('budget');
      m.config_sources.reasoning_efforts = 'manual'; S.dirty = true; return;
    }
    const key = e.target.dataset.field; if (!key || !S.draft) return;
    const index = e.target.closest('[data-model-index]')?.dataset.modelIndex;
    const obj = index === undefined ? S.draft : S.draft.models[Number(index)]; obj[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; S.dirty = true;
    if (index !== undefined && ['ctx', 'max_out', 'supports_images'].includes(key)) obj.config_sources[key] = 'manual';
  }
  function restore() {
    S.pickerCancel?.();
    for (const [el, display] of S.hidden) el.style.display = display;
    S.hidden = []; S.root?.remove(); S.root = null;
    document.querySelector('.settings-modal-container')?.classList.remove('agy-provider-active');
    document.querySelector('[data-testid=agy-bridge-provider-settings]')?.removeAttribute('aria-current');
  }
  async function mount(force = false) {
    const nav = document.querySelector('[data-testid=settings-nav-item-Models]');
    const column = nav?.closest('[data-split-root]')?.children[1]; if (!column) return;
    S.requested = false; if (S.root?.isConnected && !force) return;
    restore();
    for (const el of [...column.children]) { S.hidden.push([el, el.style.display]); el.style.display = 'none'; }
    S.root = document.createElement('section'); S.root.dataset.testid = 'agy-bridge-native-providers'; S.root.className = 'agy-provider-content'; S.root.setAttribute('aria-label', '模型提供商');
    S.root.addEventListener('input', input); S.root.addEventListener('change', e => {
      input(e); if (e.target.matches('[data-provider-select]')) {
        if (S.dirty && !confirm('放弃尚未保存的修改？')) { e.target.value = S.id; return; }
        choose(e.target.value); S.msg = ''; render();
      }
    });
    S.root.addEventListener('submit', save); S.root.addEventListener('click', e => { const b = e.target.closest('button[data-action]'); if (b) void action(b.dataset.action, b); });
    column.append(S.root); nav.closest('.settings-modal-container')?.classList.add('agy-provider-active');
    document.querySelector('[data-testid=agy-bridge-provider-settings]')?.setAttribute('aria-current', 'page');
    S.root.innerHTML = '<div class="agy-page">正在读取本地桥配置…</div>';
    try { await load(); } catch (e) { if (!S.root) return; S.root.innerHTML = '<div class="agy-page"><h2>模型提供商</h2><div data-agy-status role="alert"></div><button type="button" class="agy-action" data-action="cancel">重试</button></div>'; status(e.message, true); }
  }
  function open() {
    const picker = document.querySelector('[data-testid=model-selector-trigger]');
    if (picker?.getAttribute('aria-expanded') === 'true') picker.click();
    S.requested = true; S.active = true;
    if (!document.querySelector('[data-testid=settings-sidebar]')) document.querySelector('[data-testid=settings-button]')?.click();
    if (document.querySelector('[data-testid=settings-sidebar]')) void mount();
  }
  const style = document.createElement('style');
  style.textContent = `
    .agy-provider-content{position:absolute;inset:0;overflow:auto;color:inherit;background:inherit;font-size:14px;color-scheme:inherit}
    .agy-page{padding:24px;max-width:780px;margin:auto;padding-bottom:40px}.agy-page h2{font-size:24px;font-weight:500;margin:0 0 6px}.agy-page h3{font-size:15px;font-weight:500;margin:0}.agy-page p{margin:4px 0;opacity:.7}
    .agy-heading{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding-right:24px}.agy-provider-picker,.agy-default{display:flex;gap:12px;align-items:flex-end;margin:20px 0}.agy-provider-picker>label{flex:1}.agy-default{border-top:1px solid #8884;padding-top:18px;flex-wrap:wrap}.agy-default>label{flex:1;min-width:160px}
    .agy-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.agy-wide{grid-column:1/-1}.agy-field{display:flex;flex-direction:column;gap:6px;min-width:0}.agy-field>span{font-size:12px;opacity:.72}
    .agy-field input,.agy-field select{width:100%;box-sizing:border-box;min-width:0;min-height:34px;border:1px solid #8885;border-radius:7px;padding:6px 9px;background:transparent;color:inherit;font:inherit;outline-offset:2px}.agy-field input:focus-visible,.agy-field select:focus-visible{outline:2px solid currentColor}.agy-field select option{background:Canvas;color:CanvasText}.agy-field input:disabled{opacity:.45}
    .agy-action{box-sizing:border-box;border:1px solid #8885;border-radius:7px;padding:7px 10px;font:inherit;font-size:13px;line-height:18px;color:inherit;background:transparent;cursor:pointer;white-space:nowrap}.agy-action:hover{background:#8882}.agy-action:disabled{opacity:.45;cursor:default}.agy-primary{background:#8882;font-weight:600}.agy-danger{color:#d86060}.agy-remove{align-self:end}
    .agy-subheading{display:flex;justify-content:space-between;align-items:center;margin:24px 0 12px}.agy-model{border:1px solid #8884;border-radius:9px;margin:0 0 16px;padding:14px}.agy-model legend{font-size:12px;opacity:.7;padding:0 4px}.agy-help{font-size:12px;line-height:1.7}
    .agy-actions{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:18px}.agy-actions>div{display:flex;gap:8px;flex-wrap:wrap}[data-agy-status]{font-size:12px;line-height:1.6;margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere}[data-agy-status]:empty{display:none}[data-agy-status][data-error=true]{color:#d86060}
    .agy-provider-active [data-testid^=settings-nav-item-]{background:transparent!important}.agy-provider-active [data-testid=agy-bridge-provider-settings]{background:var(--sidebar-secondary,#8882)}
    .agy-model-picker{box-sizing:border-box;position:fixed;inset:0;margin:auto;height:fit-content;width:min(600px,calc(100vw - 48px));max-height:min(720px,80vh);border:1px solid #8885;border-radius:12px;padding:22px;color:inherit;font:inherit;overflow:auto;box-shadow:0 16px 48px #0003}.agy-model-picker::backdrop{background:#0006}.agy-model-picker h3{font-size:18px;font-weight:500;margin:0 0 8px}.agy-picker-help{font-size:12px;line-height:1.7;opacity:.7;margin:6px 0 18px}.agy-picker-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.agy-picker-toolbar>span{font-size:12px;opacity:.7;margin-left:auto}.agy-picker-list{max-height:360px;overflow:auto;border:1px solid #8884;border-radius:8px}.agy-picker-row{display:flex;align-items:center;gap:10px;padding:12px;cursor:pointer;border-bottom:1px solid #8883}.agy-picker-row:last-child{border-bottom:0}.agy-picker-row>input{width:16px;height:16px;flex-shrink:0}.agy-picker-row>span{display:flex;flex:1;min-width:0;flex-direction:column;overflow-wrap:anywhere}.agy-picker-row small{font-size:12px;opacity:.65}.agy-picker-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
    .agy-effort-options{border:0;padding:0;margin:4px 0 0;min-width:0}.agy-effort-options>legend{font-size:12px;opacity:.72;margin-bottom:8px;padding:0}.agy-effort-options>div{display:flex;gap:10px 18px;flex-wrap:wrap}.agy-effort-options label,.agy-image-option{display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer}.agy-effort-options input,.agy-image-option input{width:15px;height:15px;accent-color:currentColor}.agy-page p.agy-source{font-size:11px;line-height:1.7;opacity:.6;overflow-wrap:anywhere}.agy-effort-options label:focus-within{outline:1px solid currentColor;outline-offset:3px;border-radius:2px}
    @media(max-width:700px){.agy-grid{grid-template-columns:minmax(0,1fr)}.agy-page{padding:18px}.agy-heading{flex-direction:column}.agy-wide{grid-column:auto}}
  `;
  document.head.append(style);
  let queued = false;
  function update() {
    queued = false;
    installEffortSupport();
    const nav = document.querySelector('[data-testid=settings-nav-item-Models]');
    if (nav && !document.querySelector('[data-testid=agy-bridge-provider-settings]')) {
      const wrapper = document.createElement('div'); wrapper.className = nav.parentElement.className;
      const b = document.createElement('button'); b.type = 'button'; b.dataset.testid = 'agy-bridge-provider-settings'; b.className = nav.className; b.textContent = '模型提供商';
      wrapper.append(b); nav.parentElement.after(wrapper);
    }
    const providerButton = document.querySelector('[data-testid=agy-bridge-provider-settings]');
    if (providerButton && providerButton.dataset.agyNative !== '15') { providerButton.dataset.agyNative = '15'; providerButton.onclick = () => open(); }
    const sidebar = nav?.closest('[data-testid=settings-sidebar]');
    if (sidebar && sidebar.dataset.agyNative !== '15') {
      sidebar.dataset.agyNative = '15';
      sidebar.addEventListener('click', e => { if (e.target.closest('[data-testid^=settings-nav-item-]')) { S.requested = false; S.active = false; restore(); } }, true);
    }
    const item = document.querySelector('[data-testid=model-selector-item]'), menu = item?.closest('[role=menu]');
    if (menu && !menu.querySelector('[data-testid=agy-bridge-manage-models]')) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.testid = 'agy-bridge-manage-models'; b.className = item.className; b.textContent = '管理第三方模型…'; b.setAttribute('role', 'menuitem');
      b.style.cssText = 'width:100%;text-align:left;border-top:1px solid #8884;margin-top:6px;padding-top:10px';
      b.onclick = e => { e.preventDefault(); e.stopPropagation(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); setTimeout(open, 30); }; menu.append(b);
    }
    if (S.root && !S.root.isConnected) { S.pickerCancel?.(); S.root = null; S.hidden = []; }
    if ((S.requested || S.active && !S.root) && nav) void mount();
    else if (!nav && !S.requested) S.active = false;
  }
  let policyTimer, policyAttempts = 0;
  function installRequestPolicy() {
    try { runtime(); }
    catch (err) {
      if (++policyAttempts < 60) policyTimer = setTimeout(installRequestPolicy, 500);
      else console.warn('[agy-bridge] native request policy unavailable:', err.message);
    }
  }
  installRequestPolicy();
  const observer = new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(update); } });
  observer.observe(document.body, { childList: true, subtree: true }); update();
  window.__agyProviderUi = { open, refreshModels, restore, dispose() { observer.disconnect(); clearTimeout(policyTimer); window.__agyNativeRequests?.dispose(); S.active = false; restore(); style.remove(); document.querySelector('[data-testid=agy-bridge-provider-settings]')?.parentElement.remove(); document.querySelector('[data-testid=agy-bridge-manage-models]')?.remove(); delete window.__agyProviderUi; }, get mounted() { return !!S.root?.isConnected; } };
})();
