// In-memory transport telemetry. Never retain prompts, tool arguments or keys.
export function create_request_progress({ now = Date.now, limit = 64, retention_ms = 30000 } = {}) {
  const records = new Map();
  function prune() {
    const time = now();
    for (const [id, row] of records) if (row.ended_at !== null && time - row.ended_at >= retention_ms) records.delete(id);
    while (records.size > limit) records.delete(records.keys().next().value);
  }
  return {
    start({ trace, request_id, provider_name, model, effort }) {
      const cascade_id = /^agent\/([0-9a-f-]{36})\//i.exec(request_id || '')?.[1];
      if (!cascade_id) return { note() {}, finish() {} };
      const row = { trace, cascade_id, provider_name, model, effort, started_at: now(), ended_at: null,
        status: 'running', phase: 'waiting_headers', bytes: 0, events: 0, argument_chars: 0, error_code: null };
      records.set(trace, row); prune();
      return {
        note(phase, extra = {}) {
          if (row.ended_at !== null) return;
          if (phase === 'upstream_bytes') row.bytes += Math.max(0, Number(extra.bytes) || 0);
          else if (phase === 'upstream_event') row.events++;
          else if (phase === 'upstream_tool_fragment') row.argument_chars += Math.max(0, Number(extra.argument_chars) || 0);
          if (phase === 'upstream_headers') row.phase = 'waiting_content';
          else if (phase === 'upstream_tool_fragment') row.phase = 'tool_arguments';
          else if (['forward_text', 'forward_thought', 'forward_tool_call'].includes(phase)) row.phase = phase;
        },
        finish(status, error_code = null) {
          if (row.ended_at !== null) return;
          row.status = status; row.ended_at = now(); row.error_code = error_code;
        },
      };
    },
    snapshot() {
      prune();
      return [...records.values()].map(row => ({ ...row, elapsed_ms: (row.ended_at ?? now()) - row.started_at }));
    },
  };
}
