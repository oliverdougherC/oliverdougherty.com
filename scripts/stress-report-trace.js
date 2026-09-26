#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY environment trace for the CPU pool question "why does the run
 * start at N workers?".
 *
 * The pool size a run starts with is not a property of the machine: it is whatever
 * the page's planner was handed. This script separates the layers that can produce
 * that number and prints each one for every browser it can launch, so a wrong pool
 * size is attributed to a specific layer instead of assumed:
 *
 *   1. The operating system's own logical-processor count (Node's view — the
 *      development ground truth. Nothing in the shipped site reads this.)
 *   2. `navigator.hardwareConcurrency` in the PAGE, unmodified.
 *   3. `navigator.hardwareConcurrency` inside a real dedicated WORKER, before any
 *      compute loop runs — a worker is a different thread and in principle a
 *      different answer.
 *   4. The value the CONTROLLER actually hands its planner, read back from
 *      `data-stress-cpu-report` after Start, plus the exact-count hook if set.
 *   5. Which worker/controller bundles the served page actually loaded, and their
 *      content hashes, so a stale build cannot be mistaken for current behaviour.
 *
 * Usage (repository root):
 *   node scripts/stress-report-trace.js
 *   node scripts/stress-report-trace.js --browsers=chromium,helium
 *   node scripts/stress-report-trace.js --url=http://127.0.0.1:4173
 *
 * Flags:
 *   --browsers=list  comma separated targets (default: every installed target)
 *   --url=url        serve root to use; starts its own static server if omitted
 *   --headed         launch visibly (default is headless)
 *   --start          also Start the workload to read what the controller planned
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const playwright = require('playwright');
const { startLocalStaticServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');

/**
 * Launchable targets. `engine` is the Playwright driver; `executablePath` points at
 * an installed browser, which is how the browser the user actually reads failure in
 * gets measured instead of only the Playwright-managed ones.
 */
const TARGETS = [
  { name: 'chromium', engine: 'chromium', note: 'Playwright-managed Chromium' },
  { name: 'chrome', engine: 'chromium', channel: 'chrome', note: 'installed Google Chrome' },
  { name: 'edge', engine: 'chromium', channel: 'msedge', note: 'installed Microsoft Edge' },
  { name: 'helium', engine: 'chromium',
    executablePath: process.env.OD_HELIUM_PATH || path.join(process.env.LOCALAPPDATA || '', 'imput', 'Helium', 'Application', 'chrome.exe'),
    note: 'installed Helium browser' },
  { name: 'firefox', engine: 'firefox', note: 'Playwright-managed Firefox' },
  { name: 'webkit', engine: 'webkit', note: 'Playwright-managed WebKit' }
];

function parseArgs(argv) {
  const options = { browsers: null, url: '', headed: false, start: false, profile: '' };
  for (const argument of argv) {
    const [flag, raw] = argument.split('=');
    switch (flag) {
      case '--browsers': options.browsers = raw.split(',').map(name => name.trim()).filter(Boolean); break;
      case '--url': options.url = raw; break;
      case '--headed': options.headed = true; break;
      case '--start': options.start = true; break;
      case '--profile': options.profile = raw; break;
      default: throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return options;
}

/** Reads the page/worker report, the hook values, and the identity of what loaded. */
const PROBE = async () => {
  const workerReport = await new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([
        'self.postMessage({'
        + 'hardwareConcurrency: navigator.hardwareConcurrency,'
        + 'deviceMemory: navigator.deviceMemory ?? null,'
        + 'userAgent: self.navigator.userAgent,'
        + 'isWorker: typeof Worker === "undefined" ? "no" : "yes"'
        + '});'
      ], { type: 'text/javascript' })));
    } catch (error) {
      resolve({ error: `worker could not be constructed: ${error.message}` });
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ error: 'worker did not answer within 5s' });
    }, 5000);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ error: `worker error: ${event.message}` });
    };
  });

  let clientHints = null;
  if (navigator.userAgentData?.getHighEntropyValues) {
    try {
      const hints = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion']);
      clientHints = `${hints.platform ?? ''} ${hints.architecture ?? ''} ${hints.bitness ?? ''}`.trim();
    } catch (error) {
      clientHints = `unavailable: ${error.message}`;
    }
  }

  const scripts = Array.from(document.querySelectorAll('script[src]')).map(script => script.src);
  return {
    pageHardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    userAgent: navigator.userAgent,
    clientHints,
    hooks: {
      exact: window.__OD_STRESS_TEST_WORKERS__ ?? null
    },
    workerReport,
    scripts,
    workerChunks: performance.getEntriesByType('resource')
      .map(entry => entry.name)
      .filter(name => /worker|stressTestController/.test(name))
      .sort()
  };
};

function sha256Prefix(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
}

/** Hash of every served asset the trace can see the page loaded, vs the file on disk. */
async function fingerprintAssets(baseUrl, urls) {
  const out = [];
  for (const assetUrl of [...new Set(urls)].slice(0, 12)) {
    let served = '';
    try {
      const response = await fetch(assetUrl);
      served = response.ok ? sha256Prefix(Buffer.from(await response.arrayBuffer())) : `HTTP ${response.status}`;
    } catch (error) {
      served = `fetch failed: ${error.message}`;
    }
    const relative = assetUrl.replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '').split('?')[0].split('#')[0];
    const diskPath = path.join(ROOT, relative.split('/').join(path.sep));
    let disk = 'not in working tree';
    if (fs.existsSync(diskPath)) {
      disk = sha256Prefix(fs.readFileSync(diskPath));
    }
    out.push({ asset: relative.split('/').pop(), served, disk, match: served === disk });
  }
  return out;
}

async function traceTarget(target, options, baseUrl) {
  // Playwright launches against a throwaway profile by default. `--profile=DIR`
  // instead opens a persistent context on a *copy* of a real profile, which is how
  // a per-profile fingerprint configuration gets measured rather than assumed.
  const launch = { headless: !options.headed };
  if (target.channel) launch.channel = target.channel;
  if (target.executablePath) launch.executablePath = target.executablePath;
  const result = { target: target.name, note: target.note, profile: options.profile || 'fresh temporary profile' };
  if (target.executablePath && !fs.existsSync(target.executablePath)) {
    return { ...result, unavailable: `not installed at ${target.executablePath}` };
  }
  let browser;
  let context;
  try {
    if (options.profile) {
      context = await playwright[target.engine].launchPersistentContext(path.resolve(options.profile), { ...launch, viewport: { width: 1280, height: 800 } });
      browser = context.browser();
    } else {
      browser = await playwright[target.engine].launch(launch);
      context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    }
  } catch (error) {
    return { ...result, unavailable: `could not launch: ${String(error.message).split('\n')[0]}` };
  }
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`${baseUrl}/pages/utilities/index.html#stress-test`, { waitUntil: 'domcontentloaded' });
    // `data-stress-state="idle"` is in the static HTML, so waiting for it proves
    // nothing: on a browser that boots its modules slowly the click lands before the
    // controller has bound its handlers and is simply lost. Wait for a dataset only
    // the controller publishes — its first metric frame.
    await page.waitForFunction(() => document.getElementById('stressTestApp')?.dataset.stressTotalRenderedFrames !== undefined,
      null, { timeout: 30000 });
    const probe = await page.evaluate(PROBE);
    result.probe = probe;
    if (options.start) {
      await page.click('[data-stress-mode-option="cpu"]');
      await page.click('#stressStartBtn');
      await page.waitForFunction(() => Number(document.querySelector('#stressTestApp').dataset.stressWorkerCount) > 0,
        null, { timeout: 15000 });
      await page.waitForTimeout(1500);
      result.planned = await page.evaluate(() => {
        const data = document.querySelector('#stressTestApp').dataset;
        return {
          reportPage: data.stressCpuReportPage ?? null,
          reportWorker: data.stressCpuReportWorker ?? null,
          report: data.stressCpuReport ?? null,
          poolSize: data.stressCpuPoolSize ?? null,
          poolSource: data.stressCpuPoolSource ?? null,
          limitation: data.stressCpuPoolLimitation ?? null,
          workers: data.stressWorkerCount ?? null,
          blocks: data.stressCpuBlocks ?? null,
          candidates: data.stressCandidates ?? null
        };
      });
      await page.click('#stressStopBtn');
      await page.waitForSelector('#stressTestApp[data-stress-state="idle"]', { timeout: 15000 });
    }
    result.assets = await fingerprintAssets(baseUrl, [...probe.scripts, ...probe.workerChunks]);
    result.errors = errors;
  } finally {
    await browser?.close();
  }
  return result;
}

function print(result, osCores) {
  console.log(`\n=== ${result.target} (${result.note})`);
  if (result.unavailable) {
    console.log(`  skipped: ${result.unavailable}`);
    return;
  }
  const probe = result.probe;
  console.log(`  os logical processors (node, dev ground truth): ${osCores}`);
  console.log(`  profile: ${result.profile}`);
  console.log(`  navigator.hardwareConcurrency — page:   ${probe.pageHardwareConcurrency}`);
  if (probe.workerReport?.error) {
    console.log(`  navigator.hardwareConcurrency — worker: ${probe.workerReport.error}`);
  } else {
    console.log(`  navigator.hardwareConcurrency — worker: ${probe.workerReport.hardwareConcurrency}`);
  }
  console.log(`  deviceMemory: ${probe.deviceMemory} · client hints: ${probe.clientHints ?? 'n/a'}`);
  console.log(`  hooks: exact=${probe.hooks.exact}`);
  console.log(`  ua: ${probe.userAgent}`);
  if (result.planned) {
    console.log(`  controller plan: page=${result.planned.reportPage} worker=${result.planned.reportWorker}`
      + ` → report=${result.planned.report} pool=${result.planned.poolSize} (source ${result.planned.poolSource})`
      + ` live=${result.planned.workers} blocks=${result.planned.blocks}`
      + `${result.planned.limitation ? ` limitation: ${result.planned.limitation}` : ''}`);
  }
  for (const asset of result.assets) {
    console.log(`  asset ${asset.asset}: served ${asset.served} disk ${asset.disk} ${asset.match ? '(same)' : '(DIFFERENT)'}`);
  }
  if (result.errors.length) {
    console.log(`  page errors: ${result.errors.join(' | ')}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const osCores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  console.log(`Host: ${os.cpus().length} entries in os.cpus(), availableParallelism ${osCores}, ${os.cpus()[0]?.model ?? 'unknown cpu'}`);
  const baseUrl = options.url || process.env.STRESS_TRACE_URL || 'http://127.0.0.1:4193';
  const server = await startLocalStaticServer({ url: baseUrl, cwd: ROOT, skip: Boolean(options.url) });
  const url = server?.url || baseUrl;
  const targets = TARGETS.filter(target => !options.browsers || options.browsers.includes(target.name));
  const results = [];
  try {
    for (const target of targets) {
      const result = await traceTarget(target, options, url);
      results.push(result);
      print(result, osCores);
    }
  } finally {
    server?.kill();
  }
  const outputDir = path.join(ROOT, 'output', 'stress-load');
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, 'report-trace.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ host: { osCpus: os.cpus().length, availableParallelism: osCores }, results }, null, 2));
  console.log(`\nDetail: ${path.relative(ROOT, jsonPath)}`);

  const answered = results.filter(result => result.probe);
  const disagreeing = answered.filter(result => result.probe.pageHardwareConcurrency !== osCores);
  console.log(`\nReport vs OS (${osCores}): `
    + answered.map(result => `${result.target}=${result.probe.pageHardwareConcurrency}`).join(' '));
  if (disagreeing.length) {
    console.log(`Under-reporting browsers: ${disagreeing.map(result => result.target).join(', ')} —`
      + ' that gap is browser-side reporting, not something the page can compute around.');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
