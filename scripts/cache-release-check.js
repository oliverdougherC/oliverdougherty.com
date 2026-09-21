#!/usr/bin/env node
// Build two actual module graphs with a changed worker. Simulate a visitor cache
// across replacement releases without retaining deleted files on the origin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startLocalStaticServer } = require('./lib/playwright-static');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output/release/cache');

async function main() {
  const { build } = await import('vite');
  const releases = {};
  for (const version of ['A', 'B']) {
    const directory = path.join(OUTPUT, version);
    await build({ configFile: path.join(ROOT, 'config/vite.utilities.mts'), logLevel: 'error',
      build: { outDir: directory, emptyOutDir: true },
      worker: { plugins: () => [{ name: 'release-worker-fixture', transform(code, id) {
        if (id.endsWith('/audioFourier.worker.ts')) return `${code}\nObject.defineProperty(globalThis, '__releaseFixture', { value: '${version}' });`;
      } }] }
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, '.vite/manifest.json'), 'utf8'));
    const entry = Object.values(manifest).find(item => item.isEntry).file;
    const controller = Object.values(manifest).find(item => item.src?.endsWith('/audioFourierController.ts')).file;
    const worker = fs.readdirSync(path.join(directory, 'assets')).find(file => /^audioFourier\.worker-/.test(file));
    releases[version] = { directory, entry, controller, worker };
  }
  for (const part of ['entry', 'controller', 'worker']) assert.notEqual(releases.A[part], releases.B[part], `Changed worker must invalidate its ${part}`);
  const server = await startLocalStaticServer({ url: 'http://127.0.0.1:0', cwd: path.join(ROOT, 'dist') });
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    const cache = new Map();
    let current = 'A';
    const requests = [];
    const html = fs.readFileSync(path.join(ROOT, 'dist/pages/utilities/index.html'), 'utf8');
    await context.route('**/pages/utilities/**', async route => {
      const url = new URL(route.request().url());
      const relative = url.pathname.split('/pages/utilities/assets/')[1];
      if (!relative) return route.fulfill({ contentType: 'text/html', body: html.replace(/utilities-app-[\w-]+\.js/, releases[current].entry) });
      requests.push({ release: current, relative });
      if (cache.has(relative)) return route.fulfill(cache.get(relative));
      const file = path.join(releases[current].directory, relative);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Removed old release asset' });
      const response = { body: fs.readFileSync(file), contentType: relative.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' };
      cache.set(relative, response);
      return route.fulfill(response);
    });
    const oldIdle = await context.newPage();
    await oldIdle.goto(`${server.url}/pages/utilities/`, { waitUntil: 'networkidle' });
    current = 'B';
    await oldIdle.click('[data-utility="audio-fourier"]');
    await oldIdle.waitForSelector('#utilityLoadRecovery');
    await oldIdle.getByRole('button', { name: 'Reload tools' }).click();
    await oldIdle.waitForSelector('#audioFourierGenerateBtn:enabled');
    assert.equal(await oldIdle.locator('#utilityLoadRecovery').count(), 0);
    await oldIdle.close();
    current = 'A';
    const oldLoaded = await context.newPage();
    await oldLoaded.goto(`${server.url}/pages/utilities/#audio-fourier`, { waitUntil: 'networkidle' });
    current = 'B';
    await oldLoaded.click('#audioFourierGenerateBtn');
    await oldLoaded.waitForSelector('#utilityLoadRecovery', { timeout: 30000 });
    await oldLoaded.getByRole('button', { name: 'Reload tools' }).click();
    await oldLoaded.waitForSelector('#audioFourierGenerateBtn:enabled');
    await oldLoaded.click('#audioFourierGenerateBtn');
    await oldLoaded.waitForSelector('#audioFourierPlayBtn:enabled', { timeout: 60000 });
    await oldLoaded.close();
    // Populate a full A cache, then navigate to B while retaining that cache.
    current = 'A';
    const visitor = await context.newPage();
    const errors = [];
    visitor.on('pageerror', error => errors.push(error.message));
    async function generate() {
      await visitor.goto(`${server.url}/pages/utilities/#audio-fourier`, { waitUntil: 'networkidle' });
      await visitor.click('#audioFourierGenerateBtn');
      await visitor.waitForSelector('#audioFourierPlayBtn:enabled', { timeout: 60000 });
    }
    await generate();
    current = 'B';
    await visitor.goto(server.url + '/', { waitUntil: 'networkidle' });
    await generate();
    assert.deepEqual(errors, []);
    for (const version of ['A', 'B']) {
      assert(requests.some(item => item.release === version && item.relative.endsWith(releases[version].worker)), `${version}: worker must actually execute`);
    }
    fs.writeFileSync(path.join(OUTPUT, 'result.json'), JSON.stringify({ passed: true, releases, requests }, null, 2) + '\n');
    console.log('Two-release cache test passed: worker/controller/entry invalidation, cached returning visitor, deleted lazy chunk recovery.');
  } finally { await browser?.close(); server.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
