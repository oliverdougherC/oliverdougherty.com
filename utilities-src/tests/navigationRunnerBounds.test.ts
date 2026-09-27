import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const runner = resolve('scripts/navigation-stability-check.js');
const preload = resolve('utilities-src/tests/fixtures/navigation-runner-hang.cjs');

for (const [mode, expectedOutput] of [
  ['evaluation', /wall-clock deadline.*animation-frame|wall-clock deadline.*event-loop/],
  ['context-close', /context close.*(did not settle|deadline)/],
  ['browser-close', /forced cleanup failed/]
] as const) {
  it(`exits and cleans up the local server when ${mode} hangs`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'navigation-runner-'));
    const marker = join(directory, 'server-cleaned');
    try {
      const result = spawnSync(process.execPath, ['--require', preload, runner], {
        cwd: resolve('.'),
        env: { ...process.env, NAV_RUNNER_HANG_MODE: mode, NAV_RUNNER_CLEANUP_MARKER: marker,
          NAV_STABILITY_DEADLINE_MS: '80', NAV_STABILITY_CLEANUP_MS: '80', NAV_STABILITY_CYCLES: '5' },
        encoding: 'utf8', timeout: 3000
      });
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe('ETIMEDOUT');
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(expectedOutput);
      expect(existsSync(marker), 'owned local server was not cleaned up').toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 5000);
}

it('bounds browser startup before Playwright returns an owned process handle', () => {
  const directory = mkdtempSync(join(tmpdir(), 'navigation-runner-'));
  try {
    const result = spawnSync(process.execPath, ['--require', preload, runner], {
      cwd: resolve('.'),
      env: { ...process.env, NAV_RUNNER_HANG_MODE: 'browser-launch',
        NAV_RUNNER_CLEANUP_MARKER: join(directory, 'server-cleaned'), NAV_STABILITY_TOTAL_MS: '150' },
      encoding: 'utf8', timeout: 3000
    });
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe('ETIMEDOUT');
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/overall deadline; terminating owned processes/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 5000);
