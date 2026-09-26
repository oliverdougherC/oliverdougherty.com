#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY CPU load validation harness. Not a release check, not served,
 * and never referenced by the site: reading OS counters is validation tooling,
 * not a product feature.
 *
 * Why it exists: a worker-count assertion cannot prove the product goal. This
 * drives the real served page with real workers while sampling the operating
 * system's own per-logical-processor CPU counters, so a run is judged on measured
 * machine utilization — aggregate and per-core — instead of on a plausible number
 * of workers. It reports, honestly, what the machine actually did.
 *
 * Counters come from Windows PDH through `typeperf` (spawned with stdio ignored,
 * writing to a CSV file). Nothing reads OS counters inside the browser.
 *
 * Usage (repository root):
 *   node scripts/stress-load-harness.js --mode=cpu --workers=32 --duration=15000
 *   node scripts/stress-load-harness.js --mode=cpu --report=12 --duration=45000
 *   node scripts/stress-load-harness.js --mode=both --duration=60000 --browser=firefox
 *   node scripts/stress-load-harness.js --mode=cpu --duration=30000 \
 *     --executable="C:\path\to\browser.exe" --profile="C:\path\to\profile-copy"
 *
 * Flags:
 *   --mode=cpu|gpu|both                 UI mode selected before Start (default cpu)
 *   --workers=N                         request exactly N workers through the page's
 *                                       exact-count hook. This does NOT touch the
 *                                       browser's reported processor count, so the
 *                                       run shows both numbers: what the browser
 *                                       said, and the pinned pool that was requested.
 *   --report=N                          mock ONLY window-scope
 *                                       navigator.hardwareConcurrency, which is how a
 *                                       browser that under-reports in window scope is
 *                                       reproduced on a host that reports correctly.
 *                                       A worker's own scope keeps the real value.
 *   --duration=ms                       run time after Start (default 15000)
 *   --browser=chromium|firefox|webkit   default chromium
 *   --channel=NAME                      Playwright browser channel, e.g. `chrome`, to
 *                                       drive an installed browser instead of the
 *                                       bundled one
 *   --executable=PATH                   launch this browser binary (an installed
 *                                       Chromium build that Playwright does not know)
 *   --profile=DIR                       launch with a persistent profile directory.
 *                                       Give it a COPY of a real profile: a live
 *                                       profile is locked by the running browser, and
 *                                       the run writes to whatever directory it uses.
 *   --headed                            show the browser window
 *   --no-software-gl                    do not force SwiftShader; use the browser's
 *                                       own GPU selection (implied by --channel,
 *                                       --executable and --profile)
 *   --keep-visible=false                do NOT ask the browser to keep an occluded or
 *                                       backgrounded window computing. By default the
 *                                       harness passes those flags for Chromium,
 *                                       because a window the compositor has hidden
 *                                       stops the workload (the page stops on
 *                                       visibility change) and the measurement would
 *                                       then be of a hidden tab. Each sample records
 *                                       `document.visibilityState`, so this is always
 *                                       visible in the output rather than assumed.
 *   --stop-at=ms                        click Stop at this elapsed time and verify
 *                                       teardown (workers, bars, idle state)
 *   --steady-after=ms                   samples at/after this elapsed time count as
 *                                       steady state for the utilization verdict
 *                                       (default 5000)
 *   --reduced-motion=true|false         default true (isolates the CPU workload from
 *                                       the visual loop; false exercises combined
 *                                       mode rendering)
 *   --label=name                        output label (default derived from flags)
 *   --keep-quiet                        print only the summary line
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const playwright = require('playwright');
const { startLocalStaticServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const COUNTER = '\\Processor Information(*)\\% Processor Time';

function parseArgs(argv) {
  const options = {
    mode: 'cpu', workers: null, report: null, duration: 15_000, browser: 'chromium',
    channel: null, executable: null, profile: null, headed: false, softwareGl: null,
    keepVisible: true, stopAt: null, steadyAfter: 5000, reducedMotion: true, label: '', keepQuiet: false
  };
  for (const argument of argv) {
    const [flag, raw] = argument.split('=');
    if (raw === undefined) throw new Error(`Expected --flag=value, got ${argument}`);
    switch (flag) {
      case '--mode': options.mode = raw; break;
      case '--workers': options.workers = Number(raw); break;
      case '--report': options.report = Number(raw); break;
      case '--duration': options.duration = Number(raw); break;
      case '--browser': options.browser = raw; break;
      case '--channel': options.channel = raw; break;
      case '--executable': options.executable = raw; break;
      case '--profile': options.profile = raw; break;
      case '--headed': options.headed = raw !== 'false'; break;
      case '--no-software-gl': options.softwareGl = raw === 'false'; break;
      case '--keep-visible': options.keepVisible = raw !== 'false'; break;
      case '--stop-at': options.stopAt = Number(raw); break;
      case '--steady-after': options.steadyAfter = Number(raw); break;
      case '--reduced-motion': options.reducedMotion = raw !== 'false'; break;
      case '--label': options.label = raw; break;
      case '--keep-quiet': options.keepQuiet = raw !== 'false'; break;
      default: throw new Error(`Unknown flag: ${flag}`);
    }
  }
  assert(['cpu', 'gpu', 'both'].includes(options.mode), `Unknown mode ${options.mode}`);
  assert(['chromium', 'firefox', 'webkit'].includes(options.browser), `Unknown browser ${options.browser}`);
  for (const key of ['workers', 'report', 'duration', 'steadyAfter']) {
    if (options[key] !== null && !Number.isFinite(options[key])) throw new Error(`--${key} must be a number`);
  }
  // A real installed browser with its own GPU and extensions is a different test from
  // the pinned software-rendering bundle, so it never silently inherits SwiftShader.
  const realBrowser = Boolean(options.channel || options.executable || options.profile);
  options.softwareGl = options.softwareGl ?? !realBrowser;
  if (options.executable) assert.ok(fs.existsSync(options.executable), `--executable not found: ${options.executable}`);
  return options;
}

/**
 * Starts a PDH sample stream. Rows are read back from the CSV after the run;
 * `stop()` ends the stream early. Values are seconds since `wallStart`.
 */
function startCounterStream(csvPath, durationMs) {
  const sampleIntervalMs = 1000;
  const samples = Math.max(4, Math.ceil(durationMs / sampleIntervalMs) + 8);
  fs.rmSync(csvPath, { force: true });
  const child = spawn('typeperf', [COUNTER, '-si', String(sampleIntervalMs / 1000), '-sc', String(samples),
    '-f', 'csv', '-o', csvPath], { stdio: 'ignore', windowsHide: true });
  const wallStart = Date.now();
  let stopped = false;
  return {
    wallStart,
    stop() {
      if (stopped) return;
      stopped = true;
      child.kill();
    },
    /** Waits for the writer to flush its final rows, then returns parsed samples. */
    async collect() {
      stopped = true;
      if (child.exitCode === null) {
        await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
      }
      await new Promise(resolve => setTimeout(resolve, 700));
      return parseCounterCsv(csvPath, wallStart);
    }
  };
}

function parseCounterCsv(csvPath, wallStart) {
  if (!fs.existsSync(csvPath)) return [];
  const lines = fs.readFileSync(csvPath, 'ascii').split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  // Columns: (PDH-CSV header)(timezone) then one column per instance, e.g.
  // \\HOST\PROCESSOR INFORMATION(0,7)\% PROCESSOR TIME, plus _Total / _MTotal.
  const instances = header.slice(1).map((column, index) => {
    const match = column.match(/\(([^()]+)\)\\%/);
    return { column: index + 1, instance: match ? match[1] : column };
  });
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const at = Date.parse(cells[0].replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2'));
    if (!Number.isFinite(at)) continue;
    const perInstance = new Map();
    let total = null;
    for (const { column, instance } of instances) {
      const raw = cells[column];
      if (raw === undefined) continue;
      const value = Number.parseFloat(raw);
      if (!Number.isFinite(value)) continue;
      // PDH reports machine/socket aggregates alongside the per-thread
      // instances: `(_Total)`, `(_MTotal)` and `(socket,_Total)`. Only a
      // `<socket>,<thread>` instance is one logical processor.
      if (instance === '_Total') total = value;
      else if (/^\d+,\d+$/.test(instance)) perInstance.set(instance, value);
    }
    if (total === null || perInstance.size === 0) continue;
    rows.push({ elapsed: (at - wallStart) / 1000, total, perInstance });
  }
  return rows;
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else current += character;
  }
  cells.push(current.trim());
  return cells;
}

function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
}

/** Distinct readings in sample order, dropping the "not published yet" sentinel. */
function distinctSample(values) {
  return [...new Set(values.filter(value => Number.isFinite(value) && value >= 0))];
}

function summarise(counters, samples, options) {
  const steady = samples.filter(sample => sample.elapsed * 1000 >= options.steadyAfter && sample.state === 'running');
  const steadyCounters = counters.filter(counter => counter.elapsed * 1000 >= options.steadyAfter
    // With --stop-at, the operating-system counters keep being sampled after the
    // page goes idle. Averaging those in reports a stopped machine as half loaded,
    // so the loaded window is what gets summarised, and the tail is reported
    // separately as the teardown check.
    && (options.stopAt === null || counter.elapsed * 1000 < options.stopAt));
  const idleCounters = options.stopAt === null ? []
    : counters.filter(counter => counter.elapsed * 1000 >= options.stopAt + 4000);
  const perInstanceMedians = new Map();
  for (const [instance, _value] of steadyCounters[0]?.perInstance ?? []) {
    perInstanceMedians.set(instance, quantile(steadyCounters.map(row => row.perInstance.get(instance)).filter(Number.isFinite), 0.5));
  }
  const busy = [...perInstanceMedians.values()].filter(value => value !== null);
  const idleLogical = [...perInstanceMedians.entries()]
    .filter(([, median]) => median !== null && median < 80)
    .map(([instance, median]) => `${instance}:${median.toFixed(0)}%`);
  const totalValues = steadyCounters.map(row => row.total);
  const throughput = steady.filter(sample => sample.candidatesPerSecond > 0);
  // Combined mode has a second promise to keep: a full CPU pool must not starve the
  // GPU lane. Frames rendered per second across the steady seconds is that check,
  // read from the page's own cumulative frame counter rather than inferred.
  const renderSteady = steady.filter(sample => sample.renderedFrames >= 0);
  const renderSpan = renderSteady.length > 1 ? renderSteady.at(-1).elapsed - renderSteady[0].elapsed : 0;
  const renderRates = steady.map(sample => sample.renderRate).filter(value => value >= 0);
  const stallSamples = steady.map(sample => sample.callbackStalls).filter(value => value >= 0);
  const poolSizes = [...new Set(samples.map(sample => sample.poolSize).filter(value => value > 0))];
  const requestedPool = poolSizes.at(-1) ?? 0;
  const workerCounts = [...new Set(steady.map(sample => sample.workers))];
  // A fixed pool has exactly one size for the whole run; anything else is a finding,
  // not a rounding detail, so the harness states it instead of averaging it away.
  const firstComplete = samples.find(sample => sample.workers >= requestedPool && requestedPool > 0);
  return {
    sampleCount: samples.length,
    counterSamples: counters.length,
    steadySeconds: steadyCounters.length,
    cpuTotalMean: totalValues.length ? totalValues.reduce((a, b) => a + b, 0) / totalValues.length : null,
    cpuTotalMin: totalValues.length ? Math.min(...totalValues) : null,
    cpuTotalMax: totalValues.length ? Math.max(...totalValues) : null,
    logicalProcessors: busy.length,
    perLogicalMedianMin: quantile(busy, 0),
    perLogicalMedianMax: quantile(busy, 1),
    idleLogicalProcessors: idleLogical,
    candidatesPerSecondMean: throughput.length
      ? throughput.reduce((sum, sample) => sum + sample.candidatesPerSecond, 0) / throughput.length : 0,
    // What the page said and did, kept separate because they are different facts:
    // the browser's two reports, the pool that was sized from them, and the number
    // of workers that were actually running. Samples taken before the plan exists
    // report nothing, which is not a reading of -1 and is not listed.
    pageReports: distinctSample(samples.map(sample => sample.reportPage)),
    workerReports: distinctSample(samples.map(sample => sample.reportWorker)),
    reports: distinctSample(samples.map(sample => sample.report)),
    poolSizes,
    poolSources: [...new Set(samples.map(sample => sample.poolSource).filter(Boolean))],
    limitations: [...new Set(samples.map(sample => sample.poolLimitation).filter(Boolean))],
    steadyWorkerCounts: workerCounts,
    poolStable: workerCounts.length === 1,
    blocksMax: Math.max(0, ...samples.map(sample => sample.blocks)),
    poolCompleteMs: firstComplete ? Math.round(firstComplete.elapsed * 1000) : null,
    visibilityStates: [...new Set(samples.map(sample => sample.visibility))],
    // When the page stopped computing before the harness stopped it. The workload ends
    // on a visibility change, so a run that reads low has to be explainable as a hidden
    // page rather than silently mistaken for a pool that was too small.
    stoppedEarlyMs: (() => {
      const complete = samples.findIndex(sample => sample.workers > 0);
      if (complete < 0) return null;
      const bound = options.stopAt;
      const early = samples.findIndex((sample, index) => index > complete && sample.state !== 'running'
        && (bound === null || sample.elapsed * 1000 < bound));
      return early < 0 ? null : Math.round(samples[early].elapsed * 1000);
    })(),
    // Load after Stop was pressed: the promise is that the machine is released.
    cpuTotalAfterStopMean: idleCounters.length
      ? idleCounters.reduce((sum, row) => sum + row.total, 0) / idleCounters.length : null,
    gpuBackend: samples.at(-1)?.gpuBackend ?? '',
    gpuFramesPerSecond: renderSpan > 0
      ? (renderSteady.at(-1).renderedFrames - renderSteady[0].renderedFrames) / renderSpan : null,
    gpuRenderRateMean: renderRates.length ? renderRates.reduce((a, b) => a + b, 0) / renderRates.length : null,
    // Highest count of stalled rendering callbacks seen, i.e. times the page failed
    // to get a frame callback at all while the CPU pool was running.
    callbackStallsMax: stallSamples.length ? Math.max(...stallSamples) : null
  };
}

async function openBrowser(options) {
  const launch = { headless: !options.headed };
  if (options.browser === 'chromium') {
    if (options.channel) launch.channel = options.channel;
    if (options.executable) launch.executablePath = options.executable;
    const args = [];
    if (options.softwareGl) args.push('--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader');
    // A window the compositor considers hidden makes the page stop its workload (the
    // controller stops on visibility change), which would measure a hidden tab rather
    // than the pool. Each sample still records the real visibility state.
    if (options.keepVisible) {
      args.push('--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling');
    }
    if (args.length) launch.args = args;
  }
  if (!options.profile) {
    return { browser: await playwright[options.browser].launch(launch) };
  }
  // A persistent profile is the only way to run the browser with the extensions and
  // settings of the installation being investigated. It returns a context, not a
  // browser, so the caller owns whichever handle comes back.
  const context = await playwright[options.browser].launchPersistentContext(options.profile, launch);
  return { context };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const label = options.label || [options.mode,
    options.workers ? `workers${options.workers}` : '',
    options.report ? `report${options.report}` : '',
    options.channel || (options.executable ? path.basename(options.executable) : '')].filter(Boolean).join('-');
  const baseUrl = process.env.LOAD_HARNESS_URL || 'http://127.0.0.1:4191';
  const server = await startLocalStaticServer({ url: baseUrl, cwd: ROOT, skip: Boolean(process.env.LOAD_HARNESS_URL) });
  const url = server?.url || baseUrl;
  const outputDir = path.join(ROOT, 'output', 'stress-load');
  fs.mkdirSync(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, `${label}.csv`);

  const { browser, context: ownedContext } = await openBrowser(options);
  const context = ownedContext ?? await browser.newContext({
    viewport: { width: 1280, height: 800 }, reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference'
  });
  const pageErrors = [];
  await context.addInitScript(({ workers, report }) => {
    if (report !== null) Object.defineProperty(navigator, 'hardwareConcurrency', { value: report, configurable: true });
    // The exact-count hook is a request for N workers and nothing else: it does not
    // change what the browser reports, so the run still shows the real report next to
    // the pool it was forced to.
    if (workers !== null) window.__OD_STRESS_TEST_WORKERS__ = workers;
  }, { workers: options.workers, report: options.report });
  const page = context.pages().length ? context.pages()[0] : await context.newPage();
  if (ownedContext) await page.setViewportSize({ width: 1280, height: 800 });
  page.on('pageerror', error => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`); });

  await page.goto(`${url}/pages/utilities/index.html#stress-test`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#stressTestApp[data-stress-state="idle"]', { timeout: 30_000 });
  // The idle dataset is in the static HTML, so it does not prove the controller has
  // booted; clicking before it binds its handlers is a click into the void. Wait for
  // the first metric frame, which only the controller publishes.
  await page.waitForFunction(() => document.getElementById('stressTestApp')?.dataset.stressTotalRenderedFrames !== undefined,
    null, { timeout: 30_000 });
  await page.click(`[data-stress-mode-option="${options.mode}"]`);
  // What this browser's own scopes report, read before Start, with nothing mocked
  // beyond the flags above: the ground truth the pool's numbers are compared against.
  const scopeReports = await page.evaluate(() => ({
    page: navigator.hardwareConcurrency ?? null,
    userAgent: navigator.userAgent,
    deviceMemory: navigator.deviceMemory ?? null
  }));

  const counters = startCounterStream(csvPath, options.duration);
  const countersWallStart = counters.wallStart;
  await page.click('#stressStartBtn');
  const startedAt = Date.now();
  const samples = [];
  const deadline = startedAt + options.duration;
  let stopped = false;
  while (Date.now() < deadline) {
    const elapsed = (Date.now() - startedAt) / 1000;
    const state = await page.evaluate(() => {
      const root = document.getElementById('stressTestApp');
      const data = root.dataset;
      return {
        state: data.stressState,
        // Whether the browser considers this page visible. The workload stops when it
        // is not, so a low-load run has to be explainable as a hidden page or as a
        // pool that was too small — never silently one or the other.
        visibility: document.visibilityState,
        workers: Number(data.stressWorkerCount ?? '0'),
        candidatesPerSecond: Number(data.stressCandidatesPerSecond ?? '0'),
        candidates: Number(data.stressCandidates ?? '0'),
        primesFound: Number(data.stressPrimesFound ?? '0'),
        latestPrime: Number(data.stressLatestPrime ?? '0'),
        gpuBackend: data.stressGpuBackend ?? '',
        renderedFrames: Number(data.stressTotalRenderedFrames ?? '-1'),
        renderRate: Number(data.stressRenderRate ?? '-1'),
        callbackStalls: Number(data.stressCallbackStalls ?? '-1'),
        reportPage: Number(data.stressCpuReportPage ?? '-1'),
        reportWorker: Number(data.stressCpuReportWorker ?? '-1'),
        report: Number(data.stressCpuReport ?? '-1'),
        poolSize: Number(data.stressCpuPoolSize ?? '0'),
        poolSource: data.stressCpuPoolSource ?? '',
        poolLimitation: data.stressCpuPoolLimitation ?? '',
        blocks: Number(data.stressCpuBlocks ?? '0'),
        bars: document.querySelectorAll('#stressWorkerActivity > span').length
      };
    });
    samples.push({ elapsed, ...state });
    if (options.stopAt !== null && !stopped && elapsed * 1000 >= options.stopAt) {
      stopped = true;
      await page.click('#stressStopBtn');
      await page.waitForSelector('#stressTestApp[data-stress-state="idle"]', { timeout: 15_000 });
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  if (!stopped) {
    await page.click('#stressStopBtn');
    await page.waitForSelector('#stressTestApp[data-stress-state="idle"]', { timeout: 15_000 });
  }
  const teardown = await page.evaluate(() => ({
    bars: document.querySelectorAll('#stressWorkerActivity > span').length,
    workers: Number(document.getElementById('stressTestApp').dataset.stressWorkerCount ?? '-1'),
    poolSize: document.getElementById('stressTestApp').dataset.stressCpuPoolSize ?? null
  }));
  counters.stop();
  const counterRows = await counters.collect();
  if (ownedContext) await ownedContext.close();
  else await browser.close();
  server?.kill();

  // Counter rows share the wall clock with the page samples: rebase them onto
  // elapsed time since Start (the stream began a moment before the click).
  const rebased = counterRows.map(row => ({ ...row, elapsed: row.elapsed + (countersWallStart - startedAt) / 1000 }));
  const summary = summarise(rebased, samples, options);
  const result = {
    label, options, url,
    startedAt: new Date(startedAt).toISOString(),
    // Operating-system ground truth, for comparison with what the browser reported.
    // It is context for reading the run, never an input to the page.
    host: { oscpus: os.cpus().length, availableParallelism: os.availableParallelism?.() ?? null,
      model: os.cpus()[0]?.model ?? '' },
    scopeReports,
    teardown,
    pageErrors,
    samples,
    counters: rebased.map(row => ({
      elapsed: Number(row.elapsed.toFixed(1)),
      total: Number(row.total.toFixed(1)),
      min: Math.min(...row.perInstance.values()).toFixed(0),
      max: Math.max(...row.perInstance.values()).toFixed(0),
      idle: [...row.perInstance.values()].filter(value => value < 50).length,
      logical: row.perInstance.size
    })),
    summary
  };
  const jsonPath = path.join(outputDir, `${label}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  console.log(`Harness: ${label} (${options.browser}${options.channel ? `/${options.channel}` : ''}`
    + `${options.executable ? `/${path.basename(options.executable)}` : ''}, mode=${options.mode}, `
    + `${options.workers ? `exact ${options.workers} workers` : 'automatic sizing'}`
    + `${options.report ? `, window report mocked to ${options.report}` : ', window report unmocked'})`);
  console.log(`  host: ${result.host.model.trim()} · os.cpus() ${result.host.oscpus} · `
    + `availableParallelism() ${result.host.availableParallelism} · browser page scope ${scopeReports.page}`);
  console.log(`  page plan: window report ${summary.pageReports.join('/')} · worker report ${summary.workerReports.join('/')} `
    + `→ sized from ${summary.reports.join('/')} (${summary.poolSources.join('/')}) · pool ${summary.poolSizes.join('/')}`);
  console.log(`  steady-state OS CPU (_Total): mean ${summary.cpuTotalMean?.toFixed(1)}% `
    + `min ${summary.cpuTotalMin?.toFixed(1)}% max ${summary.cpuTotalMax?.toFixed(1)}% over ${summary.steadySeconds} samples`);
  console.log(`  per-logical-processor medians: min ${summary.perLogicalMedianMin?.toFixed(0)}% `
    + `max ${summary.perLogicalMedianMax?.toFixed(0)}% across ${summary.logicalProcessors} logical processors`);
  console.log(`  idle logical processors (<80% median): ${summary.idleLogicalProcessors.length ? summary.idleLogicalProcessors.join(' ') : 'none'}`);
  if (summary.cpuTotalAfterStopMean !== null) {
    console.log(`  OS CPU after Stop (≥4 s later): mean ${summary.cpuTotalAfterStopMean.toFixed(1)}% — the machine must be released`);
  }
  console.log(`  page: workers ${summary.steadyWorkerCounts.join('/')} `
    + `(${summary.poolStable ? 'stable' : 'CHANGED DURING RUN'}) · pool complete at `
    + `${summary.poolCompleteMs ?? 'n/a'} ms · ${summary.blocksMax} blocks searched`);
  console.log(`  page visibility: ${summary.visibilityStates.join('/')}`
    + (summary.stoppedEarlyMs === null ? ''
      : ` · the workload ENDED ON ITS OWN at ${summary.stoppedEarlyMs} ms — the load above is not a full-run measurement`));
  console.log(`  throughput: ${Math.round(summary.candidatesPerSecondMean).toLocaleString()} candidates/s steady`);
  if (summary.limitations.length) console.log(`  pool limitation published: ${summary.limitations.join(' | ')}`);
  if (summary.gpuBackend && summary.gpuBackend !== 'none') {
    // The CPU pool is only allowed to be this big if the GPU lane still renders.
    console.log(`  gpu: backend ${summary.gpuBackend} · ${summary.gpuFramesPerSecond?.toFixed(1) ?? 'n/a'} frames/s steady `
      + `· render rate ${summary.gpuRenderRateMean?.toFixed(1) ?? 'n/a'}/s · callback stalls ${summary.callbackStallsMax ?? 'n/a'}`);
  }
  console.log(`  teardown: state idle, ${teardown.bars} bars, worker count ${teardown.workers}, `
    + `pool dataset ${teardown.poolSize ?? 'cleared'}`);
  console.log(`  page errors: ${pageErrors.length ? pageErrors.join(' | ') : 'none'}`);
  console.log(`  detail: ${path.relative(ROOT, jsonPath)} (+ ${path.relative(ROOT, csvPath)})`);
  if (!options.keepQuiet) {
    console.log('  counters: ' + result.counters.map(row => `${row.elapsed.toFixed(0)}s:${row.total}%`).join(' '));
  }
  if (summary.idleLogicalProcessors.length > 0 || (summary.cpuTotalMean ?? 0) < 95) {
    console.log('  RESULT: NOT FULLY LOADED — investigate idle capacity above.');
  } else {
    console.log('  RESULT: fully loaded (≥95% aggregate, no persistently idle logical processor).');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
