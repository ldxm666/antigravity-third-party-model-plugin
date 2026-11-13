// Isolated Google stand-in for regression tests. Never used by the runtime.
import http from 'node:http';
import * as fixture from './fixtures/bootstrap-v1.js';

export async function start_control_plane_mock(get_config) {
  const handlers = {
    loadCodeAssist: fixture.load_code_assist,
    onboardUser: fixture.onboard_user,
    onboardUserBackgroundTasks: fixture.onboard_user,
    retrieveUserQuota: fixture.retrieve_user_quota,
    retrieveUserQuotaSummary: fixture.retrieve_user_quota_summary,
    fetchUserInfo: fixture.fetch_user_info,
    listExperiments: fixture.list_experiments,
    fetchAdminControls: fixture.fetch_admin_controls,
    listModelConfigs: fixture.list_model_configs,
    fetchAvailableModels: () => fixture.fetch_available_models({ providers: [], model_map: {} }),
  };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
      const method = url.pathname.replace(/^\/v1internal[:/]?/, '');
      const config = get_config();
      const payload = method === 'buildWithGooglePlugins' ? { plugins: [] }
        : { response: handlers[method] ? handlers[method](config) : {} };
      const body = JSON.stringify(payload);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
