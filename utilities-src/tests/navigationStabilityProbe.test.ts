import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
const { chromium } = createRequire(import.meta.url)('playwright');

const PROBE = new URL('../../scripts/navigation-stability-check.js', import.meta.url).pathname;
const ROUTES: Record<string, { route: string; heading: string }> = {
  home: { route: '/index.html', heading: '#home-intro-title' },
  resume: { route: '/pages/resume/index.html', heading: '#typeTargetName1' },
  gallery: { route: '/pages/gallery/index.html', heading: '.gallery-hero .calibrate-text' },
  utilities: { route: '/pages/utilities/index.html', heading: '#utilitiesHeading' }
};
const NAMES = Object.keys(ROUTES);

// Real-link fixture with the same navigation contract the probe asserts:
// one aria-current nav link per page, a visible heading, and plain <a>
// navigation. A wedged page replaces requestAnimationFrame at parse time, so
// the probe's double-rAF evaluation can never settle while the visibility
// checks still pass — the exact pending-evaluate failure mode the Node-side
// wall-clock deadline must bound.
function fixturePage(name: string, wedged: string[]): string {
  const { heading } = ROUTES[name];
  const selector = heading.slice(1);
  const nav = NAMES.map(target =>
    `<a class="nav-inline-link nav-inline-link--${target}" href="${ROUTES[target].route}"` +
    `${target === name ? ' aria-current="page"' : ''}>${target}</a>`).join('\n');
  const wedge = wedged.includes(name)
    ? '<script>window.requestAnimationFrame = () => 0;</script>'
    : '';
  const gallery = name === 'gallery' ? `<div id="galleryLoading"${wedged.includes('gallery-loading') ? '' : ' hidden'}>Loading photographs…</div>
<div id="galleryError"${wedged.includes('gallery-error') ? '' : ' hidden'}>Gallery unavailable</div>
<section id="galleryArchiveSection"${wedged.includes('gallery-loading') || wedged.includes('gallery-error') ? ' hidden' : ''}>
<div id="galleryArchiveGrid"><article class="photo-card"><button class="photo-card-button">Photo</button><img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="Photo"></article></div></section>` : '';
  const utilities = name === 'utilities' ? `<section id="utilitiesTitleView"><nav class="utilities-buttons"><a data-utility="image-transform" href="#image-transform">Image Transform</a></nav></section>
<section id="utilitiesUtilityView" hidden><button class="nav-back-btn">Index</button>
<div class="utility-stage" data-utility-id="image-transform" hidden><div data-utility-root="image-transform" inert>Image Transform controls</div></div></section>
<script>document.querySelector('[data-utility="image-transform"]').addEventListener('click', event => {
event.preventDefault(); history.pushState({}, '', '#image-transform');
document.querySelector('#utilitiesTitleView').hidden = true;
document.querySelector('#utilitiesUtilityView').hidden = false;
const stage = document.querySelector('[data-utility-id="image-transform"]'); stage.hidden = false; stage.classList.add('is-active');
stage.dataset.utilityReady = '${wedged.includes('utility-uninitialized') ? 'loading' : 'ready'}';
${wedged.includes('utility-uninitialized') ? '' : "stage.querySelector('[data-utility-root]').removeAttribute('inert');"}
});
window.addEventListener('popstate', () => { document.querySelector('#utilitiesTitleView').hidden = false; document.querySelector('#utilitiesUtilityView').hidden = true; });</script>` : '';
  return `<!doctype html><html><head><title>${name}</title></head><body>
${wedge}<h1 id="${selector}">${name} content</h1>
<div class="gallery-hero"><span class="calibrate-text">calibrate</span></div>
<div class="home-intro-copy"><p>I study engineering and mathematics and make this portfolio available for visitors.</p></div>
<div class="education-card">Electrical and Computer Engineering</div>
${gallery}${utilities}<nav>${nav}</nav></body></html>`;
}

async function startFixtureServer(wedged: string[]): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    // The probe readiness poll fetches the bare origin; treat it as home.
    const name = NAMES.find(candidate => ROUTES[candidate].route === pathname)
      ?? (pathname === '/' ? 'home' : undefined);
    if (!name) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    response.end(fixturePage(name, wedged));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

interface ProbeRun {
  pid: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  harnessKilled: boolean;
}

// Runs the probe as a detached child so its whole process group (the probe and
// its Chromium descendants) can be observed and reaped, mirroring how the
// release matrix spawns it. Real timers throughout: the probe is an out-of-
// process browser run whose whole point is real wall-clock bounding, so fake
// clocks cannot observe it.
async function runProbe(url: string, env: Record<string, string>, killAfterMs: number): Promise<ProbeRun> {
  const child = spawn(process.execPath, [PROBE], {
    env: { ...process.env, NAV_STABILITY_URL: url, NAV_STABILITY_CYCLES: '5', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let harnessKilled = false;
  const timer = setTimeout(() => {
    harnessKilled = true;
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already gone. */ }
  }, killAfterMs);
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; harnessKilled: boolean }>(resolve => {
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, harnessKilled });
    });
  });
  return { pid: child.pid!, stdout, stderr, ...outcome };
}

// Positive integration check: waits for the real process group to disappear;
// a fixed poll is the only observation available for external pids.
async function waitForReap(pgid: number, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  const survivorsOf = () => {
    try {
      return execFileSync('ps', ['-o', 'pid=', '-g', String(pgid)], { encoding: 'utf8' })
        .split('\n').map(line => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  };
  let left = survivorsOf();
  while (left.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    left = survivorsOf();
  }
  return left;
}

let chromiumAvailable = false;
try {
  chromiumAvailable = createRequire(import.meta.url)('node:fs').existsSync(chromium.executablePath());
} catch {
  chromiumAvailable = false;
}

const probeTest = it.skipIf(process.platform === 'win32' || !chromiumAvailable);

probeTest('bounds a wedged animation-frame probe, prints the diagnosis, and reaps the browser', async () => {
  const { server, url } = await startFixtureServer(['gallery']);
  const deadlineMs = 1500;
  const killAfterMs = 30000;
  try {
    const run = await runProbe(url, { NAV_STABILITY_DEADLINE_MS: String(deadlineMs), NAV_STABILITY_CLEANUP_MS: '2000' }, killAfterMs);

    // Bounded failure: the probe exits on its own, non-zero, long before the
    // harness bound, instead of waiting on a never-settling evaluate.
    expect(run.harnessKilled, `probe hung past ${killAfterMs} ms; stderr: ${run.stderr}`).toBe(false);
    expect(run.signal).toBeNull();
    expect(run.code).toBe(1);

    // Diagnostic output: one JSON object naming the wedged stage, elapsed
    // wall-clock time, and outstanding requests.
    const start = run.stderr.indexOf('{');
    expect(start, `no diagnostic JSON on stderr: ${run.stderr}`).toBeGreaterThanOrEqual(0);
    // The pretty-printed diagnosis closes with a column-0 brace before the
    // error stack that run().catch prints afterwards.
    const end = run.stderr.indexOf('\n}', start);
    expect(end, `unterminated diagnostic JSON: ${run.stderr}`).toBeGreaterThan(start);
    const diagnosis = JSON.parse(run.stderr.slice(start, end + 2));
    expect(diagnosis).toMatchObject({ action: 'click', from: 'home', to: 'gallery', stage: 'animation-frame' });
    expect(diagnosis.deadlineMs).toBe(deadlineMs);
    expect(diagnosis.elapsedMs).toBeGreaterThanOrEqual(deadlineMs);
    expect(diagnosis.elapsedMs).toBeLessThan(killAfterMs);
    expect(diagnosis.error).toContain('wall-clock deadline');
    expect(Array.isArray(diagnosis.outstanding)).toBe(true);
    expect(run.stdout).toContain('"action":"open"');
    expect(run.stdout).not.toContain('PASS:');

    // Process cleanup: the probe exited, so every Chromium descendant in its
    // process group must be gone without the harness reaping anything.
    expect(await waitForReap(run.pid, 5000), 'browser descendants survived the deadline').toEqual([]);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}, 60000);

probeTest('still records successful transition measurements', async () => {
  const { server, url } = await startFixtureServer([]);
  try {
    const run = await runProbe(url, { NAV_STABILITY_TIMEOUT_MS: '5000', NAV_STABILITY_DEADLINE_MS: '20000' }, 90000);
    expect(run.harnessKilled, `probe hung; stderr: ${run.stderr}`).toBe(false);
    expect(run.code, `probe failed; stderr: ${run.stderr}`).toBe(0);
    const measurements = run.stdout.split('\n').filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));
    // The covering tour adds twelve distinct directed links before the
    // repeated browsing loop and the separate history checks.
    expect(measurements).toHaveLength(37);
    const expectedEdges = new Set(NAMES.flatMap(from => NAMES.filter(to => to !== from).map(to => `${from}->${to}`)));
    const visitedEdges = new Set(measurements.filter(item => item.action === 'click').map(item => `${item.from}->${item.to}`));
    expect(visitedEdges).toEqual(expectedEdges);
    for (const measurement of measurements) {
      expect(typeof measurement.usableMs).toBe('number');
      expect(measurement.readyState).toBe('complete');
    }
    expect(run.stdout).toContain('PASS: 36 real-link/history transitions');
    expect(await waitForReap(run.pid, 5000), 'browser descendants survived a passing run').toEqual([]);
  } finally {
    server.close();
    server.closeAllConnections();
  }
}, 120000);

for (const [fault, expectedStage] of [
  ['gallery-loading', 'gallery-content'],
  ['gallery-error', 'gallery-content'],
  ['utility-uninitialized', 'utilities-content']
] as const) {
  probeTest(`does not pass an unhealthy ${fault} fixture`, async () => {
    const { server, url } = await startFixtureServer([fault]);
    try {
      const run = await runProbe(url, { NAV_STABILITY_TIMEOUT_MS: '1000', NAV_STABILITY_DEADLINE_MS: '2500' }, 30000);
      expect(run.harnessKilled, `probe hung; stderr: ${run.stderr}`).toBe(false);
      expect(run.code, `unhealthy fixture received normal PASS: ${run.stdout}`).toBe(1);
      expect(run.stdout).not.toContain('PASS:');
      expect(run.stderr).toContain(expectedStage);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }, 45000);
}
