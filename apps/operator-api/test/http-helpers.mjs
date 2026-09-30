import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../dist/app.js';

export function available(data) {
  return { available: true, data };
}

export const unsupported = {
  available: false,
  code: 'unsupported',
  reason: 'Gate-owned capability is not implemented.',
};

export function statusFixture() {
  // These values are contract fixtures, not definitions or measurements of the pipeline.
  const measurement = {
    available: true,
    value: 12,
    unit: 'test units',
    definition: 'Test fixture only',
  };
  return {
    replicationState: { available: true, value: 'test state' },
    metrics: {
      initialLoadProgress: measurement,
      throughput: measurement,
      incrementalLag: unsupported,
      dlqCount: unsupported,
    },
    health: [{ component: 'test component', state: 'healthy', reason: 'Test fixture only' }],
  };
}

export async function startOperator(t, handler) {
  const requests = [];
  let upstream;
  let origin;
  if (handler) {
    upstream = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method, url: request.url, body });
      response.setHeader('Content-Type', 'application/json');
      handler(request, response, body);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    origin = `http://127.0.0.1:${upstream.address().port}`;
  }

  const app = await createApp(origin);
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  t.after(async () => {
    await app.close();
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
  });

  async function request(path, method = 'GET', body) {
    const response = await fetch(url + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { request, requests, upstream, url };
}
