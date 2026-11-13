#!/usr/bin/env node
// language: JavaScript (ESM), file: index.js, target: Node 24, deps: node: builtins only
//
// Entry point. Starts the loopback bridge and prints the one environment
// variable the language server needs.

import { APP_VERSION, config_path, home_dir } from './config.js';
import * as logger from './log.js';
import { start_server } from './server.js';

function banner(handle) {
  const { port, state } = handle;
  const cfg = state.config;
  const provider = cfg.providers.find((p) => p.id === cfg.active_provider_id) || cfg.providers[0] || null;
  const lines = [
    '',
    `  agy-bridge core v${APP_VERSION}`,
    `  listening     http://127.0.0.1:${port}`,
    `  config        ${handle.state.config_path}`,
    `  logs          ${home_dir()}`,
    `  providers     ${cfg.providers.length}`,
    `  models        ${Object.keys(cfg.model_map).length}`,
    `  active        ${provider ? `${provider.id} (${provider.kind})` : '(none)'}`,
    `  default model ${cfg.default_model || '(none)'}`,
    '',
    '  point the language server at it:',
    `    CLOUD_CODE_URL=http://127.0.0.1:${port}`,
    '',
  ];
  if (!provider) {
    lines.push('  ! 没有配置任何 provider，先打开配置页添加一个。', '');
  } else if (!provider.api_key) {
    lines.push(`  ! provider '${provider.id}' 的 api_key 还是空的，转发会失败。`, '');
  }
  if (handle.created) lines.push('  * 已生成默认配置文件。', '');
  if (handle.recovered) lines.push('  * 原配置文件损坏，已备份并重建。', '');
  process.stdout.write(lines.join('\n') + '\n');
}

const port_override = process.env.AGY_BRIDGE_PORT ? Number(process.env.AGY_BRIDGE_PORT) : undefined;

let handle;
try {
  handle = await start_server({ port: port_override });
} catch (err) {
  process.stderr.write(`[agy-bridge] 启动失败: ${err && err.message ? err.message : err}\n`);
  if (err && err.code === 'EADDRINUSE') {
    process.stderr.write('[agy-bridge] 端口被占用，改 config.json 的 port 或设置 AGY_BRIDGE_PORT。\n');
  }
  process.exit(1);
}

banner(handle);
logger.info('bridge_started', {
  port: handle.port,
  config: handle.state.config_path,
  providers: handle.config.providers.length,
  models: Object.keys(handle.config.model_map).length,
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  process.stdout.write(`\n[agy-bridge] ${signal} received, shutting down\n`);
  try {
    await handle.close();
  } catch {
    // closing a server that already died is not an error worth reporting
  }
  logger.flush_logs();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { error: reason && reason.message ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { error: err && err.message ? err.message : String(err) });
});

export { handle };
