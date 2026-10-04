import { createRequire } from 'node:module';
const { createCheckPlan, executeChecks, GROUPS } = createRequire(import.meta.url)('../../scripts/release-check.js');

it('preserves every existing release check exactly once and adds the separate reveal and inspector checks', () => {
  const plan = createCheckPlan();
  const legacy = ['cache-releases'];
  for (const browser of ['chromium', 'firefox', 'webkit']) {
    for (const check of ['nav', 'nav-stability', 'optional-startup', 'blackout-storage', 'gallery-release', 'gallery-heading', 'gallery-prefetch', 'gallery-transitions', 'gallery-status', 'artifact', 'home-stage']) {
      legacy.push(`${browser}-${check}`);
    }
    if (browser === 'chromium') {
      for (const check of ['home', 'mobile', 'resume-lifecycle', 'gallery', 'gallery-data', 'utilities', 'transform-preparation', 'stress']) legacy.push(`${browser}-${check}`);
    } else legacy.push(`${browser}-stress-pool`);
  }
  expect(legacy).toHaveLength(44);
  expect(plan.map((check: { name: string }) => check.name).sort()).toEqual([
    ...legacy, 'chromium-home-reveal', 'firefox-home-reveal', 'webkit-home-reveal',
    'chromium-gallery-inspector', 'firefox-gallery-inspector', 'webkit-gallery-inspector',
    'chromium-index-arrow', 'firefox-index-arrow', 'webkit-index-arrow'
  ].sort());
  expect(new Set(plan.map((check: { name: string }) => check.name)).size).toBe(53);
});

it('partitions exhaustive coverage into disjoint, nonempty groups', () => {
  const all = createCheckPlan();
  const shards = GROUPS.flatMap((group: string) => {
    const checks = createCheckPlan({ group });
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((check: { group: string }) => check.group === group)).toBe(true);
    return checks;
  });
  expect(shards.map((check: { name: string }) => check.name).sort()).toEqual(all.map((check: { name: string }) => check.name).sort());
});

it('keeps mobile gallery/navigation coverage in the shared navigation group', () => {
  expect(createCheckPlan({ group: 'navigation' }).some((check: { name: string }) => check.name === 'chromium-mobile')).toBe(true);
});

it('rejects empty, duplicate or unknown browsers and unknown groups', () => {
  for (const browsers of [[], [''], ['chrome'], ['chromium', 'chromium']]) expect(() => createCheckPlan({ browsers })).toThrow();
  expect(() => createCheckPlan({ group: 'typo' })).toThrow();
});

it('keeps browser-specific environment settings and Chromium-only workloads', () => {
  const firefox = createCheckPlan({ browsers: ['firefox'] });
  expect(firefox.some((check: { name: string }) => check.name === 'chromium-utilities')).toBe(false);
  expect(firefox.find((check: { name: string }) => check.name === 'firefox-stress-pool').env).toMatchObject({ STRESS_BROWSER_TYPE: 'firefox', STRESS_POOL_ONLY: '1' });
  expect(firefox.find((check: { name: string }) => check.name === 'firefox-home-reveal').env.NIGHTHAWKS_CHECK_BROWSERS).toBe('firefox');
});

it.each([true, false])('writes each result and honors failFast=%s', async failFast => {
  const runCheck = vi.fn(async (name: string) => ({ name, status: name === 'bad' ? 'fail' : 'pass' }));
  const onResult = vi.fn();
  const checks = ['good', 'bad', 'later'].map(name => ({ name, file: 'fake.js', env: {} }));
  const results = await executeChecks(checks, {}, { failFast, runCheck, onResult });
  expect(results.map((result: { name: string }) => result.name)).toEqual(failFast ? ['good', 'bad'] : ['good', 'bad', 'later']);
  expect(onResult).toHaveBeenCalledTimes(results.length);
});
