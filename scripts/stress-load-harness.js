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
 *   node scripts/stress-load-harness.js --mode=cpu --pin=32 --duration=15000
 *   node scripts/stress-load-harness.js --mode=cpu --report=12 --duration=45000
 *   node scripts/stress-load-harness.js --mode=both --report=1 --duration=60000 --browser=firefox
 *
 * Flags:
 *   --mode=cpu|gpu|both                 UI mode selected before Start (default cpu)
 *   --pin=N                             request exactly N workers through the page's
 *                                       test hooks (exact request AND ceiling), and
 *                                       report N as the browser's logical-processor
 *                                       count. Diagnostics only: the pool is pinned.
 *   --report=N                          mock ONLY navigator.hardwareConcurrency, so
 *                                       the page's automatic policy must reach full
 *                                       load from a wrong hint. Never pass the real
 *                                       host count here unless that is the point.
 *   --duration=ms                       run time after Start (default 15000)
 *   --browser=chromium|firefox|webkit   default chromium
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
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const playwright = require('playwright');
const { startLocalStaticServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const COUNTER = '\\Processor Information(*)\\% Processor Time';

function parseArgs(argv) {
  const options = {
    mode: 'cpu', pin: null, report: null, duration: 15_000, browser: 'chromium',
    stopAt: null, steadyAfter: 5000, reducedMotion: true, label: '', keepQuiet: false
  };
  for (const argument of argv) {
    const [flag, raw] = argument.split('=');
    if (raw === undefined) throw new Error(`Expected --flag=value, got ${argument}`);
    switch (flag) {
      case '--mode': options.mode = raw; break;
      case '--pin': options.pin = Number(raw); break;
      case '--report': options.report = Number(raw); break;
      case '--duration': options.duration = Number(raw); break;
      case '--browser': options.browser = raw; break;
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
  assert(!options.pin || !options.report, '--pin and --report are mutually exclusive (pinning is not an automatic run)');
  for (const key of ['pin', 'report', 'duration', 'steadyAfter']) {
    if (options[key] !== null && !Number.isFinite(options[key])) throw new Error(`--${key} must be a number`);
  }
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

function summarise(counters, samples, options) {
  const finalWorkers = samples.reduce((best, sample) => Math.max(best, sample.workers), 0);
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
  // Combined mode has a second promise to keep: a big CPU pool must not starve the
  // GPU lane. Frames rendered per second across the steady seconds is that check,
  // read from the page's own cumulative frame counter rather than inferred.
  const renderSteady = steady.filter(sample => sample.renderedFrames >= 0);
  const renderSpan = renderSteady.length > 1 ? renderSteady.at(-1).elapsed - renderSteady[0].elapsed : 0;
  const renderRates = steady.map(sample => sample.renderRate).filter(value => value >= 0);
  const stallSamples = steady.map(sample => sample.callbackStalls).filter(value => value >= 0);
  return {
    finalWorkers,
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
    steadyWorkerCounts: [...new Set(steady.map(sample => sample.workers))],
    // Load after Stop was pressed: the promise is that the machine is released.
    cpuTotalAfterStopMean: idleCounters.length
      ? idleCounters.reduce((sum, row) => sum + row.total, 0) / idleCounters.length : null,
    gpuBackend: samples.at(-1)?.gpuBackend ?? '',
    gpuFramesPerSecond: renderSpan > 0
      ? (renderSteady.at(-1).renderedFrames - renderSteady[0].renderedFrames) / renderSpan : null,
    gpuRenderRateMean: renderRates.length ? renderRates.reduce((a, b) => a + b, 0) / renderRates.length : null,
    // Highest count of stalled rendering callbacks seen, i.e. times the page failed
    // to get a frame callback at all while the CPU pool was running.
    callbackStallsMax: stallSamples.length ? Math.max(...stallSamples) : null,
    // First time the pool reached its largest observed size, and when the page's
    // own pool verdict said it was done growing.
    growToFullLoadMs: samples.find(sample => sample.workers >= finalWorkers)?.elapsed ? Math.round(samples.find(sample => sample.workers >= finalWorkers).elapsed * 1000) : null,
    poolVerdicts: samples.map(sample => sample.pool).filter((value, index, all) => value !== all[index - 1])
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const label = options.label || `${options.mode}-${options.pin ? `pin${options.pin}` : `report${options.report ?? 'auto'}`}`;
  const baseUrl = process.env.LOAD_HARNESS_URL || 'http://127.0.0.1:4191';
  const server = await startLocalStaticServer({ url: baseUrl, cwd: ROOT, skip: Boolean(process.env.LOAD_HARNESS_URL) });
  const url = server?.url || baseUrl;
  const outputDir = path.join(ROOT, 'output', 'stress-load');
  fs.mkdirSync(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, `${label}.csv`);

  const launch = { headless: true };
  if (options.browser === 'chromium') {
    launch.args = ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'];
  }
  const browser = await playwright[options.browser].launch(launch);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference' });
  const pageErrors = [];
  await context.addInitScript(({ pin, report }) => {
    if (report !== null) Object.defineProperty(navigator, 'hardwareConcurrency', { value: report, configurable: true });
    if (pin !== null) {
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: pin, configurable: true });
      // Exact request and ceiling: understood by the current worker policy, and
      // the legacy build's cap hook pins the same count for before/after runs.
      window.__OD_STRESS_TEST_WORKERS__ = pin;
      window.__OD_STRESS_TEST_MAX_WORKERS__ = pin;
    }
  }, { pin: options.pin, report: options.report });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`); });

  await page.goto(`${url}/pages/utilities/index.html#stress-test`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#stressTestApp[data-stress-state="idle"]', { timeout: 30_000 });
  await page.click(`[data-stress-mode-option="${options.mode}"]`);

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
        workers: Number(data.stressWorkerCount ?? '0'),
        candidatesPerSecond: Number(data.stressCandidatesPerSecond ?? '0'),
        candidates: Number(data.stressCandidates ?? '0'),
        primesFound: Number(data.stressPrimesFound ?? '0'),
        latestPrime: Number(data.stressLatestPrime ?? '0'),
        gpuBackend: data.stressGpuBackend ?? '',
        renderedFrames: Number(data.stressTotalRenderedFrames ?? '-1'),
        renderRate: Number(data.stressRenderRate ?? '-1'),
        callbackStalls: Number(data.stressCallbackStalls ?? '-1'),
        reported: Number(data.stressCpuReported ?? '-1'),
        pool: data.stressCpuPool ?? '',
        poolLimitation: data.stressCpuPoolLimitation ?? '',
        busy: Number(data.stressCpuBusy ?? '-1'),
        sliceSlow: Number(data.stressCpuSliceSlow ?? '-1'),
        bandWait: Number(data.stressCpuBandWait ?? '-1'),
        windows: data.stressCpuPoolWindows ?? '[]',
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

  // The page publishes the growth rule's own measurement windows. The page keeps
  // only a bounded history, so the harness collects them on every sample and
  // merges them: the whole run's decisions must be auditable after the fact.
  const windowTrace = [...new Map(samples.flatMap(sample => {
    try {
      return JSON.parse(sample.windows).map(window => [window.at, window]);
    } catch (_error) {
      return [];
    }
  })).values()].sort((a, b) => a.at - b.at);

  if (!stopped) {
    await page.click('#stressStopBtn');
    await page.waitForSelector('#stressTestApp[data-stress-state="idle"]', { timeout: 15_000 });
  }
  const teardown = await page.evaluate(() => ({
    bars: document.querySelectorAll('#stressWorkerActivity > span').length,
    workers: Number(document.getElementById('stressTestApp').dataset.stressWorkerCount ?? '-1')
  }));
  counters.stop();
  const counterRows = await counters.collect();
  await browser.close();
  server?.kill();

  // Counter rows share the wall clock with the page samples: rebase them onto
  // elapsed time since Start (the stream began a moment before the click).
  const rebased = counterRows.map(row => ({ ...row, elapsed: row.elapsed + (countersWallStart - startedAt) / 1000 }));
  const summary = summarise(rebased, samples, options);
  const result = {
    label, options, url,
    startedAt: new Date(startedAt).toISOString(),
    teardown,
    pageErrors,
    // The window strings are merged into `windowTrace`; per-sample copies are noise.
    samples: samples.map(({ windows: _windows, ...rest }) => rest),
    windowTrace,
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

  console.log(`Harness: ${label} (${options.browser}, mode=${options.mode}, `
    + `${options.pin ? `pinned ${options.pin}` : `report hint ${options.report ?? 'unmocked'}`})`);
  console.log(`  steady-state OS CPU (_Total): mean ${summary.cpuTotalMean?.toFixed(1)}% `
    + `min ${summary.cpuTotalMin?.toFixed(1)}% max ${summary.cpuTotalMax?.toFixed(1)}% over ${summary.steadySeconds} samples`);
  console.log(`  per-logical-processor medians: min ${summary.perLogicalMedianMin?.toFixed(0)}% `
    + `max ${summary.perLogicalMedianMax?.toFixed(0)}% across ${summary.logicalProcessors} logical processors`);
  console.log(`  idle logical processors (<80% median): ${summary.idleLogicalProcessors.length ? summary.idleLogicalProcessors.join(' ') : 'none'}`);
  if (summary.cpuTotalAfterStopMean !== null) {
    console.log(`  OS CPU after Stop (≥4 s later): mean ${summary.cpuTotalAfterStopMean.toFixed(1)}% — the machine must be released`);
  }
  console.log(`  page: workers ${summary.steadyWorkerCounts.join('/')} · ${Math.round(summary.candidatesPerSecondMean).toLocaleString()} candidates/s steady`);
  if (summary.gpuBackend && summary.gpuBackend !== 'none') {
    // The CPU pool is only allowed to be this big if the GPU lane still renders.
    console.log(`  gpu: backend ${summary.gpuBackend} · ${summary.gpuFramesPerSecond?.toFixed(1) ?? 'n/a'} frames/s steady `
      + `· render rate ${summary.gpuRenderRateMean?.toFixed(1) ?? 'n/a'}/s · callback stalls ${summary.callbackStallsMax ?? 'n/a'}`);
  }
  console.log(`  growth verdicts: ${summary.poolVerdicts.join(' → ') || 'none'} (full pool at ${summary.growToFullLoadMs ?? 'n/a'} ms)`);
  const busySteady = samples.filter(sample => sample.elapsed * 1000 >= options.steadyAfter && sample.state === 'running');
  if (busySteady.length) {
    const busyValues = busySteady.map(sample => sample.busy).filter(value => value >= 0);
    const slowValues = busySteady.map(sample => sample.sliceSlow).filter(value => value >= 0);
    const bandValues = busySteady.map(sample => sample.bandWait).filter(value => value >= 0);
    console.log(`  pool duty cycle (page-measured, audit only): mean ${Math.round(busyValues.reduce((a, b) => a + b, 0) / busyValues.length)}% `
      + `min ${Math.min(...busyValues)}% max ${Math.max(...busyValues)}% `
      + `(sieving time over sieving plus waiting-to-run; not a growth input — it stays at 100% even at 8× oversubscription)`);
    if (bandValues.length) {
      console.log(`  waiting for integers to sieve: mean `
        + `${Math.round(bandValues.reduce((a, b) => a + b, 0) / bandValues.length)}% (page-side supply, not machine load)`);
    }
    if (slowValues.length) {
      // The share the growth rule actually decides on, printed from outside so the
      // threshold can be checked against a real machine rather than asserted.
      console.log(`  mid-slice preemption share (growth rule input): mean ${Math.round(slowValues.reduce((a, b) => a + b, 0) / slowValues.length)}% `
        + `min ${Math.min(...slowValues)}% max ${Math.max(...slowValues)}% `
        + `(slices descheduled while running)`);
    }
  }
  if (windowTrace.length) {
    console.log('  growth windows (what the pool measured, as the decision saw it):');
    for (const window of windowTrace) {
      console.log(`    ${String(window.at).padStart(7)}ms ${String(window.workers).padStart(4)} workers `
        + `${String(Math.round(window.rate * 1000).toLocaleString('en-US')).padStart(17)} cand/s `
        + `${window.duty === null ? '   duty n/a' : `duty ${(window.duty * 100).toFixed(1).padStart(5)}%`} `
        + `${String(window.slices).padStart(7)} slices `
        + `${window.slowShare === null ? '     n/a' : `${(window.slowShare * 100).toFixed(1).padStart(6)}%`} `
        + `${window.gain === null ? '   baseline' : `${(window.gain * 100).toFixed(1).padStart(9)}%`}  → ${window.action}`);
    }
  }
  console.log(`  teardown: state idle, ${teardown.bars} bars, worker count ${teardown.workers}`);
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
