#!/usr/bin/env node

// Measures browser callbacks and main-thread rendering work, not physical display
// presentation. No frame-rate overrides, CPU throttling or user-profile changes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const BASE_URL = process.env.YAHTZEE_PERF_URL || 'http://127.0.0.1:4198';
const LABEL = process.env.YAHTZEE_PERF_LABEL || 'baseline';
if (!/^[a-zA-Z0-9_-]+$/.test(LABEL)) throw new Error('Use letters, digits, underscores or hyphens in YAHTZEE_PERF_LABEL');
const OUTPUT = path.join(ROOT, 'output', 'yahtzee-motion-perf', LABEL);
const ROLLS = Number(process.env.YAHTZEE_PERF_ROLLS || 9);
if (!Number.isInteger(ROLLS) || ROLLS < 1 || ROLLS > 100) throw new Error('YAHTZEE_PERF_ROLLS must be an integer from 1 to 100');
const APP = '#yahtzeeKeiriApp';

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null;
  return { count: sorted.length, minMs: sorted[0] ?? null, medianMs: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.at(-1) ?? null, meanMs: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null };
}

function analyzeTrace(events) {
  const marks = events.filter(event => event.cat?.includes('blink.user_timing') && /^yahtzee-roll:\d+:(input|start|end)$/.test(event.name));
  const rounds = new Map();
  for (const mark of marks) {
    const [, number, stage] = mark.name.split(':');
    if (!rounds.has(number)) rounds.set(number, {});
    rounds.get(number)[stage] = mark.ts;
  }
  const main = marks[0];
  const relevant = new Set(['Layout', 'UpdateLayoutTree', 'Paint', 'PrePaint', 'CompositeLayers', 'Layerize', 'EventDispatch']);
  function aggregate(start, end) {
    const result = {};
    for (const event of events) {
      if (!main || event.pid !== main.pid || event.tid !== main.tid || event.ph !== 'X' || !relevant.has(event.name)) continue;
      const overlap = Math.max(0, Math.min(event.ts + (event.dur || 0), end) - Math.max(event.ts, start));
      if (!overlap) continue;
      const entry = result[event.name] ||= { count: 0, totalMs: 0, longestMs: 0 };
      entry.count++;
      entry.totalMs += overlap / 1000;
      entry.longestMs = Math.max(entry.longestMs, overlap / 1000);
    }
    return result;
  }
  const rolling = [...rounds.entries()].filter(([, times]) => times.input && times.start && times.end).map(([roll, times]) => ({
    roll: Number(roll), inputToMotionMarkMs: (times.start - times.input) / 1000,
    motionMs: (times.end - times.start) / 1000,
    inputBurst: aggregate(times.input, times.start),
    motionFromObserverStartToEnd: aggregate(times.start, times.end),
    settlement: aggregate(times.end, times.end + 50000),
    fullRollIncludingSettlement: aggregate(times.input, times.end + 50000),
    // Excludes first/last50ms of setup/settlement to isolate steady motion work.
    steadyMotion: aggregate(times.start + 50000, times.end - 50000)
  }));
  const animationIds = new Map();
  const animationDiagnostics = [];
  for (const event of events.filter(event => event.name === 'Animation').sort((a, b) => a.ts - b.ts)) {
    const key = `${event.pid}:${event.id2?.local}`;
    if (event.ph === 'b') animationIds.set(key, event.args?.data);
    const data = event.args?.data;
    if (data && typeof data.compositeFailed === 'number') animationDiagnostics.push({
      property: animationIds.get(key)?.displayName || 'unnamed',
      node: animationIds.get(key)?.nodeName || 'unknown',
      compositeFailed: data.compositeFailed, unsupportedProperties: data.unsupportedProperties || []
    });
  }
  const statusCounts = {};
  for (const diagnostic of animationDiagnostics) {
    const key = `${diagnostic.property}:${diagnostic.compositeFailed === 0 ? 'accelerated' : 'not-accelerated'}`;
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }
  const failures = animationDiagnostics.filter(diagnostic => diagnostic.compositeFailed !== 0);
  const motionTimes = [...rounds.values()].filter(times => times.start && times.end);
  const insideMotion = time => motionTimes.some(times => time >= times.start && time <= times.end);
  const draws = events.filter(event => event.name === 'DrawFrame' && event.pid === main?.pid && insideMotion(event.ts));
  const drawGroups = new Map();
  for (const event of draws) {
    const key = `${event.pid}:${event.tid}:${event.args?.layerTreeId}`;
    if (!drawGroups.has(key)) drawGroups.set(key, []);
    drawGroups.get(key).push(event.ts);
  }
  const drawCadence = [...drawGroups.entries()].map(([threadAndLayerTree, times]) => {
    const intervals = [];
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      if (motionTimes.some(window => times[i - 1] >= window.start && times[i] <= window.end)) intervals.push((times[i] - times[i - 1]) / 1000);
    }
    return { threadAndLayerTree, draws: times.length, intervals: distribution(intervals) };
  });
  const reportedFrames = new Map();
  for (const event of events) {
    const reporter = event.args?.frame_reporter;
    if (event.name !== 'PipelineReporter' || !reporter || reporter.frame_type === 'FORKED' || event.pid !== main?.pid || !insideMotion(event.ts)) continue;
    reportedFrames.set(`${reporter.frame_source}:${reporter.frame_sequence}:${reporter.layer_tree_host_id}`, reporter.state);
  }
  const pipelineStates = {};
  for (const state of reportedFrames.values()) pipelineStates[state] = (pipelineStates[state] || 0) + 1;
  return { mainThread: main ? { pid: main.pid, tid: main.tid } : null, rolls: rolling,
    compositing: { statusEventCounts: statusCounts, scriptedOrTransformFailureEvents: failures.filter(event => event.property === 'transform' || event.property === 'unnamed'), otherFailureEventCount: failures.filter(event => event.property !== 'transform' && event.property !== 'unnamed').length, otherFailureExamples: failures.filter(event => event.property !== 'transform' && event.property !== 'unnamed').slice(0, 10), note: 'Status events can repeat for one animation. Counts are diagnostic events, not unique animation counts. Unnamed scripted animations are included in the transform failure bucket; sampled keyframes identify their actual properties.' },
    compositorCadence: { drawCadence, pipelineStates, note: 'DrawFrame is renderer compositor work. PipelineReporter states describe Chromium internal presentation to its output surface; headless output does not prove physical display refresh or 120 presented fps. DrawFrame gaps can indicate unchanged output (NO_UPDATE_DESIRED), not missed deadlines.' },
    caveat: 'Durations overlap across nested rendering categories; do not sum categories as total CPU time. Marks are MutationObserver delivery times, not physical frame presentation. Full-roll rendering includes 50 ms after the settlement mutation. RAF sampling and Playwright RAF polling wake the main thread; both comparison runs use this same instrumentation, so style-event counts are not an uninstrumented compositor-only workload.' };
}

function directMutations(observation) {
  return observation.transitions.filter(event => event.stage === 'start').map(start => {
    const end = observation.transitions.find(event => event.roll === start.roll && event.stage === 'end');
    const mutations = observation.mutations.filter(event => event.roll === start.roll && event.time >= start.time - .1 && event.time <= (end?.time ?? start.time) + 1);
    return { roll: start.roll, added: mutations.reduce((sum, event) => sum + event.addedDirectNodes, 0), removed: mutations.reduce((sum, event) => sum + event.removedDirectNodes, 0) };
  });
}

function concise(summary) {
  const rolls = summary.traceAnalysis.rolls;
  const average = (phase, name, field) => rolls.reduce((sum, roll) => sum + (roll[phase]?.[name]?.[field] || 0), 0) / rolls.length;
  return {
    rolls: rolls.length, inputToMotionMarkMs: distribution(rolls.map(roll => roll.inputToMotionMarkMs)),
    meanSteadyStyleEventsPerRoll: average('steadyMotion', 'UpdateLayoutTree', 'count'),
    meanSteadyStyleMsPerRoll: average('steadyMotion', 'UpdateLayoutTree', 'totalMs'),
    meanSteadyLayoutEventsPerRoll: average('steadyMotion', 'Layout', 'count'),
    meanSteadyPaintEventsPerRoll: average('steadyMotion', 'Paint', 'count'),
    meanFullRollPaintEvents: average('fullRollIncludingSettlement', 'Paint', 'count'),
    meanFullRollPaintMs: average('fullRollIncludingSettlement', 'Paint', 'totalMs'),
    meanDirectNodesAddedPerRoll: summary.domMutations?.reduce((sum, roll) => sum + roll.added, 0) / (summary.domMutations?.length || 1),
    meanDirectNodesRemovedPerRoll: summary.domMutations?.reduce((sum, roll) => sum + roll.removed, 0) / (summary.domMutations?.length || 1),
    rafDuringMotion: summary.rafDuringMotion,
    compositorCadence: summary.traceAnalysis.compositorCadence,
    compositing: summary.traceAnalysis.compositing, longTaskCount: summary.longTasks.length
  };

}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const browser = await chromium.launch({ headless: process.env.YAHTZEE_PERF_HEADED !== '1', timeout: 30000 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let cdp;
  try {
    await page.goto(`${BASE_URL}/pages/utilities/index.html#yahtzee-keiri`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#yahtzeeKeiriApp')?.dataset.engineState === 'ready', null, { timeout: 60000 });
    cdp = await context.newCDPSession(page);
    await cdp.send('LayerTree.enable');
    let latestLayers = [];
    let layerChanges = 0;
    cdp.on('LayerTree.layerTreeDidChange', event => { latestLayers = event.layers || []; layerChanges++; });
    await page.locator(`${APP} [data-roll]`).click();
    await page.waitForTimeout(100);
    const activeGeometry = await page.locator(APP).evaluate(root => ({
      rolling: root.dataset.rolling,
      cubeSides: root.querySelectorAll('.yahtzee-cube-side').length,
      cubePips: root.querySelectorAll('.yahtzee-cube-pip').length,
      animations: root.getAnimations({ subtree: true }).filter(animation => !('transitionProperty' in animation) && !('animationName' in animation)).map(animation => ({
        target: animation.effect?.target?.className, timing: animation.effect?.getTiming(), keyframes: animation.effect?.getKeyframes().map(frame => ({ offset: frame.offset, easing: frame.easing, transform: frame.transform, opacity: frame.opacity }))
      }))
    }));
    const layers = await Promise.all(latestLayers.map(async layer => ({
      layerId: layer.layerId, backendNodeId: layer.backendNodeId, drawsContent: layer.drawsContent,
      width: layer.width, height: layer.height,
      ...await cdp.send('LayerTree.compositingReasons', { layerId: layer.layerId }).catch(error => ({ error: error.message }))
    })));
    await page.waitForFunction(() => document.querySelector('#yahtzeeKeiriApp')?.dataset.rolling !== 'true');
    await page.locator(`${APP} [data-reset-game]`).click();
    await page.evaluate(() => {
      const root = document.querySelector('#yahtzeeKeiriApp');
      const probe = window.__yahtzeeMotionProbe = { raf: [], idleRaf: [], transitions: [], mutations: [], longTasks: [], active: true, rolling: false, roll: 0 };
      let previous;
      function frame(time) {
        if (previous !== undefined) (probe.rolling ? probe.raf : probe.idleRaf).push({ delta: time - previous, roll: probe.roll });
        previous = time;
        if (probe.active) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
      document.addEventListener('click', event => {
        if (event.target.closest('[data-roll]')) {
          probe.roll++;
          performance.mark(`yahtzee-roll:${probe.roll}:input`);
        }
      }, true);
      new MutationObserver(records => {
        const rolling = root.dataset.rolling === 'true';
        if (rolling !== probe.rolling) {
          probe.rolling = rolling;
          const stage = rolling ? 'start' : 'end';
          performance.mark(`yahtzee-roll:${probe.roll}:${stage}`);
          probe.transitions.push({ roll: probe.roll, stage, time: performance.now() });
        }
        let added = 0; let removed = 0;
        for (const record of records) if (record.type === 'childList') { added += record.addedNodes.length; removed += record.removedNodes.length; }
        if (added || removed) probe.mutations.push({ roll: probe.roll, time: performance.now(), addedDirectNodes: added, removedDirectNodes: removed });
      }).observe(root, { attributes: true, attributeFilter: ['data-rolling'], childList: true, subtree: true });
      new PerformanceObserver(list => probe.longTasks.push(...list.getEntries().map(entry => ({ startMs: entry.startTime, durationMs: entry.duration })))).observe({ type: 'longtask', buffered: false });
    });
    const trace = [];
    cdp.on('Tracing.dataCollected', event => trace.push(...event.value));
    const finished = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,cc,blink.animations,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame', transferMode: 'ReportEvents' });
    await page.waitForTimeout(1000);
    for (let index = 0; index < ROLLS; index++) {
      if (index && index % 3 === 0) await page.locator(`${APP} [data-reset-game]`).click();
      await page.locator(`${APP} [data-roll]`).click();
      await page.waitForFunction(() => document.querySelector('#yahtzeeKeiriApp')?.dataset.rolling !== 'true');
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(200);
    const observation = await page.evaluate(() => { window.__yahtzeeMotionProbe.active = false; return window.__yahtzeeMotionProbe; });
    await cdp.send('Tracing.end');
    await finished;
    const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, devicePixelRatio, screen: { width: screen.width, height: screen.height }, viewport: { width: innerWidth, height: innerHeight }, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }));
    const assets = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => /yahtzeeController|utilities-app.*\.js/.test(entry.name)).map(entry => entry.name));
    const assetHashes = await Promise.all(assets.map(async url => ({ url, sha256: crypto.createHash('sha256').update(Buffer.from(await (await context.request.get(url)).body())).digest('hex') })));
    const summary = {
      label: LABEL, createdAt: new Date().toISOString(), browserVersion: browser.version(), headed: process.env.YAHTZEE_PERF_HEADED === '1', environment, assetHashes,
      interpretation: 'RAF callback cadence is not physical presented FPS. No forced frame interval was used. A virtual display does not verify physical 120 Hz presentation; renderer work can still be compared against the 8.33 ms / 120 Hz frame budget.',
      frameBudget120HzMs: 1000 / 120,
      rafDuringMotion: distribution(observation.raf.map(frame => frame.delta)),
      rafOutsideMotion: distribution(observation.idleRaf.map(frame => frame.delta)),
      motionCallbackIntervalsAbove16_7ms: observation.raf.filter(frame => frame.delta > 16.8).length,
      motionCallbackIntervalsAbove25ms: observation.raf.filter(frame => frame.delta > 25).length,
      traceAnalysis: analyzeTrace(trace), domMutations: directMutations(observation), longTasks: observation.longTasks,
      layerEvidence: { diagnosticRollExcludedFromTrace: true, layerChanges, layers, activeGeometry }, errors
    };
    summary.concise = concise(summary);
    const baselinePath = path.join(ROOT, 'output', 'yahtzee-motion-perf', 'baseline', 'summary.json');
    if (LABEL !== 'baseline' && fs.existsSync(baselinePath)) summary.comparison = { baseline: concise(JSON.parse(fs.readFileSync(baselinePath, 'utf8'))), current: summary.concise };
    fs.writeFileSync(path.join(OUTPUT, 'trace.json'), JSON.stringify({ traceEvents: trace }));
    fs.writeFileSync(path.join(OUTPUT, 'observations.json'), JSON.stringify(observation, null, 2));
    fs.writeFileSync(path.join(OUTPUT, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ output: OUTPUT, ...summary.concise, errors }, null, 2));
    if (summary.traceAnalysis.rolls.length !== ROLLS) throw new Error(`Expected ${ROLLS} complete traced rolls; got ${summary.traceAnalysis.rolls.length}`);
  } finally {
    await context.close();
    await browser.close();
  }
}
module.exports = { analyzeTrace, concise, directMutations };
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
