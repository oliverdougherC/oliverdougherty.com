import { createRequire } from 'node:module';
const { createCheckPlan, createPrPlan, executeChecks, GROUPS, PR_LANES, PR_LANE_ORDER } = createRequire(import.meta.url)('../../scripts/release-check.js');

it('preserves existing release checks and includes cross-browser game coverage', () => {
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
    'chromium-home-hover', 'firefox-home-hover', 'webkit-home-hover',
    'chromium-gallery-inspector', 'firefox-gallery-inspector', 'webkit-gallery-inspector',
    'chromium-yahtzee', 'firefox-yahtzee', 'webkit-yahtzee',
    'firefox-index-arrow', 'webkit-index-arrow', 'chromium-lynx-reader', 'chromium-local-assistant'
  ].sort());
  expect(new Set(plan.map((check: { name: string }) => check.name)).size).toBe(60);
  expect(plan.some((check: { name: string }) => check.name === 'chromium-index-arrow')).toBe(false);
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

it.each(['chromium', 'firefox', 'webkit'])('runs hover regression against the shared packaged site in the %s home lane', async browser => {
  const plan = createCheckPlan({ browsers: [browser], group: 'home' });
  const hover = plan.filter((check: { file: string }) => check.file === 'nighthawks-hover-check.js');
  expect(hover).toHaveLength(1);
  expect(hover[0]).toMatchObject({ name: `${browser}-home-hover`, group: 'home', env: { NIGHTHAWKS_CHECK_BROWSERS: browser } });
  const runCheck = vi.fn(async () => ({ status: 'pass' }));
  const env = { NIGHTHAWKS_CHECK_URL: 'http://127.0.0.1:12345', STATIC_ROOT: '/packaged-site', REQUIRE_DEPLOY_ARTIFACT: '1' };
  await executeChecks(hover, env, { runCheck });
  expect(runCheck).toHaveBeenCalledWith(`${browser}-home-hover`, 'nighthawks-hover-check.js', expect.objectContaining(env));
});

it.each([true, false])('writes each result and honors failFast=%s', async failFast => {
  const runCheck = vi.fn(async (name: string) => ({ name, status: name === 'bad' ? 'fail' : 'pass' }));
  const onResult = vi.fn();
  const checks = ['good', 'bad', 'later'].map(name => ({ name, file: 'fake.js', env: {} }));
  const results = await executeChecks(checks, {}, { failFast, runCheck, onResult });
  expect(results.map((result: { name: string }) => result.name)).toEqual(failFast ? ['good', 'bad'] : ['good', 'bad', 'later']);
  expect(onResult).toHaveBeenCalledTimes(results.length);
});


it.each(['chromium', 'firefox', 'webkit'])('runs the real Yahtzee suite in the %s utilities lane', browser => {
  const plan = createCheckPlan({ browsers: [browser], group: 'utilities' });
  const games = plan.filter((check: { file: string }) => check.file === 'yahtzee-check.js');
  expect(games).toHaveLength(1);
  expect(games[0]).toMatchObject({ name: `${browser}-yahtzee`, group: 'utilities', env: { UTILITIES_BROWSER: browser } });
  const legacy = plan.find((check: { file: string }) => check.file === 'utilities-check.js');
  if (browser === 'chromium') expect(legacy.env.UTILITIES_SKIP_YAHTZEE).toBe('1');
  else expect(legacy).toBeUndefined();
  expect(plan[0]).toBe(games[0]);
});


it('runs each added utility in its own process without losing or duplicating release coverage', async () => {
  const plan = createCheckPlan({ browsers: ['chromium'], group: 'utilities' });
  const legacy = plan.find((check: { name: string }) => check.name === 'chromium-utilities');
  expect(legacy.env).toMatchObject({ UTILITIES_SKIP_YAHTZEE: '1', UTILITIES_SKIP_LYNX: '1', UTILITIES_SKIP_LOCAL_ASSISTANT: '1' });
  for (const [name, file] of [['lynx-reader', 'lynx-reader-check.js'], ['local-assistant', 'local-assistant-check.js']]) {
    const focused = plan.filter((check: { file: string }) => check.file === file);
    expect(focused).toHaveLength(1);
    expect(focused[0]).toMatchObject({ name: `chromium-${name}`, group: 'utilities', env: { UTILITIES_BROWSER: 'chromium' } });
    expect(plan.indexOf(focused[0])).toBeLessThan(plan.indexOf(legacy));
    expect(focused[0].env.UTILITIES_SKIP_LYNX).toBeUndefined();
    expect(focused[0].env.UTILITIES_SKIP_LOCAL_ASSISTANT).toBeUndefined();
  }
  const runCheck = vi.fn(async (name: string, _file: string, _env: Record<string, string>) => ({ name, status: 'pass' }));
  await executeChecks(plan, { UTILITIES_CHECK_URL: 'http://127.0.0.1:12345', REQUIRE_DEPLOY_ARTIFACT: '1' }, { runCheck });
  expect(runCheck).toHaveBeenCalledTimes(plan.length);
  for (const call of runCheck.mock.calls) expect(call[2]).toMatchObject({ UTILITIES_CHECK_URL: 'http://127.0.0.1:12345', REQUIRE_DEPLOY_ARTIFACT: '1' });
});

describe('PR regression lanes', () => {
  type Check = { name: string; browser: string; group: string; file: string; env: Record<string, string> };
  it('covers every Chromium suite exactly once across lanes', () => {
    const all = createCheckPlan();
    const chromium = all.filter((check: { browser: string }) => check.browser === 'chromium').map((check: { name: string }) => check.name).sort();
    const lanced = Object.values(createPrPlan() as Record<string, Check[]>).flat().filter((check) => check.browser === 'chromium');
    expect(lanced.map((check) => check.name).sort()).toEqual(chromium);
    // The split keeps every browser-specific suite reachable but never duplicated.
    expect(chromium.length).toBe(26);
  });

  it('pairs the sweep with Firefox/WebKit packaged-route and cross-engine link coverage', () => {
    const sweep = (createPrPlan(['cross-engine-sweep']) as Record<string, Check[]>)['cross-engine-sweep'];
    expect(sweep.map((check) => check.name).sort())
      .toEqual(['firefox-artifact', 'firefox-index-arrow', 'webkit-artifact', 'webkit-index-arrow']);
    expect(sweep.every((check) => ['firefox', 'webkit'].includes(check.env.BROWSER))).toBe(true);
  });

  it('resolves lanes against the real plan so each keeps its per-browser env', () => {
    const lanes = createPrPlan() as Record<string, Check[]>;
    expect(Object.keys(lanes)).toEqual(PR_LANE_ORDER);
    const home = lanes['home'].filter((check) => check.name === 'chromium-home-reveal');
    expect(home).toHaveLength(1);
    expect(home[0].env.NIGHTHAWKS_CHECK_BROWSERS).toBe('chromium');
    const navigation = lanes['navigation'].filter((check) => check.browser === 'webkit');
    expect(navigation.length).toBeGreaterThan(0);
    expect(navigation.every((check) => check.env.BROWSER === 'webkit')).toBe(true);
  });

  it('rejects unknown, duplicate, or empty lane selections', () => {
    expect(() => createPrPlan([])).toThrow();
    expect(() => createPrPlan(['typo'])).toThrow();
    expect(() => createPrPlan(['home', 'home'])).toThrow();
  });

  it('fails closed when a Chromium suite is registered in two lanes', () => {
    // Same-suite overlap between lanes would double the PR wall clock and hide
    // drift between the lane registry and the exhaustive plan.
    const before = PR_LANES['home'].chromium;
    PR_LANES['home'].chromium = [...before, 'nav'];
    try { expect(() => createPrPlan()).toThrow(/multiple PR lanes|expected check/); }
    finally { PR_LANES['home'].chromium = before; }
  });

  it('fails closed when a Chromium suite is missing from the lane registry', () => {
    const before = PR_LANES['home'].chromium;
    PR_LANES['home'].chromium = before.filter((base: string) => base !== 'home-reveal');
    try { expect(() => createPrPlan()).toThrow(/belongs to no PR lane|expected check/); }
    finally { PR_LANES['home'].chromium = before; }
  });

  it('keeps lanes nonempty and disjoint', () => {
    const lanes = createPrPlan() as Record<string, Check[]>;
    const names = Object.values(lanes).flat().map((check) => check.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [lane, checks] of Object.entries(lanes)) expect(checks.length, lane).toBeGreaterThan(0);
  });
});
