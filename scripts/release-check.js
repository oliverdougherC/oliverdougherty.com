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

// Every check belongs to exactly one group. CI gives each group its own runner;
// checks stay serial within a runner to avoid competing browser/CPU workloads.
const GROUPS = ['navigation', 'home', 'gallery', 'utilities', 'artifact', 'cache'];
const BROWSERS = ['chromium', 'firefox', 'webkit'];

function createCheckPlan({ browsers = BROWSERS, group } = {}) {
  assert(browsers.length && browsers.every(browser => BROWSERS.includes(browser)), 'Unknown or empty release browser list');
  assert.equal(new Set(browsers).size, browsers.length, 'Duplicate release browsers');
  assert(group === undefined || GROUPS.includes(group), `Unknown release group: ${group}`);
  const checks = [{ name: 'cache-releases', file: 'cache-release-check.js', group: 'cache', env: {} }];
  for (const browser of browsers) {
    const env = { BROWSER: browser, HOME_CHECK_BROWSERS: browser, UTILITIES_BROWSER: browser };
    const add = (name, file, checkGroup, extra = {}) => checks.push({ name: `${browser}-${name}`, file, group: checkGroup, env: { ...env, ...extra } });
    for (const [name, file] of [['nav', 'nav-overlay-check.js'], ['nav-stability', 'navigation-stability-check.js'], ['optional-startup', 'optional-startup-check.js'], ['blackout-storage', 'blackout-storage-check.js']]) add(name, file, 'navigation');
    for (const [name, file] of [['gallery-release', 'gallery-release-check.js'], ['gallery-heading', 'gallery-heading-check.js'], ['gallery-inspector', 'gallery-inspector-check.js'], ['gallery-prefetch', 'gallery-prefetch-check.js'], ['gallery-transitions', 'gallery-transition-check.js'], ['gallery-status', 'gallery-status-check.js']]) add(name, file, 'gallery');
    add('artifact', 'artifact-browser-check.js', 'artifact');
    add('home-stage', 'home-check.js', 'home', { HOME_CHECK_STAGE_ONLY: '1' });
    add('home-reveal', 'nighthawks-reveal-check.js', 'home', { NIGHTHAWKS_CHECK_BROWSERS: browser });
    if (browser === 'chromium') {
      // Mobile routes include gallery and resume, so both feature selections need this check.
      add('mobile', 'mobile-site-check.js', 'navigation');
      for (const [name, file] of [['home', 'home-check.js'], ['resume-lifecycle', 'resume-lifecycle-check.js']]) add(name, file, 'home');
      for (const [name, file] of [['gallery', 'gallery-dropdown-check.js'], ['gallery-data', 'gallery-data-loading-check.js']]) add(name, file, 'gallery');
      for (const [name, file] of [['utilities', 'utilities-check.js'], ['transform-preparation', 'transform-preparation-check.js'], ['stress', 'stress-test-check.js']]) add(name, file, 'utilities');
    } else {
      // The complete Utilities suite is Chromium-only; keep the new game
      // covered by its focused real-engine suite in the other browsers too.
      add('yahtzee', 'yahtzee-check.js', 'utilities');
      add('stress-pool', 'stress-test-check.js', 'utilities', { STRESS_BROWSER_TYPE: browser, STRESS_POOL_ONLY: '1' });
    }
  }
  return group ? checks.filter(check => check.group === group) : checks;
}

async function executeChecks(checks, env, { failFast = false, runCheck = run, onResult = () => {} } = {}) {
  const results = [];
  for (const check of checks) {
    const result = await runCheck(check.name, check.file, { ...env, ...check.env });
    if (check.file === 'gallery-release-check.js') {
      const summary = path.join(OUTPUT, `gallery-release-check-${check.env.BROWSER}.json`);
      if (fs.existsSync(summary)) result.bfcache = JSON.parse(fs.readFileSync(summary, 'utf8')).bfcache;
    }
    results.push(result);
    onResult(results);
    if (failFast && result.status !== 'pass') break;
  }
  return results;
}

function writeSummary(report) {
  const lines = [`### Release validation: ${report.group || 'all groups'}`, '',
    `${report.results.length}/${report.plannedChecks.length} checks ran; ${report.omittedChecks.length} checks assigned to other groups.`,
    `Requested browsers: ${report.requestedBrowsers.join(', ')}. Fail fast: ${report.failFast}.`, '',
    '| Check (slowest first) | Result | Seconds |', '| --- | --- | ---: |',
    ...[...report.results].sort((a, b) => b.seconds - a.seconds).map(result => `| ${result.name} | ${result.status} | ${result.seconds.toFixed(1)} |`)];
  if (report.notRunChecks.length) lines.push('', `Not run: ${report.notRunChecks.join(', ')}`);
  if (report.error) lines.push('', `Runner error: ${report.error.replaceAll('\n', ' ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const browsers = (process.env.RELEASE_BROWSERS || BROWSERS.join(',')).split(',').map(name => name.trim());
  const group = process.env.RELEASE_GROUP;
  const checks = createCheckPlan({ browsers, group });
  const plannedChecks = checks.map(check => check.name);
  const report = { group: group || null, requestedBrowsers: browsers,
    omittedBrowsers: BROWSERS.filter(name => !browsers.includes(name)),
    completeBrowserMatrix: BROWSERS.every(name => browsers.includes(name)),
    plannedChecks, omittedChecks: createCheckPlan({ browsers }).filter(check => !plannedChecks.includes(check.name)).map(check => check.name),
    notRunChecks: plannedChecks, failFast: process.env.RELEASE_FAIL_FAST === '1', results: [] };
  const save = results => {
    report.results = results;
    report.notRunChecks = plannedChecks.filter(name => !results.some(result => result.name === name));
    report.unverifiedCapabilities = results.filter(result => result.bfcache?.status === 'not-exercised').map(result => ({ check: result.name, capability: 'BFCache restoration', reason: result.bfcache.reason }));
    fs.writeFileSync(path.join(OUTPUT, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  };
  let server;
  try {
    const artifact = JSON.parse(fs.readFileSync(path.join(DIST, 'release-artifact.json'), 'utf8'));
    report.artifact = artifact;
    assert.equal(artifact.kind, 'oliverdougherty-deploy');
    assert.equal(artifact.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), 'Deploy artifact belongs to a different candidate; rebuild dist');
    server = await startLocalStaticServer({ url: 'http://127.0.0.1:0', cwd: DIST, cacheControl: 'public, max-age=600' });
    const marker = await (await fetch(`${server.url}/release-artifact.json`)).json();
    assert.deepEqual(marker, artifact, 'Server must serve the tested dist artifact');
    assert.equal((await fetch(`${server.url}/package.json`)).status, 404, 'Source root must not be served');
    assert.equal((await fetch(`${server.url}/assets/art/nighthawks-binary.txt`)).status, 404, 'Authoring asset must not be served');
    const env = { STATIC_ROOT: DIST, REQUIRE_DEPLOY_ARTIFACT: '1', BASE_URL: server.url,
      HOME_CHECK_URL: server.url, NIGHTHAWKS_CHECK_URL: server.url, NAV_CHECK_URL: server.url, NAV_STABILITY_URL: server.url,
      RESUME_CHECK_URL: server.url, MOBILE_CHECK_URL: server.url,
      GALLERY_CHECK_URL: server.url, GALLERY_HEADING_URL: server.url, GALLERY_PREFETCH_URL: server.url,
      GALLERY_STATUS_URL: server.url, GALLERY_DATA_URL: server.url, GALLERY_TRANSITION_URL: server.url,
      UTILITIES_CHECK_URL: server.url, TRANSFORM_PREPARATION_URL: server.url,
      STRESS_CHECK_URL: server.url };
    const results = await executeChecks(checks, env, { failFast: report.failFast, onResult: save });
    assert(results.length === checks.length && results.every(result => result.status === 'pass'), 'Release browser checks failed; see output/release/*.log');
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    server?.kill();
    save(report.results);
    writeSummary(report);
  }
}
module.exports = { run, createCheckPlan, executeChecks, GROUPS };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
