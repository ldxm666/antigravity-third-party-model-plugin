// language: JavaScript (ESM), file: sse.js, target: Node 24, deps: node: builtins only
//
// Server-Sent Events: a byte-safe incremental parser and a small writer.
//
// The Python reference decoded every raw socket chunk with errors="replace",
// which shreds multi-byte UTF-8 that straddles a chunk boundary. We keep a
// streaming TextDecoder so a 3-byte CJK glyph split across two TCP reads still
// arrives intact.

const BOUNDARIES = ['\r\n\r\n', '\n\n', '\r\r'];

function find_boundary(text) {
  let best = -1;
  let length = 0;
  for (const sep of BOUNDARIES) {
    const i = text.indexOf(sep);
    if (i >= 0 && (best < 0 || i < best)) {
      best = i;
      length = sep.length;
    }
  }
  return best < 0 ? null : { index: best, length };
}

function parse_block(block) {
  const lines = block.split(/\r\n|\n|\r/);
  let event = '';
  let id = '';
  const data = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment / keep-alive
    const colon = line.indexOf(':');
    let field;
    let value;
    if (colon < 0) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }
  if (!data.length) return null;
  return { event: event || 'message', data: data.join('\n'), id };
}

/**
 * Incremental SSE parser.
 * @param {(evt: {event: string, data: string, id: string}) => void} on_event
 */
export function create_sse_parser(on_event) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let closed = false;

  const drain = () => {
    for (;;) {
      const hit = find_boundary(buf);
      if (!hit) return;
      const block = buf.slice(0, hit.index);
      buf = buf.slice(hit.index + hit.length);
      if (!block.trim()) continue;
      const evt = parse_block(block);
      if (evt) on_event(evt);
    }
  };

  return {
    /** Feed one raw chunk (Uint8Array / Buffer / string). */
    push(chunk) {
      if (closed) return;
      buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      drain();
    },
    /**
     * End of stream. Some servers omit the trailing blank line; anything left
     * that carries a data field is still dispatched rather than dropped.
     */
    end() {
      if (closed) return;
      closed = true;
      buf += decoder.decode();
      const tail = buf;
      buf = '';
      if (tail.trim()) {
        const evt = parse_block(tail);
        if (evt) on_event(evt);
      }
    },
    get buffered() {
      return buf;
    },
  };
}

/** One `data: <json>\n\n` frame. */
export function sse_frame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

/** One `data: <raw text>\n\n` frame (used for `[DONE]` pass-through). */
export function sse_data(text) {
  return `data: ${text}\n\n`;
}

/**
 * Thin wrapper over an http.ServerResponse that opens an SSE stream.
 *
 * Wire framing follows the reference implementation that is proven against the
 * real language server: `Connection: close` with no Transfer-Encoding and no
 * Content-Length, so the body is delimited by connection close. Node would
 * otherwise default to chunked, and the Go client on the other end is happiest
 * with the close-delimited form.
 */
export class SseWriter {
  constructor(res) {
    this.res = res;
    this.opened = false;
    this.bytes = 0;
    this.frames = 0;
  }

  open() {
    if (this.opened) return;
    this.opened = true;
    this.res.useChunkedEncodingByDefault = false;
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });
    this.res.flushHeaders?.();
  }

  /** Write a pre-serialised frame string. Returns false when the socket is gone. */
  write(frame) {
    if (!this.opened) this.open();
    if (this.res.writableEnded || this.res.destroyed) return false;
    this.bytes += Buffer.byteLength(frame);
    this.frames += 1;
    return this.res.write(frame);
  }

  send(value) {
    return this.write(sse_frame(value));
  }

  end() {
    if (this.res.writableEnded || this.res.destroyed) return;
    this.res.end();
  }
}

/** Non-streaming JSON reply helper. */
export function send_json(res, status, value, extra_headers) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extra_headers || {}),
  });
  res.end(body);
}
