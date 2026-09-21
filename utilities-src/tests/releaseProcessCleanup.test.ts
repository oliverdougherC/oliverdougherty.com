import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { run } = createRequire(import.meta.url)('../../scripts/release-check.js');

it.skipIf(process.platform === 'win32')('terminates detached descendants when a browser check times out', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-process-'));
  const childFile = join(directory, 'child.js');
  const pidFile = join(directory, 'pid');
  let pid: number | undefined;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    writeFileSync(childFile, `
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      child.unref();
      require('node:fs').writeFileSync(process.env.RELEASE_PROBE_PID, String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const result = await run('timeout-regression', childFile, { RELEASE_PROBE_PID: pidFile }, 1000);
    pid = Number(readFileSync(pidFile, 'utf8'));
    expect(result.timedOut).toBe(true);
    let running = true;
    for (let attempt = 0; attempt < 20 && running; attempt++) {
      try {
        const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        running = Boolean(state) && !state.startsWith('Z');
      } catch { running = false; }
      if (running) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(running, 'detached browser descendant survived the timed-out check').toBe(false);
  } finally {
    if (!pid) { try { pid = Number(readFileSync(pidFile, 'utf8')); } catch { /* Startup failed. */ } }
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    log.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
