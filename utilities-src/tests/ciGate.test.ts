import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { checkGate, REQUIRED_JOBS } from '../../scripts/ci-gate.js';

type Job = { result: string; outputs?: Record<string, string> };
type Needs = Record<string, Job>;
function needs(regressions = true): Needs {
  return {
    ...Object.fromEntries(REQUIRED_JOBS.map((job) => [job, { result: 'success' }])),
    select: {
      result: 'success',
      outputs: regressions
        ? { groups: '["home"]', lanes: '["home"]', 'lane-profile': 'full', 'has-regressions': 'true' }
        : { groups: '[]', lanes: '[]', 'lane-profile': 'full', 'has-regressions': 'false' }
    },
    regression: { result: regressions ? 'success' : 'skipped' }
  };
}

function prNeeds(regressions = true): Needs {
  const input = needs(regressions);
  input.select.outputs = regressions
    ? { groups: '["home"]', lanes: '["home","cross-engine-sweep"]', 'lane-profile': 'pr', 'has-regressions': 'true' }
    : { groups: '[]', lanes: '[]', 'lane-profile': 'pr', 'has-regressions': 'false' };
  return input;
}

describe('CI aggregate deployment gate', () => {
  it('accepts successful selected regressions and explicitly omitted regressions', () => {
    expect(checkGate(needs())).toEqual([]);
    expect(checkGate(needs(false))).toEqual([]);
    expect(checkGate(prNeeds())).toEqual([]);
    expect(checkGate(prNeeds(false))).toEqual([]);
  });

  it.each(REQUIRED_JOBS)('requires %s to succeed', (job) => {
    for (const result of ['failure', 'cancelled', 'skipped', 'pending']) {
      const input = needs();
      input[job].result = result;
      expect(checkGate(input).join('\n')).toContain(`${job} must succeed`);
    }
    const input = needs();
    delete input[job];
    expect(checkGate(input).length).toBeGreaterThan(0);
  });

  it.each(['failure', 'cancelled', 'skipped', 'pending'])('rejects selected regression result %s', (result) => {
    const input = needs();
    input.regression.result = result;
    expect(checkGate(input).join('\n')).toContain('regression must be success');
    const pr = prNeeds();
    pr.regression.result = result;
    expect(checkGate(pr).join('\n')).toContain('regression must be success');
  });

  it('rejects missing and unexpectedly executed regression jobs', () => {
    const missing = needs();
    delete missing.regression;
    expect(checkGate(missing).length).toBeGreaterThan(0);
    for (const result of ['success', 'failure', 'cancelled']) {
      const input = needs(false);
      input.regression.result = result;
      expect(checkGate(input).join('\n')).toContain('regression must be skipped');
    }
  });

  it('never blocks a main deploy on the independent regression matrix', () => {
    // Deploy clears once fast jobs pass, even while lanes are unfinished.
    const running = needs();
    running.regression.result = 'in_progress';
    expect(checkGate(running, { deploy: true }).join('\n')).toContain('regression must not be in_progress');
    expect(checkGate(prNeeds(), { deploy: true })).toEqual([]);
    const absent = needs();
    delete absent.regression;
    expect(checkGate(absent, { deploy: true })).toEqual([]);
    expect(checkGate(needs(false), { deploy: true })).toEqual([]);
    const prAbsent = prNeeds(false);
    delete prAbsent.regression;
    expect(checkGate(prAbsent, { deploy: true })).toEqual([]);
    // A cancelled or wrongly-skipped matrix still fails closed, so coverage can
    // never be dropped from a deployable commit; real test failures block via
    // Build and the branch-level required check.
    for (const result of ['cancelled', 'pending']) {
      const input = needs();
      input.regression.result = result;
      expect(checkGate(input, { deploy: true }).join('\n')).toContain(`regression must not be ${result}`);
    }
    const skippedWithLanes = needs();
    skippedWithLanes.regression.result = 'skipped';
    expect(checkGate(skippedWithLanes, { deploy: true }).join('\n')).toContain('must not be skipped');
    const failed = needs();
    failed.regression.result = 'failure';
    expect(checkGate(failed, { deploy: true })).toEqual([]);
    // Failure must still fail the non-deploy gate.
    expect(checkGate(failed).join('\n')).toContain('regression must be success');
  });

  it('keeps deploy mode from masking required-job failures', () => {
    const input = needs();
    input.package.result = 'failure';
    input.regression.result = 'in_progress';
    expect(checkGate(input, { deploy: true }).join('\n')).toContain('package must succeed');
  });

  it.each([
    {}, { groups: '[]' }, { groups: '[]', 'has-regressions': 'FALSE' },
    { groups: '[]', 'has-regressions': 'TRUE' },
    { groups: 'oops', 'has-regressions': 'false' }, { groups: 'null', 'has-regressions': 'false' },
    { groups: '{}', 'has-regressions': 'false' }, { groups: '[]', 'has-regressions': 'true' },
    { groups: '["home"]', 'has-regressions': 'false' }, { groups: '["unknown"]', 'has-regressions': 'true' },
    { groups: '["home","home"]', 'has-regressions': 'true' }, { groups: '[42]', 'has-regressions': 'true' }
  ])('rejects malformed or inconsistent selector output %j', (outputs) => {
    const input = needs();
    input.select.outputs = { 'lane-profile': 'full', lanes: '["home"]', ...outputs } as Record<string, string>;
    expect(checkGate(input).join('\n')).toContain('selection outputs');
  });

  it.each([
    // Full profile: lanes must exactly equal the selected groups.
    { laneProfile: 'full', groups: '["home"]', lanes: '["home","gallery"]', flag: 'true' },
    { laneProfile: 'full', groups: '["home"]', lanes: '[]', flag: 'true' },
    // PR profile: lanes must come from the PR universe and match the flag.
    { laneProfile: 'pr', groups: '["home"]', lanes: '["home","cache"]', flag: 'true' },
    { laneProfile: 'pr', groups: '["home"]', lanes: '["home","unknown"]', flag: 'true' },
    { laneProfile: 'pr', groups: '[]', lanes: '["cross-engine-sweep"]', flag: 'false' },
    { laneProfile: 'pr', groups: '["home"]', lanes: '["home","cross-engine-sweep"]', flag: 'false' },
    { laneProfile: 'suspicious', groups: '["home"]', lanes: '["home"]', flag: 'true' },
    { laneProfile: undefined, groups: '["home"]', lanes: '["home"]', flag: 'true' }
  ])('cross-checks lane profile and matrix selection %j', ({ laneProfile, groups, lanes, flag }) => {
    const input = needs();
    input.select.outputs = {
      groups, lanes, 'has-regressions': flag,
      ...laneProfile ? { 'lane-profile': laneProfile } : {}
    };
    input.regression.result = flag === 'true' ? 'success' : 'skipped';
    expect(checkGate(input).join('\n')).toContain('selection outputs');
  });

  it.each([null, undefined, [], 'success', 1])('rejects malformed job results %j', (input) => {
    expect(checkGate(input).length).toBeGreaterThan(0);
  });

  it.each([
    ['true', JSON.stringify(prNeeds())],
    ['true', JSON.stringify(prNeeds(false))],
    ['false', JSON.stringify(prNeeds())],
    ['false', JSON.stringify(prNeeds(false))]
  ])('CLI exit 0 for deploy=%s with a valid gate input', (deploy, input) => {
    const result = spawnSync(process.execPath, [resolve('scripts/ci-gate.js')], {
      env: { ...process.env, NEEDS_JSON: input, GATE_DEPLOY: deploy }, encoding: 'utf8'
    });
    expect(result.status).toBe(0);
  });

  it.each([undefined, '{invalid', JSON.stringify(needs()), JSON.stringify(needs(false))])('sets CLI exit status for input %s', (input) => {
    const result = spawnSync(process.execPath, [resolve('scripts/ci-gate.js')], {
      env: { ...process.env, NEEDS_JSON: input }, encoding: 'utf8'
    });
    expect(result.status).toBe(input?.startsWith('{"') ? 0 : 1);
    if (result.status) expect(result.stderr).toContain('CI gate failed:');
  });
});
