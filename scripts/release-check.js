#!/usr/bin/env node
// All browser checks below consume the same packaged output, on one owned server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { startLocalStaticServer } = require('./lib/playwright-static');
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUTPUT = path.join(ROOT, 'output/release');

async function run(name, file, env, timeout = 300000) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const log = fs.createWriteStream(path.join(OUTPUT, `${name}.log`));
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.resolve(ROOT, 'scripts', file)], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    console.log(`RUN: ${name}`);
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    let timedOut = false;
    let ownedPids = [child.pid];
    const stop = signal => {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
          return;
        }
        if (signal === 'SIGTERM') {
          // Browsers can detach into their own process groups. Capture their
          // ancestry before terminating the script, so they cannot be orphaned.
          const table = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 })
            .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
          const owned = new Set([child.pid]);
          let previous = 0;
          while (owned.size !== previous) {
            previous = owned.size;
            for (const [pid, parent] of table) if (owned.has(parent)) owned.add(pid);
          }
          ownedPids = [...owned];
        }
        for (const pid of [...ownedPids].reverse()) {
          try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      } catch (error) { if (error.code !== 'ESRCH') log.write(String(error)); }
    };
    const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); }, timeout);
    let killTimer;
    child.once('spawn', () => { killTimer = setTimeout(() => stop('SIGKILL'), timeout + 5000); });
    child.once('error', error => log.write(String(error)));
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (timedOut) stop('SIGKILL');
      log.end();
      const result = { name, code, signal, timedOut, seconds: (Date.now() - started) / 1000, status: code === 0 && !timedOut ? 'pass' : 'fail' };
      console.log(`${result.status.toUpperCase()}: ${name} (${result.seconds.toFixed(1)}s)`);
      resolve(result);
    });
  });
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const artifact = JSON.parse(fs.readFileSync(path.join(DIST, 'release-artifact.json'), 'utf8'));
  assert.equal(artifact.kind, 'oliverdougherty-deploy');
  assert.equal(artifact.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), 'Deploy artifact belongs to a different candidate; rebuild dist');
  const server = await startLocalStaticServer({ url: 'http://127.0.0.1:0', cwd: DIST, cacheControl: 'public, max-age=600' });
  const results = [];
  const browsers = (process.env.RELEASE_BROWSERS || 'chromium,firefox,webkit').split(',').map(name => name.trim());
  const omittedBrowsers = ['chromium', 'firefox', 'webkit'].filter(name => !browsers.includes(name));
  try {
    const marker = await (await fetch(`${server.url}/release-artifact.json`)).json();
    assert.deepEqual(marker, artifact, 'Server must serve the tested dist artifact');
    assert.equal((await fetch(`${server.url}/package.json`)).status, 404, 'Source root must not be served');
    assert.equal((await fetch(`${server.url}/assets/art/nighthawks-binary.txt`)).status, 404, 'Authoring asset must not be served');
    const env = { STATIC_ROOT: DIST, REQUIRE_DEPLOY_ARTIFACT: '1', BASE_URL: server.url,
      HOME_CHECK_URL: server.url, NAV_CHECK_URL: server.url, MOBILE_CHECK_URL: server.url,
      GALLERY_CHECK_URL: server.url, UTILITIES_CHECK_URL: server.url, STRESS_CHECK_URL: server.url };
    results.push(await run('cache-releases', 'cache-release-check.js', env));
    for (const browser of browsers) {
      const browserEnv = { ...env, BROWSER: browser, HOME_CHECK_BROWSERS: browser, UTILITIES_BROWSER: browser };
      for (const [name, script] of [['nav', 'nav-overlay-check.js'], ['gallery-release', 'gallery-release-check.js'], ['artifact', 'artifact-browser-check.js']]) {
        const result = await run(`${browser}-${name}`, script, browserEnv);
        if (name === 'gallery-release') {
          const summary = path.join(OUTPUT, `gallery-release-check-${browser}.json`);
          if (fs.existsSync(summary)) result.bfcache = JSON.parse(fs.readFileSync(summary, 'utf8')).bfcache;
        }
        results.push(result);
      }
      if (browser === 'chromium') {
        for (const [name, script] of [['home', 'home-check.js'], ['mobile', 'mobile-site-check.js'], ['gallery', 'gallery-dropdown-check.js'], ['utilities', 'utilities-check.js'], ['stress', 'stress-test-check.js']]) {
          const result = await run(`${browser}-${name}`, script, browserEnv);
        if (name === 'gallery-release') {
          const summary = path.join(OUTPUT, `gallery-release-check-${browser}.json`);
          if (fs.existsSync(summary)) result.bfcache = JSON.parse(fs.readFileSync(summary, 'utf8')).bfcache;
        }
        results.push(result);
        }
      }
    }
  } finally {
    server.kill();
    fs.writeFileSync(path.join(OUTPUT, 'results.json'), JSON.stringify({ artifact, requestedBrowsers: browsers, omittedBrowsers, completeBrowserMatrix: omittedBrowsers.length === 0, unverifiedCapabilities: results.filter(result => result.bfcache?.status === 'not-exercised').map(result => ({ check: result.name, capability: 'BFCache restoration', reason: result.bfcache.reason })), results }, null, 2) + '\n');
  }
  assert(results.length > 0 && results.every(result => result.status === 'pass'), 'Release browser checks failed; see output/release/*.log');
}
module.exports = { run };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
