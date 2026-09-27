import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';

const { waitForServer } = createRequire(import.meta.url)('../../scripts/lib/playwright-static.js');

it('bounds a preflight request when the server accepts but never responds', async () => {
  const server = createServer(() => { /* Hold headers open. */ });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port');
  try {
    const result = await Promise.race([
      waitForServer(`http://127.0.0.1:${address.port}`, 100).then(() => 'resolved', (error: Error) => error.message),
      new Promise<string>(resolve => setTimeout(() => resolve('test guard expired'), 350))
    ]);
    expect(result).toMatch(/Timed out waiting for server/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
