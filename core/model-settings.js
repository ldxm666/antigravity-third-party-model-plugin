import { count_request_tokens } from './translate.js';

/** Apply the saved per-model limits before translating any provider request. */
export function apply_model_settings(gen, meta, kind) {
  if (!meta) return gen;
  const gc = { ...gen.generation_config };
  const input = count_request_tokens(gen);
  if (input >= meta.ctx) {
    const err = new Error(`请求上下文估算 ${input} tokens，超过此模型配置的 ${meta.ctx} tokens。请缩短会话或增大上下文窗口。`);
    err.status = 400;
    throw err;
  }
  const requested = Number(gc.maxOutputTokens ?? gc.max_output_tokens);
  gc.maxOutputTokens = Math.max(1, Math.min(meta.max_out, meta.ctx - input,
    Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : meta.max_out));
  delete gc.max_output_tokens;
  const effort = meta.reasoning_effort || 'inherit';
  const out = { ...gen, generation_config: gc };
  if (effort === 'inherit') return out;
  delete gc.thinkingConfig; delete gc.thinking_config;
  const budgets = { none: 0, minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768 };
  let budget = effort === 'budget' ? meta.thinking_budget : budgets[effort];
  if (effort === 'budget' && (!Number.isInteger(budget) || budget < 0)) {
    const err = new Error('请为自定义思考预算填写不小于 0 的 token 数。');
    err.status = 400; throw err;
  }
  if (kind === 'openai') {
    out.reasoning_effort = effort === 'budget'
      ? (budget === 0 ? 'none' : budget <= 2048 ? 'low' : budget <= 8192 ? 'medium' : 'high') : effort;
  } else if (kind === 'anthropic') {
    const model = meta.upstream || meta.id;
    const modern = /claude-(?:opus|sonnet)-(?:4[.-](?:[6-9]|\d{2,})|[5-9])/i.test(model);
    const adaptiveOnly = /claude-(?:opus|sonnet)-(?:4[.-](?:[7-9]|\d{2,})|[5-9])/i.test(model);
    if (effort === 'budget' && adaptiveOnly && budget > 0) {
      const err = new Error('此 Claude 模型使用自适应思考，请选择低、中、高或最高强度，而非自定义预算。');
      err.status = 400; throw err;
    }
    if (modern && effort !== 'budget' && effort !== 'none') {
      out.reasoning_effort = effort === 'minimal' ? 'low' : effort;
      out.adaptive_thinking = true;
      return out;
    }
    if (budget > 0 && gc.maxOutputTokens <= 1024) {
      const err = new Error('Anthropic 开启思考时，最大输出长度必须大于 1024 tokens。');
      err.status = 400; throw err;
    }
    out.reasoning_effort = effort;
    out.thinking_budget = budget === 0 ? 0 : Math.min(Math.max(1024, budget), gc.maxOutputTokens - 1);
  } else if (kind === 'gemini') {
    const older = /gemini-2(?:\.|-)/i.test(meta.upstream || meta.id);
    gc.thinkingConfig = effort === 'budget' || effort === 'none' || older
      ? { thinkingBudget: budget }
      : { thinkingLevel: ['xhigh', 'max'].includes(effort) ? 'high' : effort };
  }
  return out;
}
