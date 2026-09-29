import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { stalledScriptProxy } = require('../../scripts/optional-startup-check.js') as {
  stalledScriptProxy: (upstreamUrl: string, script: string, phase: string) => Promise<{
    url: string;
    readonly intercepted: number;
    close(): Promise<void>;
  }>;
};

const servers: http.Server[] = [];
const proxies: Awaited<ReturnType<typeof stalledScriptProxy>>[] = [];

async function localServer(onRequest: http.RequestListener): Promise<string> {
  const server = http.createServer(onRequest);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return `http://127.0.0.1:${address.port}`;
}

function get(baseUrl: string, target: string): Promise<{ status: number; body: string }> {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    http.get({ hostname: base.hostname, port: base.port, path: target }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    }).on('error', reject);
  });
}

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('optional startup proxy request destination', () => {
  it('forwards origin-form assets and their version query to the configured upstream', async () => {
    const paths: string[] = [];
    const upstream = await localServer((request, response) => {
      paths.push(request.url ?? '');
      response.end('asset');
    });
    const proxy = await stalledScriptProxy(upstream, 'year.js', 'headers');
    proxies.push(proxy);

    expect(await get(proxy.url, '/js/navigation.js?v=2026')).toEqual({ status: 200, body: 'asset' });
    expect(paths).toEqual(['/js/navigation.js?v=2026']);
  });

  it('rejects absolute, network-path, and malformed targets without contacting either upstream', async () => {
    let trustedHits = 0;
    let foreignHits = 0;
    const upstream = await localServer((_request, response) => { trustedHits++; response.end('trusted'); });
    const foreign = await localServer((_request, response) => { foreignHits++; response.end('foreign'); });
    const proxy = await stalledScriptProxy(upstream, 'year.js', 'headers');
    proxies.push(proxy);

    for (const target of [
      `${foreign}/asset.js`,
      `//127.0.0.1:${new URL(foreign).port}/asset.js`,
      '/asset%ZZ.js',
      '/asset#fragment'
    ]) {
      expect(await get(proxy.url, target)).toEqual({ status: 400, body: 'Invalid request target' });
    }
    expect(trustedHits).toBe(0);
    expect(foreignHits).toBe(0);
    expect(await get(proxy.url, '/asset.js')).toEqual({ status: 200, body: 'trusted' });
    expect(trustedHits).toBe(1);
    expect(foreignHits).toBe(0);
  });

  it.each(['headers', 'body'])('keeps a %s-stalled optional script open until cleanup', async (phase) => {
    const upstream = await localServer((_request, response) => response.end('asset'));
    const proxy = await stalledScriptProxy(upstream, 'year.js', phase);
    proxies.push(proxy);
    const base = new URL(proxy.url);
    let headersSeen = false;
    let bodyEnded = false;
    let body = '';
    const request = http.get({ hostname: base.hostname, port: base.port, path: '/js/year.js?v=2026' }, (response) => {
      headersSeen = true;
      response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      response.on('end', () => { bodyEnded = true; });
      response.on('error', () => {});
    });
    request.on('error', () => {});

    await vi.waitFor(() => expect(proxy.intercepted).toBe(1));
    if (phase === 'headers') {
      expect(headersSeen).toBe(false);
    } else {
      await vi.waitFor(() => expect(body).toContain('response body never finishes'));
      expect(headersSeen).toBe(true);
      expect(bodyEnded).toBe(false);
    }
  });
});
