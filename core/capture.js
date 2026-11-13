// language: JavaScript (ESM), file: capture.js, target: Node 24, deps: node: builtins only
//
// Raw request capture for live debugging against the real language server.
// Every generate/streamGenerateContent body is written verbatim to
// %LOCALAPPDATA%\agy-bridge\captures\<ts>-<method>.json, keeping the newest 50.
//
// The capture is the only place a full prompt body lands on disk, so it is
// pruned aggressively and never read back by the bridge itself.

import fs from 'node:fs';
import path from 'node:path';
import { log_dir } from './config.js';
import * as logger from './log.js';

const KEEP = 50;

export function captures_dir() {
  return path.join(log_dir(), 'captures');
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function prune(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const files = names.filter((n) => n.endsWith('.json')).sort();
  const excess = files.length - KEEP;
  if (excess <= 0) return;
  for (const name of files.slice(0, excess)) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // A capture we cannot delete is not worth failing a request over.
    }
  }
}

/**
 * Persist one raw request body. Returns the file path, or '' when the capture
 * could not be written (the relay must never depend on this succeeding).
 */
export function capture_request(method, raw_body) {
  const dir = captures_dir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${stamp()}-${method}.json`);
    fs.writeFileSync(file, raw_body, 'utf8');
    prune(dir);
    return file;
  } catch (err) {
    logger.warn('capture_failed', { method, error: err && err.message ? err.message : String(err) });
    return '';
  }
}

export function list_captures() {
  try {
    return fs
      .readdirSync(captures_dir())
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
