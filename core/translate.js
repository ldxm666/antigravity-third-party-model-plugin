// language: JavaScript (ESM), file: translate.js, target: Node 24, deps: node: builtins only
//
// Bidirectional translation between the Cloud Code Assist (Gemini v1internal)
// shape and the three upstream dialects we support.
//
// Internal contract: provider adapters never build Gemini JSON themselves. They
// emit canonical deltas, and chunk_for_delta() turns those into the exact
// GenerateContentResponse frames the language server expects.
//
//   { kind: 'text',      text }
//   { kind: 'thought',   text }
//   { kind: 'tool_call', id, name, args }
//   { kind: 'gemini_part', part }           // Preserve native signatures and IDs.
//   { kind: 'finish',    reason }            // Gemini enum: STOP / MAX_TOKENS / ...
//   { kind: 'usage',     prompt, candidates, total }

export const DEFAULT_MAX_OUTPUT = 8192;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const STATUS_BY_CODE = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  408: 'DEADLINE_EXCEEDED',
  409: 'ABORTED',
  413: 'INVALID_ARGUMENT',
  422: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  499: 'CANCELLED',
  500: 'INTERNAL',
  501: 'UNIMPLEMENTED',
  502: 'UNAVAILABLE',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

export function google_status_for(code) {
  return STATUS_BY_CODE[Number(code)] || (Number(code) >= 500 ? 'INTERNAL' : 'UNKNOWN');
}

/** The shape the LS renders in its UI as a human-readable failure. */
export function gemini_error(code, message, status) {
  const numeric = Number.isFinite(Number(code)) ? Number(code) : 500;
  return {
    error: {
      code: numeric,
      message: String(message || 'bridge error'),
      status: status || google_status_for(numeric),
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function estimate_tokens(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

export function text_of_parts(parts) {
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const part of parts) {
    if (part && typeof part.text === 'string' && !part.thought) out += part.text;
  }
  return out;
}

export function text_of_system_instruction(si) {
  if (!si) return '';
  if (typeof si === 'string') return si;
  if (Array.isArray(si.parts)) return text_of_parts(si.parts);
  if (typeof si.text === 'string') return si.text;
  if (typeof si.content === 'string') return si.content;
  return '';
}

export function parse_json_loose(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

function clamp_number(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/**
 * Gemini's Schema is an OpenAPI subset with upper-case type names and a few
 * fields JSON Schema rejects. Normalise recursively; never throw.
 */
export function sanitize_schema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitize_schema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'propertyOrdering') continue;
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toLowerCase();
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object') {
      const props = {};
      for (const [name, sub] of Object.entries(value)) props[name] = sanitize_schema(sub);
      out.properties = props;
      continue;
    }
    if (key === 'items') {
      out.items = sanitize_schema(value);
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      out[key] = value.map(sanitize_schema);
      continue;
    }
    out[key] = value;
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

// ---------------------------------------------------------------------------
// Request normalisation (defensive: the model id can hide in several places)
// ---------------------------------------------------------------------------

function model_token(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    for (const key of ['name', 'model', 'modelId', 'model_id', 'id']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
  }
  return '';
}

/**
 * Flatten every request shape we have seen into one internal object.
 *
 * Envelope:  { model, project, request: { contents, ... } }
 * Flat:      { model, contents, ... }
 * Nested:    { model, request: {...}, generationConfig: { model } }
 */
export function normalize_request(raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const has_envelope = body.request && typeof body.request === 'object' && !Array.isArray(body.request);
  const inner = has_envelope ? body.request : body;
  const body_keys = Object.keys(body).slice(0, 15);

  const probes = {
    body_model: model_token(body.model),
    request_model: model_token(inner.model),
    body_generation_config_model: model_token(body.generationConfig && body.generationConfig.model),
    request_generation_config_model: model_token(inner.generationConfig && inner.generationConfig.model),
    body_model_id: model_token(body.modelId || body.model_id),
    request_model_id: model_token(inner.modelId || inner.model_id),
  };
  // Real capture: the GenerateContentRequest lives under `request`, and the
  // model id lives at `request.model`. body.model is the flat-shape fallback.
  let model = '';
  for (const key of [
    'request_model',
    'body_model',
    'request_generation_config_model',
    'body_generation_config_model',
    'request_model_id',
    'body_model_id',
  ]) {
    if (probes[key]) {
      model = probes[key];
      break;
    }
  }

  const contents = Array.isArray(inner.contents)
    ? inner.contents
    : Array.isArray(body.contents)
      ? body.contents
      : [];

  const generation_config = { ...(inner.generationConfig && typeof inner.generationConfig === 'object' ? inner.generationConfig : {}) };
  // generationConfig.model is not part of the v1beta GenerateContentRequest and
  // makes strict backends 400. It was only ever a probe source.
  delete generation_config.model;

  return {
    model,
    model_probes: probes,
    project: typeof body.project === 'string' ? body.project : typeof inner.project === 'string' ? inner.project : '',
    user_agent: typeof body.userAgent === 'string' ? body.userAgent : '',
    request_id: typeof body.requestId === 'string' ? body.requestId : '',
    session_id: typeof body.sessionId === 'string' ? body.sessionId : '',
    labels: body.labels && typeof body.labels === 'object' ? body.labels : undefined,
    contents,
    system_instruction: inner.systemInstruction || inner.system_instruction || null,
    tools: Array.isArray(inner.tools) ? inner.tools : [],
    tool_config: inner.toolConfig || inner.tool_config || null,
    generation_config,
    safety_settings: Array.isArray(inner.safetySettings) ? inner.safetySettings : [],
    envelope: has_envelope,
    body_keys,
    inner,
  };
}

/** Pull function declarations out of either Gemini or OpenAI-ish tool arrays. */
export function collect_function_declarations(tools) {
  const out = [];
  if (!Array.isArray(tools)) return out;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (Array.isArray(tool.functionDeclarations)) {
      for (const decl of tool.functionDeclarations) if (decl && typeof decl === 'object') out.push(decl);
    } else if (Array.isArray(tool.function_declarations)) {
      for (const decl of tool.function_declarations) if (decl && typeof decl === 'object') out.push(decl);
    } else if (tool.function && typeof tool.function === 'object') {
      out.push(tool.function);
    } else if (tool.name && (tool.parameters || tool.input_schema)) {
      out.push(tool);
    }
  }
  return out;
}

function tool_choice_from_gemini(tool_config, dialect) {
  if (!tool_config || typeof tool_config !== 'object') return undefined;
  const cfg = tool_config.functionCallingConfig || tool_config.function_calling_config || tool_config;
  const mode = String(cfg.mode || '').toUpperCase();
  const allowed = Array.isArray(cfg.allowedFunctionNames) ? cfg.allowedFunctionNames.filter((n) => typeof n === 'string') : [];
  if (dialect === 'openai') {
    if (mode === 'NONE') return 'none';
    if (mode === 'ANY') {
      if (allowed.length === 1) return { type: 'function', function: { name: allowed[0] } };
      return 'required';
    }
    if (mode === 'AUTO') return 'auto';
    return undefined;
  }
  if (mode === 'NONE') return { type: 'none' };
  if (mode === 'ANY') {
    if (allowed.length === 1) return { type: 'tool', name: allowed[0] };
    return { type: 'any' };
  }
  if (mode === 'AUTO') return { type: 'auto' };
  return undefined;
}

function reasoning_effort_from_gemini(thinking_config) {
  if (!thinking_config || typeof thinking_config !== 'object') return undefined;
  const level = String(thinking_config.thinkingLevel || thinking_config.thinking_level || '').toLowerCase();
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) return level;
  const budget = Number(thinking_config.thinkingBudget ?? thinking_config.thinking_budget);
  if (!Number.isFinite(budget) || budget <= 0) return undefined;
  if (budget <= 2048) return 'low';
  if (budget <= 16384) return 'medium';
  return 'high';
}

function merge_message(messages, message) {
  const prev = messages[messages.length - 1];
  if (
    prev &&
    prev.role === message.role &&
    typeof prev.content === 'string' &&
    typeof message.content === 'string' &&
    (prev.role === 'user' || prev.role === 'assistant') &&
    !prev.tool_calls &&
    !message.tool_calls
  ) {
    prev.content = `${prev.content}\n\n${message.content}`;
    return;
  }
  messages.push(message);
}

// ---------------------------------------------------------------------------
// Gemini request -> OpenAI chat/completions
// ---------------------------------------------------------------------------

export function to_openai_request(gen, opts = {}) {
  const messages = [];
  const system = text_of_system_instruction(gen.system_instruction);
  if (system) messages.push({ role: 'system', content: system });

  const id_by_name = new Map();
  let auto_id = 0;

  for (const turn of gen.contents) {
    if (!turn || typeof turn !== 'object') continue;
    const role_in = String(turn.role || 'user').toLowerCase();
    const role = role_in === 'model' || role_in === 'assistant' ? 'assistant' : 'user';
    const parts = Array.isArray(turn.parts) ? turn.parts : [];
    const texts = [];
    const images = [];
    const tool_calls = [];
    const tool_results = [];

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') {
        // Replayed thinking is not portable across vendors; drop it from history.
        if (!part.thought) texts.push(part.text);
        continue;
      }
      const inline = part.inlineData || part.inline_data;
      if (inline && inline.data) {
        const mime = inline.mimeType || inline.mime_type || 'image/png';
        images.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${inline.data}` } });
        continue;
      }
      const fc = part.functionCall || part.function_call;
      if (fc && typeof fc === 'object') {
        const name = typeof fc.name === 'string' ? fc.name : 'unknown_function';
        const id = typeof fc.id === 'string' && fc.id ? fc.id : `call_${++auto_id}`;
        id_by_name.set(name, id);
        tool_calls.push({
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(fc.args && typeof fc.args === 'object' ? fc.args : {}) },
        });
        continue;
      }
      const fr = part.functionResponse || part.function_response;
      if (fr && typeof fr === 'object') {
        const name = typeof fr.name === 'string' ? fr.name : 'unknown_function';
        tool_results.push({
          role: 'tool',
          tool_call_id: id_by_name.get(name) || `call_${name}`,
          content: JSON.stringify(fr.response && typeof fr.response === 'object' ? fr.response : {}),
        });
      }
    }

    // OpenAI requires tool messages right after the assistant turn that asked
    // for them, so they go first and any accompanying user text follows.
    for (const tr of tool_results) messages.push(tr);

    if (texts.length || images.length || tool_calls.length) {
      const message = { role };
      if (images.length) {
        const content = [];
        if (texts.length) content.push({ type: 'text', text: texts.join('\n') });
        content.push(...images);
        message.content = content;
      } else {
        message.content = texts.join('\n');
      }
      if (tool_calls.length) {
        message.tool_calls = tool_calls;
        if (!message.content) message.content = null;
      }
      if (message.content === '' && !message.tool_calls) continue;
      merge_message(messages, message);
    }
  }

  const out = {
    model: opts.model,
    messages,
    stream: Boolean(opts.stream),
  };
  if (opts.stream) out.stream_options = { include_usage: true };

  const gc = gen.generation_config || {};
  const temperature = clamp_number(gc.temperature, 0, 2);
  if (temperature !== undefined) out.temperature = temperature;
  const top_p = clamp_number(gc.topP ?? gc.top_p, 0, 1);
  if (top_p !== undefined) out.top_p = top_p;
  const max_tokens = Number(gc.maxOutputTokens ?? gc.max_output_tokens);
  if (Number.isFinite(max_tokens) && max_tokens > 0) out.max_tokens = Math.trunc(max_tokens);
  const n = Number(gc.candidateCount ?? gc.candidate_count);
  if (Number.isFinite(n) && n > 1) out.n = Math.trunc(n);
  if (Array.isArray(gc.stopSequences) && gc.stopSequences.length) {
    out.stop = gc.stopSequences.filter((s) => typeof s === 'string').slice(0, 4);
  }
  const presence = Number(gc.presencePenalty ?? gc.presence_penalty);
  if (Number.isFinite(presence)) out.presence_penalty = presence;
  const frequency = Number(gc.frequencyPenalty ?? gc.frequency_penalty);
  if (Number.isFinite(frequency)) out.frequency_penalty = frequency;

  if (gc.responseSchema) {
    out.response_format = {
      type: 'json_schema',
      json_schema: { name: 'gemini_response', schema: sanitize_schema(gc.responseSchema) },
    };
  } else if (String(gc.responseMimeType || gc.response_mime_type || '').toLowerCase() === 'application/json') {
    out.response_format = { type: 'json_object' };
  }

  const effort = gen.reasoning_effort || reasoning_effort_from_gemini(gc.thinkingConfig || gc.thinking_config);
  if (effort) out.reasoning_effort = effort;

  const decls = collect_function_declarations(gen.tools);
  if (decls.length) {
    out.tools = decls.map((decl) => ({
      type: 'function',
      function: {
        name: decl.name || 'unknown_function',
        description: decl.description || '',
        parameters: sanitize_schema(decl.parameters || { type: 'object', properties: {} }),
      },
    }));
    const choice = tool_choice_from_gemini(gen.tool_config, 'openai');
    if (choice !== undefined) out.tool_choice = choice;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Gemini request -> Anthropic messages
// ---------------------------------------------------------------------------

export function to_anthropic_request(gen, opts = {}) {
  const messages = [];
  const id_by_name = new Map();
  let auto_id = 0;

  for (const turn of gen.contents) {
    if (!turn || typeof turn !== 'object') continue;
    const role_in = String(turn.role || 'user').toLowerCase();
    const role = role_in === 'model' || role_in === 'assistant' ? 'assistant' : 'user';
    const parts = Array.isArray(turn.parts) ? turn.parts : [];
    const blocks = [];

    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') {
        if (part.thought) continue;
        if (part.text) blocks.push({ type: 'text', text: part.text });
        continue;
      }
      const inline = part.inlineData || part.inline_data;
      if (inline && inline.data) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: inline.mimeType || inline.mime_type || 'image/png',
            data: inline.data,
          },
        });
        continue;
      }
      const fc = part.functionCall || part.function_call;
      if (fc && typeof fc === 'object') {
        const name = typeof fc.name === 'string' ? fc.name : 'unknown_function';
        const id = typeof fc.id === 'string' && fc.id ? fc.id : `toolu_${++auto_id}`;
        id_by_name.set(name, id);
        blocks.push({ type: 'tool_use', id, name, input: fc.args && typeof fc.args === 'object' ? fc.args : {} });
        continue;
      }
      const fr = part.functionResponse || part.function_response;
      if (fr && typeof fr === 'object') {
        const name = typeof fr.name === 'string' ? fr.name : 'unknown_function';
        blocks.push({
          type: 'tool_result',
          tool_use_id: id_by_name.get(name) || `toolu_${name}`,
          content: JSON.stringify(fr.response && typeof fr.response === 'object' ? fr.response : {}),
        });
      }
    }

    if (!blocks.length) continue;
    const prev = messages[messages.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }

  const gc = gen.generation_config || {};
  let max_tokens = Number(gc.maxOutputTokens ?? gc.max_output_tokens);
  if (!Number.isFinite(max_tokens) || max_tokens <= 0) max_tokens = DEFAULT_MAX_OUTPUT;
  max_tokens = Math.trunc(max_tokens);

  const out = { model: opts.model, max_tokens, messages, stream: Boolean(opts.stream) };

  const system = text_of_system_instruction(gen.system_instruction);
  if (system) out.system = system;

  const thinking_cfg = gc.thinkingConfig || gc.thinking_config;
  let thinking_on = false;
  if (gen.reasoning_effort) {
    out.thinking = gen.adaptive_thinking ? { type: 'adaptive' } : gen.thinking_budget === 0 ? { type: 'disabled' }
      : { type: 'enabled', budget_tokens: gen.thinking_budget };
    if (gen.adaptive_thinking) out.output_config = { effort: gen.reasoning_effort };
    thinking_on = gen.adaptive_thinking || gen.thinking_budget > 0;
  } else if (thinking_cfg && typeof thinking_cfg === 'object') {
    const budget = Number(thinking_cfg.thinkingBudget ?? thinking_cfg.thinking_budget);
    if (Number.isFinite(budget) && budget > 0) {
      if (max_tokens <= 1024) throw new Error('Anthropic 思考预算要求最大输出大于 1024 tokens。');
      const budget_tokens = Math.min(max_tokens - 1, Math.max(1024, Math.trunc(budget)));
      out.thinking = { type: 'enabled', budget_tokens };
      thinking_on = true;
    }
  }

  if (!thinking_on) {
    const temperature = clamp_number(gc.temperature, 0, 1);
    if (temperature !== undefined) out.temperature = temperature;
  }
  const top_p = clamp_number(gc.topP ?? gc.top_p, 0, 1);
  if (top_p !== undefined && !thinking_on) out.top_p = top_p;
  if (Array.isArray(gc.stopSequences) && gc.stopSequences.length) {
    out.stop_sequences = gc.stopSequences.filter((s) => typeof s === 'string').slice(0, 4);
  }

  const decls = collect_function_declarations(gen.tools);
  if (decls.length) {
    out.tools = decls.map((decl) => ({
      name: decl.name || 'unknown_function',
      description: decl.description || '',
      input_schema: sanitize_schema(decl.parameters || { type: 'object', properties: {} }),
    }));
    const choice = tool_choice_from_gemini(gen.tool_config, 'anthropic');
    if (choice !== undefined) out.tool_choice = choice;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Gemini request -> Gemini request (pass-through, but cleaned)
// ---------------------------------------------------------------------------

export function to_gemini_request(gen, opts = {}) {
  const out = { contents: gen.contents };
  if (gen.system_instruction) out.systemInstruction = gen.system_instruction;
  if (gen.tools.length) out.tools = gen.tools;
  if (gen.tool_config) out.toolConfig = gen.tool_config;
  const gc = { ...gen.generation_config };
  if (!Number.isFinite(Number(gc.maxOutputTokens)) && opts.max_output_tokens) {
    gc.maxOutputTokens = opts.max_output_tokens;
  }
  if (Object.keys(gc).length) out.generationConfig = gc;
  if (gen.safety_settings.length) out.safetySettings = gen.safety_settings;
  return out;
}

// ---------------------------------------------------------------------------
// Upstream response -> canonical parts / deltas
// ---------------------------------------------------------------------------

export function finish_reason_from_openai(reason) {
  switch (String(reason || '').toLowerCase()) {
    case 'stop':
    case 'eos':
      return 'STOP';
    case 'length':
    case 'max_tokens':
      return 'MAX_TOKENS';
    case 'tool_calls':
    case 'function_call':
      return 'STOP';
    case 'content_filter':
      return 'SAFETY';
    default:
      return reason ? 'STOP' : undefined;
  }
}

export function finish_reason_from_anthropic(reason) {
  switch (String(reason || '').toLowerCase()) {
    case 'end_turn':
    case 'stop_sequence':
      return 'STOP';
    case 'max_tokens':
      return 'MAX_TOKENS';
    case 'tool_use':
      return 'STOP';
    case 'refusal':
      return 'SAFETY';
    case 'pause_turn':
      return 'STOP';
    default:
      return reason ? 'STOP' : undefined;
  }
}

export function parts_from_openai_message(message) {
  const parts = [];
  if (!message || typeof message !== 'object') return parts;
  const reasoning = message.reasoning_content ?? message.reasoning ?? message.thinking;
  if (typeof reasoning === 'string' && reasoning) parts.push({ text: reasoning, thought: true });
  const content = message.content;
  if (typeof content === 'string') {
    if (content) parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && typeof block.text === 'string' && block.text) {
        parts.push({ text: block.text });
      }
    }
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!call || typeof call !== 'object') continue;
    const fn = call.function && typeof call.function === 'object' ? call.function : {};
    parts.push({
      functionCall: {
        name: typeof fn.name === 'string' ? fn.name : 'unknown_function',
        args: parse_json_loose(fn.arguments),
      },
    });
  }
  return parts;
}

export function parts_from_anthropic_content(content) {
  const parts = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      parts.push({ text: block.text });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      parts.push({ text: block.thinking, thought: true });
    } else if (block.type === 'redacted_thinking') {
      parts.push({ text: '', thought: true });
    } else if (block.type === 'tool_use') {
      parts.push({
        functionCall: {
          name: typeof block.name === 'string' ? block.name : 'unknown_function',
          args: block.input && typeof block.input === 'object' ? block.input : {},
        },
      });
    }
  }
  return parts;
}

export function usage_gemini(prompt, candidates, total) {
  const p = Number.isFinite(Number(prompt)) ? Number(prompt) : 0;
  const c = Number.isFinite(Number(candidates)) ? Number(candidates) : 0;
  const t = Number.isFinite(Number(total)) ? Number(total) : p + c;
  return { promptTokenCount: p, candidatesTokenCount: c, totalTokenCount: t };
}

/** Build one GenerateContentResponse chunk from a canonical delta. */
export function chunk_for_delta(delta, model_version) {
  if (!delta || typeof delta !== 'object') return null;
  const version = model_version || 'agy-bridge';
  switch (delta.kind) {
    case 'gemini_part':
      if (!delta.part || typeof delta.part !== 'object' || Array.isArray(delta.part)) return null;
      return {
        candidates: [{ content: { role: 'model', parts: [delta.part] }, index: 0 }],
        modelVersion: version,
      };
    case 'text':
      if (!delta.text) return null;
      return {
        candidates: [{ content: { role: 'model', parts: [{ text: delta.text }] }, index: 0 }],
        modelVersion: version,
      };
    case 'thought':
      if (!delta.text) return null;
      return {
        candidates: [{ content: { role: 'model', parts: [{ text: delta.text, thought: true }] }, index: 0 }],
        modelVersion: version,
      };
    case 'tool_call':
      return {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: delta.name || 'unknown_function', args: delta.args || {} } }],
            },
            index: 0,
          },
        ],
        modelVersion: version,
      };
    case 'finish':
      return {
        candidates: [
          {
            content: { role: 'model', parts: [] },
            index: 0,
            finishReason: delta.reason || 'STOP',
          },
        ],
        modelVersion: version,
      };
    case 'usage':
      return { usageMetadata: usage_gemini(delta.prompt, delta.candidates, delta.total), modelVersion: version };
    default:
      return null;
  }
}

/** Build the single full GenerateContentResponse used by :generateContent. */
export function gemini_response({ parts, finish_reason, usage, model_version }) {
  const response = {
    candidates: [
      {
        content: { role: 'model', parts: Array.isArray(parts) && parts.length ? parts : [{ text: '' }] },
        index: 0,
        finishReason: finish_reason || 'STOP',
      },
    ],
    modelVersion: model_version || 'agy-bridge',
  };
  if (usage) response.usageMetadata = usage_gemini(usage.prompt, usage.candidates, usage.total);
  return response;
}

/** Rough prompt-token estimate for :countTokens. chars / 4, rounded up. */
export function count_request_tokens(gen) {
  let chars = text_of_system_instruction(gen.system_instruction).length;
  for (const turn of gen.contents) {
    const parts = Array.isArray(turn && turn.parts) ? turn.parts : [];
    for (const part of parts) {
      if (typeof part.text === 'string') chars += part.text.length;
      else if (part.functionCall) chars += JSON.stringify(part.functionCall.args || {}).length;
      else if (part.functionResponse) chars += JSON.stringify(part.functionResponse.response || {}).length;
    }
  }
  const decls = collect_function_declarations(gen.tools);
  if (decls.length) chars += JSON.stringify(decls).length;
  return Math.ceil(chars / 4);
}
