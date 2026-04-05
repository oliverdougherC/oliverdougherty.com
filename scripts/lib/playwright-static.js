const { spawn } = require('node:child_process');

function isLocalBaseUrl(url) {
  return url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
}

function parsePortFromBaseUrl(url) {
  const match = url.match(/^http:\/\/[^:]+:(\d+)/);
  return match ? Number(match[1]) : 4173;
}

function startLocalStaticServer({ url, cwd, skip = false, bindHost = '127.0.0.1' }) {
  if (skip || !isLocalBaseUrl(url)) {
    return null;
  }

  const args = ['-m', 'http.server', String(parsePortFromBaseUrl(url))];
  if (bindHost) {
    args.push('--bind', bindHost);
  }

  return spawn('python3', args, {
    cwd,
    stdio: 'ignore'
  });
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
