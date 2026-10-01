import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

type Exchange = { request: IncomingMessage; response: ServerResponse; upstream: IncomingMessage };
type HeldBody = { started: Promise<void>; release(): void };
const { startGalleryNetworkFixture, holdResponseBody } = require('../../scripts/lib/gallery-network-fixture') as {
  startGalleryNetworkFixture(base: string, intercept?: (exchange: Exchange) => boolean): Promise<{ url: string; close(): Promise<void> }>;
  holdResponseBody(exchange: Exchange): HeldBody;
};

async function withOrigin(handler: (request: IncomingMessage, response: ServerResponse) => void, run: (base: string) => Promise<void>) {
  const origin = createServer(handler).listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const address = origin.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    origin.closeAllConnections();
    await new Promise<void>(resolve => origin.close(() => resolve()));
  }
}

describe('gallery HTTP response fixture', () => {
  it('pins absolute-form client requests to the configured upstream origin', async () => {
    await withOrigin((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.url);
    }, async base => {
      const fixture = await startGalleryNetworkFixture(base);
      try {
        const url = new URL(fixture.url);
        const body = await new Promise<string>((resolve, reject) => {
          get({ hostname: url.hostname, port: url.port, path: 'http://127.0.0.1:1/sentinel?check=1' }, response => {
            let text = '';
            response.on('data', chunk => { text += chunk; });
            response.on('end', () => resolve(text));
          }).on('error', reject);
        });
        expect(body).toBe('/sentinel?check=1');
      } finally { await fixture.close(); }
    });
  });

  it('rejects an empty response instead of leaving first-chunk waiters pending', async () => {
    await withOrigin((_request, response) => response.end(), async base => {
      let held: HeldBody | undefined;
      const fixture = await startGalleryNetworkFixture(base, exchange => { held = holdResponseBody(exchange); return true; });
      try {
        const response = await fetch(fixture.url);
        await expect(held!.started).rejects.toThrow('ended before its first body chunk');
        await response.body?.cancel();
      } finally { await fixture.close(); }
    });
  });

  it('delivers headers and partial bytes while keeping completion under test control', async () => {
    const bytes = Buffer.alloc(16000, 65);
    await withOrigin((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/avif', 'Content-Length': bytes.length });
      response.end(bytes);
    }, async base => {
      let held: HeldBody | undefined;
      const fixture = await startGalleryNetworkFixture(base, exchange => { held = holdResponseBody(exchange); return true; });
      try {
        const response = await fetch(fixture.url);
        expect(response.status).toBe(200);
        await held!.started;
        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(first.value!.length).toBeGreaterThan(0);
        expect(first.value!.length).toBeLessThan(bytes.length);
        held!.release();
        let received = first.value!.length;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.length;
        }
        expect(received).toBe(bytes.length);
      } finally { held?.release(); await fixture.close(); }
    });
  });
});
