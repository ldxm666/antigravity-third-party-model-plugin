// language: JavaScript (ESM), file: log.js, target: Node 24, deps: node: builtins only
//
// Ring buffer for the UI + append-only file log with daily rotation (keep 7).

import fs from 'node:fs';
import path from 'node:path';
import { log_dir } from './config.js';

const RING_SIZE = 500;
const KEEP_DAYS = 7;
const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };

const ring = [];
let ring_seq = 0;
let threshold = LEVEL_RANK.info;
let current_day = '';
let write_queue = [];
let writing = false;
let file_disabled = false;

function day_key(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function log_file() {
  return path.join(log_dir(), 'bridge.log');
}

/** Rename bridge.log -> bridge-YYYY-MM-DD.log when the date rolls over, then prune. */
function rotate_if_needed() {
  if (file_disabled) return;
  const today = day_key();
  if (today === current_day) return;
  const dir = log_dir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    file_disabled = true;
    return;
  }
  const live = log_file();
  if (current_day && fs.existsSync(live)) {
    try {
      fs.renameSync(live, path.join(dir, `bridge-${current_day}.log`));
    } catch {
      // If the rename loses a race we keep appending to the live file; the next
      // rollover attempt will try again.
    }
  }
  current_day = today;
  prune(dir, today);
}

function prune(dir, today) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  for (const name of names) {
    if (!/^bridge-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    if (name === `bridge-${today}.log`) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      // A file we cannot stat or unlink is not worth failing a request over.
    }
  }
}

function drain() {
  if (writing) return;
  const next = write_queue.shift();
  if (next === undefined) return;
  writing = true;
  fs.promises.appendFile(log_file(), next, 'utf8').catch(() => {
    // Disk full / permission denied: stop trying for the rest of the process so
    // we do not spam the event loop with rejected promises.
    file_disabled = true;
  }).finally(() => {
    writing = false;
    if (write_queue.length) drain();
  });
}

export function set_log_level(level) {
  threshold = LEVEL_RANK[level] || LEVEL_RANK.info;
}

export function get_log_level() {
  for (const [name, rank] of Object.entries(LEVEL_RANK)) {
    if (rank === threshold) return name;
  }
  return 'info';
}

export function recent_logs(limit = 200) {
  const n = Math.max(1, Math.min(RING_SIZE, Number(limit) || 200));
  return ring.slice(-n);
}

export function clear_logs() {
  ring.length = 0;
}

export function log(level, msg, meta) {
  const lvl = LEVEL_RANK[level] ? level : 'info';
  if (LEVEL_RANK[lvl] < threshold) return;
  const entry = {
    ts: new Date().toISOString(),
    level: lvl,
    msg: typeof msg === 'string' ? msg : String(msg),
  };
  if (meta !== undefined) entry.meta = meta;
  entry.seq = ++ring_seq;
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

  const line = JSON.stringify(entry) + '\n';
  rotate_if_needed();
  if (!file_disabled) {
    write_queue.push(line);
    if (write_queue.length > 5000) write_queue = write_queue.slice(-5000);
    drain();
  }
  if (lvl === 'error') process.stderr.write(`[agy-bridge][error] ${entry.msg}${entry.meta ? ' ' + JSON.stringify(entry.meta) : ''}\n`);
  else if (lvl === 'warn') process.stderr.write(`[agy-bridge][warn] ${entry.msg}${entry.meta ? ' ' + JSON.stringify(entry.meta) : ''}\n`);
  else process.stdout.write(`[agy-bridge][${lvl}] ${entry.msg}${entry.meta ? ' ' + JSON.stringify(entry.meta) : ''}\n`);
}

export const debug = (msg, meta) => log('debug', msg, meta);
export const info = (msg, meta) => log('info', msg, meta);
export const warn = (msg, meta) => log('warn', msg, meta);
export const error = (msg, meta) => log('error', msg, meta);

/** Flush the pending queue synchronously; used on shutdown and by the selftest. */
export function flush_logs() {
  if (!write_queue.length || file_disabled) return;
  const payload = write_queue.join('');
  write_queue = [];
  try {
    fs.appendFileSync(log_file(), payload, 'utf8');
  } catch {
    file_disabled = true;
  }
}

export function log_file_path() {
  return log_file();
}
