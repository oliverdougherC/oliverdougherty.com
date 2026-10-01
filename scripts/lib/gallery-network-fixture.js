// Test-only HTTP proxy. Unlike Playwright routing, this preserves browser cache
// behavior and can flush real response headers while holding an incomplete body.
const http = require('node:http');
const https = require('node:https');

async function startGalleryNetworkFixture(baseUrl, intercept = () => false) {
  const sockets = new Set();
  const requests = new Set();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, baseUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const forwarded = transport.get(url, { headers: { ...request.headers, host: url.host } }, upstream => {
      upstream.on('error', error => response.destroy(error));
      if (!intercept({ request, response, upstream })) {
        response.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(response);
      }
    });
    requests.add(forwarded);
    forwarded.on('close', () => requests.delete(forwarded));
    forwarded.on('error', error => response.destroy(error));
    response.on('close', () => forwarded.destroy());
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const request of requests) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

function holdResponseBody({ response, upstream }) {
  let release;
  let resolveStarted;
  let rejectStarted;
  let awaitingChunk = true;
  const released = new Promise(resolve => { release = resolve; });
  const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  // Some newly resumed requests are deliberately canceled by context cleanup
  // before a caller awaits them. Still propagate failures to explicit awaiters.
  started.catch(() => {});
  const cleanupStart = () => {
    clearTimeout(deadline);
    upstream.removeListener('end', ended);
    upstream.removeListener('error', failed);
    response.removeListener('close', ended);
  };
  const failed = error => {
    if (!awaitingChunk) return;
    awaitingChunk = false;
    cleanupStart();
    rejectStarted(error);
  };
  const ended = () => failed(new Error('Held response ended before its first body chunk'));
  const deadline = setTimeout(() => {
    failed(new Error('Held response did not provide its first body chunk within 10 seconds'));
    upstream.destroy();
    response.destroy();
  }, 10000);
  upstream.once('end', ended);
  upstream.once('error', failed);
  response.once('close', ended);
  response.writeHead(upstream.statusCode, { ...upstream.headers, 'cache-control': 'no-store' });
  response.flushHeaders();
  upstream.once('data', chunk => {
    if (!awaitingChunk) return;
    awaitingChunk = false;
    cleanupStart();
    upstream.pause();
    // Sixteen bytes cannot contain a complete shipped gallery image. Keeping
    // the remaining bytes makes a real partial response, not a delayed header.
    response.write(chunk.subarray(0, 16));
    resolveStarted();
    released.then(() => {
      if (response.destroyed) return;
      response.write(chunk.subarray(16));
      upstream.pipe(response);
    });
  });
  return { started, release };
}

module.exports = { startGalleryNetworkFixture, holdResponseBody };
