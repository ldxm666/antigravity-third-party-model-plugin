(() => {
  const { contextBridge, ipcRenderer, webFrame } = require('electron');
  contextBridge.exposeInMainWorld('agyBridge', { api: args => ipcRenderer.invoke('agy-bridge:api', args) });
  const source = /*AGY_PAGE_SOURCE*/;
  const start = () => { void webFrame.executeJavaScript(source).catch(e => console.error('[agy-bridge] Settings initialization failed:', e.message)); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
