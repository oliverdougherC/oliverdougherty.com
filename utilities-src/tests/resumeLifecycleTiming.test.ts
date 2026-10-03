import { createContext, runInContext } from 'node:vm';
import { instrumentPage, waitUntilIntroOffset } from '../../scripts/resume-lifecycle-check.js';

function fixture() {
  let now = 10;
  const document = new EventTarget();
  const window = new EventTarget() as EventTarget & { __resumeCheck?: { t0: number; introStartedAt: number | null } };
  const context = createContext({ document, window, performance: { now: () => now } });
  const waits: number[] = [];
  const page = {
    addInitScript: async (callback: () => void) => { runInContext(`(${callback.toString()})()`, context); },
    evaluate: async (callback: () => number) => runInContext(`(${callback.toString()})()`, context) as number,
    waitForTimeout: async (delay: number) => { waits.push(delay); now += delay; }
  };
  return { document, window, page, waits, setNow: (value: number) => { now = value; } };
}

describe('resume lifecycle check intro clock', () => {
  it.each([100, 450, 800, 1200])('excludes delayed document/script loading from the %dms interruption', async (offset) => {
    const test = fixture();
    await instrumentPage(test.page);
    // A slow script delays DOMContentLoaded beyond every intro interruption.
    test.setNow(2500);
    test.document.dispatchEvent(new Event('DOMContentLoaded'));
    test.setNow(2525);
    await waitUntilIntroOffset(test.page, offset);
    expect(test.waits).toEqual([offset - 25]);
    expect(test.window.__resumeCheck?.t0).toBe(10);
    expect(test.window.__resumeCheck?.introStartedAt).toBe(2500);
    // Reentrant lifecycle events must not reset the intro clock.
    test.document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(test.window.__resumeCheck?.introStartedAt).toBe(2500);
  });

  it('does not add a delay when the requested intro offset has already elapsed', async () => {
    const test = fixture();
    await instrumentPage(test.page);
    test.document.dispatchEvent(new Event('DOMContentLoaded'));
    test.setNow(600);
    await waitUntilIntroOffset(test.page, 450);
    expect(test.waits).toEqual([]);
  });

  it('fails clearly if intro startup was not recorded', async () => {
    const test = fixture();
    await instrumentPage(test.page);
    await expect(waitUntilIntroOffset(test.page, 100)).rejects.toThrow('requires DOMContentLoaded');
  });
});
