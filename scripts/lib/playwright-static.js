const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CONTENT_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.cur', 'application/octet-stream'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8']
]);

function isLocalBaseUrl(url) {
  return url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
}

function parsePortFromBaseUrl(url) {
  const match = url.match(/^http:\/\/[^:]+:(\d+)/);
  return match ? Number(match[1]) : 4173;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, host);
  });
}

async function startLocalStaticServer({ url, cwd, skip = false, bindHost = '127.0.0.1' }) {
  if (skip || !isLocalBaseUrl(url)) {
    return null;
  }

  const requestedUrl = new URL(url);
  const listenHost = bindHost ?? requestedUrl.hostname;
  const root = path.resolve(cwd);
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', requestedUrl.origin);
    const decodedPath = decodeURIComponent(requestUrl.pathname);
    const normalizedPath = path.normalize(decodedPath).replace(/^[/\\]+/, '');
    let filePath = path.join(root, normalizedPath);

    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    try {
      const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
      if (stats?.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }

      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(filePath).pipe(response);
    } catch (_error) {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end('Internal server error');
    }
  });

  try {
    await listen(server, parsePortFromBaseUrl(url), listenHost);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') {
      throw error;
    }

    await listen(server, 0, listenHost);
  }

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine static server address.');
  }

  requestedUrl.port = String(address.port);

  return {
    url: requestedUrl.toString().replace(/\/$/, ''),
    kill() {
      server.close();
    }
  };
}

async function waitForServer(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) return;
    } catch (_error) {
      // Retry until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 220));
  }

  throw new Error(`Timed out waiting for server at ${url}`);
}

async function clearStoredTheme(context, storageKey = 'od-color-mode') {
  await context.addInitScript((key) => {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      // Ignore storage access issues in automation contexts.
    }
  }, storageKey);
}

module.exports = {
  clearStoredTheme,
  isLocalBaseUrl,
  parsePortFromBaseUrl,
  startLocalStaticServer,
  waitForServer
};
