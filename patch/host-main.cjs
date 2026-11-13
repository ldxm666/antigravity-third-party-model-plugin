'use strict';
// Only the existing Hub renderer may access this fixed-loopback API proxy.
exports.install = function ({ electron, utils, origin }) {
  const { ipcMain } = electron;
  const http = require('node:http');
  const hubFor = sender => utils.getHubWindows().find(w => !w.isDestroyed() && w.webContents === sender);
  ipcMain.handle('agy-bridge:api', async (event, args) => {
    if (!hubFor(event.sender)) throw new Error('Invalid settings sender');
    const route = String(args?.path || ''), method = String(args?.method || 'GET');
    if (!/^\/api\/(?:health|state|active|model-map|reload|providers(?:\/[a-zA-Z0-9_%.-]+(?:\/(?:test|fetch-models))?)?)$/.test(route)
      || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported settings request');
    const body = args?.body === undefined ? '' : JSON.stringify(args.body);
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('Settings request too large');
    return new Promise(resolve => {
      let done = false; const finish = result => { if (!done) { done = true; resolve(result); } };
      const req = http.request(origin + route, { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        const chunks = []; let size = 0;
        res.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) req.destroy(); else chunks.push(c); });
        res.on('end', () => { try { finish({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); } catch { finish({ status: 502, data: { error: '本地桥返回了无效响应' } }); } });
        res.on('error', () => finish({ status: 502, data: { error: '本地桥响应中断' } }));
      });
      req.setTimeout(185000, () => req.destroy(new Error('Timeout')));
      req.on('error', () => finish({ status: 503, data: { error: '无法连接本地桥，请确认 agy-bridge 已启动' } })); req.end(body);
    });
  });
  return { open: () => {
    const windows = utils.getHubWindows(), win = windows.find(w => w.isFocused()) || windows[0];
    if (!win) return false;
    win.show(); win.focus(); void win.webContents.executeJavaScript('window.__agyProviderUi?.open()'); return true;
  } };
};
