import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { checkGate, REQUIRED_JOBS } from '../../scripts/ci-gate.js';

type Job = { result: string; outputs?: Record<string, string> };
function needs(regressions = true): Record<string, Job> {
  return {
    ...Object.fromEntries(REQUIRED_JOBS.map((job) => [job, { result: 'success' }])),
    select: { result: 'success', outputs: { groups: regressions ? '["home"]' : '[]', 'has-regressions': String(regressions) } },
    regression: { result: regressions ? 'success' : 'skipped' }
  };
}

describe('CI aggregate deployment gate', () => {
  it('accepts successful selected regressions and explicitly omitted regressions', () => {
    expect(checkGate(needs())).toEqual([]);
    expect(checkGate(needs(false))).toEqual([]);
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

  it.each([
    {}, { groups: '[]' }, { groups: '[]', 'has-regressions': 'TRUE' },
    { groups: 'oops', 'has-regressions': 'false' }, { groups: 'null', 'has-regressions': 'false' },
    { groups: '{}', 'has-regressions': 'false' }, { groups: '[]', 'has-regressions': 'true' },
    { groups: '["home"]', 'has-regressions': 'false' }, { groups: '["unknown"]', 'has-regressions': 'true' },
    { groups: '["home","home"]', 'has-regressions': 'true' }, { groups: '[42]', 'has-regressions': 'true' }
  ])('rejects malformed or inconsistent selector output %j', (outputs) => {
    const input = needs();
    input.select.outputs = outputs as Record<string, string>;
    expect(checkGate(input).join('\n')).toContain('selection outputs');
  });

  it.each([null, undefined, [], 'success', 1])('rejects malformed job results %j', (input) => {
    expect(checkGate(input).length).toBeGreaterThan(0);
  });

  it.each([undefined, '{invalid', JSON.stringify(needs()), JSON.stringify(needs(false))])('sets CLI exit status for input %s', (input) => {
    const result = spawnSync(process.execPath, [resolve('scripts/ci-gate.js')], {
      env: { ...process.env, NEEDS_JSON: input }, encoding: 'utf8'
    });
    expect(result.status).toBe(input?.startsWith('{"') ? 0 : 1);
    if (result.status) expect(result.stderr).toContain('CI gate failed:');
  });
});
