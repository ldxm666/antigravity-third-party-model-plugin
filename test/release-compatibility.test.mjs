import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { APP_VERSION } from '../core/config.js';

test('the public release opens native settings with a compatible settings API', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  for (const name of ['package.json', 'core/package.json', 'package-lock.json']) {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    assert.equal(metadata.version, APP_VERSION, name);
    if (metadata.packages) assert.equal(metadata.packages[''].version, APP_VERSION);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-release-'));
  const previousHome = process.env.AGY_BRIDGE_HOME;
  process.env.AGY_BRIDGE_HOME = home;
  let bridge;
  try {
    const { start_server } = await import('../core/server.js');
    bridge = await start_server({ port: 0, config: { providers: [], log_level: 'error' } });
    const response = await fetch(`http://127.0.0.1:${bridge.port}/api/state`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.version, APP_VERSION);
    assert.equal(state.native_settings_api, 1);
    const source = fs.readFileSync(path.join(root, 'patch/native-page.js'), 'utf8');
    const loadSource = source.slice(source.indexOf('  async function load('), source.indexOf('  const options ='));
    async function open(data, accepted) {
      let renders = 0;
      const context = { S: { id: '', data: { stale: true } }, api: async route => {
        assert.equal(route, '/api/state'); return data;
      }, choose() {}, render() { renders++; } };
      vm.createContext(context);
      vm.runInContext(loadSource + ';globalThis.openSettings = load;', context);
      if (accepted) {
        await context.openSettings();
        assert.equal(context.S.data, data);
        assert.equal(renders, 1);
      } else {
        await assert.rejects(context.openSettings(), /后台桥仍为/);
        assert.equal(context.S.data, null);
        assert.equal(renders, 0);
      }
    }
    await open(state, true);
    await open({ ...state, version: '1.0.1' }, true);
    await open({ ...state, version: '1.5.7', native_settings_api: undefined }, true);
    await open({ ...state, version: '1.4.0', native_settings_api: undefined }, false);
    await open({ ...state, version: '', native_settings_api: undefined }, false);
  } finally {
    if (bridge) await bridge.close();
    if (previousHome === undefined) delete process.env.AGY_BRIDGE_HOME;
    else process.env.AGY_BRIDGE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
