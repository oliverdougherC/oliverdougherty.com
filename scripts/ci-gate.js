#!/usr/bin/env node
const { GROUPS, PR_LANES } = require('./ci-select');

// Fast required validation. `regression` is judged separately and, on the
// main-push deploy path, is deliberately NOT awaited: deploy waits for these
// jobs and the packaged smoke only, while the full cross-browser suite stays
// advisory on main (mirroring nightly) and required on PRs and beta.
const REQUIRED_JOBS = ['security-audit', 'lint', 'typecheck', 'test', 'select', 'package'];

function isSubset(values, universe) {
  return Array.isArray(values) && values.every((value) => universe.includes(value)) && new Set(values).size === values.length;
}

function checkGate(needs, { deploy = false } = {}) {
  const errors = [];
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) return ['Missing or malformed job results.'];
  for (const job of REQUIRED_JOBS) {
    if (needs[job]?.result !== 'success') errors.push(`${job} must succeed (received ${needs[job]?.result || 'missing'}).`);
  }
  const outputs = needs.select?.outputs;
  const flag = outputs?.['has-regressions'];
  const profile = outputs?.['lane-profile'];
  let groups, lanes;
  try {
    groups = JSON.parse(outputs?.groups);
    lanes = JSON.parse(outputs?.lanes);
  } catch { /* Report malformed selection below. */ }
  const universe = profile === 'pr' ? PR_LANES : GROUPS;
  let validSelection = (flag === 'true' || flag === 'false') &&
    (profile === 'pr' || profile === 'full') &&
    isSubset(groups, GROUPS) && isSubset(lanes, universe) &&
    (flag === 'true') === (lanes.length > 0);
  // The full profile runs exactly the selected groups; the PR profile derives
  // its lanes from them, and an empty selection must produce no lanes.
  if (validSelection && profile === 'full') validSelection = JSON.stringify([...lanes].sort()) === JSON.stringify([...groups].sort());
  if (validSelection && profile === 'pr' && groups.length === 0) validSelection = lanes.length === 0;
  if (!validSelection) {
    errors.push('Missing, malformed, or inconsistent regression selection outputs.');
  } else if (deploy) {
    // Main-push deploy: lanes are never awaited here; `regression` is absent
    // from needs in that wiring, and an explicitly empty selection must still
    // read as skipped, not as missing coverage.
    const result = needs.regression?.result;
    if (lanes.length === 0) {
      if (result !== undefined && result !== 'skipped') errors.push(`regression must be skipped or absent with no selected lanes (received ${result}).`);
    } else if (result !== undefined && result !== 'success' && result !== 'failure') {
      errors.push(`regression must not be ${result} on the deploy path.`);
    }
    if (result === undefined && lanes.length) console.log('Note: regression lanes were not awaited for the main deploy.');
  } else {
    // Every lane of the selected profile must succeed; PR and beta matrices are
    // fail-fast per lane, main-nightly-equivalent runs collect every failure.
    const expected = lanes.length ? 'success' : 'skipped';
    if (needs.regression?.result !== expected) errors.push(`regression must be ${expected} (received ${needs.regression?.result || 'missing'}).`);
  }
  return errors;
}

if (require.main === module) {
  try {
    const errors = checkGate(JSON.parse(process.env.NEEDS_JSON), { deploy: process.env.GATE_DEPLOY === 'true' });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(process.env.GATE_DEPLOY === 'true'
      ? 'Required CI checks passed; main deployment is cleared independently of the regression matrix.'
      : 'All required CI checks passed; regression selection is consistent.');
  } catch (error) {
    console.error(`CI gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { REQUIRED_JOBS, checkGate };
