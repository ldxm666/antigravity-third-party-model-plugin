// Shared configuration rules. Explicit effort lists are authoritative.
export const EFFORT_KEYS = ['inherit', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'budget'];
export function clean_efforts(value) {
  return Array.isArray(value) ? EFFORT_KEYS.filter(k => value.includes(k)) : [];
}
export function model_efforts(meta = {}) {
  if (Array.isArray(meta.reasoning_efforts)) return clean_efforts(meta.reasoning_efforts).length ? clean_efforts(meta.reasoning_efforts) : ['inherit'];
  // Migrate the previous release without silently changing its menu choices.
  const supports = /gemini|claude|deepseek|reason|gpt[- ]?[56]|(?:^|\/)o[134](?:-|$)/i.test(meta.upstream || meta.id || '');
  const levels = supports ? ['low', 'medium', 'high'] : ['inherit'];
  const configured = EFFORT_KEYS.includes(meta.reasoning_effort) ? meta.reasoning_effort : 'inherit';
  if (!levels.includes(configured)) levels.unshift(configured);
  return levels;
}
export function default_effort(meta, levels = model_efforts(meta)) {
  return levels.includes(meta.reasoning_effort) ? meta.reasoning_effort : levels.includes('medium') ? 'medium' : levels[0];
}
