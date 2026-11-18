#!/usr/bin/env node
const { GROUPS, PR_LANES, prLanesForGroups } = require('./ci-select');

// Fast required validation. `regression` is judged separately and, on the
// main-push deploy path, is deliberately NOT awaited: deploy waits for these
// jobs and the packaged smoke only, while the full cross-browser suite stays
// advisory on main (mirroring nightly) and required on PRs and beta.
const REQUIRED_JOBS = ['security-audit', 'lint', 'typecheck', 'test', 'select', 'package'];

function isSubset(values, universe) {
  return Array.isArray(values) && values.every((value) => universe.includes(value)) && new Set(values).size === values.length;
}

function sameSet(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
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
  // The matrix must run exactly the scheduled work: the full profile runs the
  // selected groups, and the PR profile must equal the selector's own
  // derivation from those groups. A lane the selector would have produced but
  // the output omits or substitutes (e.g. gallery changes validated only by
  // the sweep) fails closed here, not just in ci-select.
  if (validSelection && profile === 'full') validSelection = sameSet(lanes, groups);
  if (validSelection && profile === 'pr') validSelection = JSON.stringify(lanes) === JSON.stringify(prLanesForGroups(groups));
  if (!validSelection) {
    errors.push('Missing, malformed, or inconsistent regression selection outputs.');
  } else if (deploy) {
    // The main deploy workflow does not depend on `regression`, so its result
    // is normally absent here; deploy proceeds on the fast jobs alone. These
    // assertions guard the wiring if `regression` ever joins `needs`: an empty
    // selection must still read skipped, and a selected matrix must reach a
    // terminal success/failure rather than hang in a nonterminal state.
    const result = needs.regression?.result;
    if (result !== undefined) {
      if (lanes.length === 0) {
        if (result !== 'skipped') errors.push(`regression must be skipped with no selected lanes (received ${result}).`);
      } else if (result !== 'success' && result !== 'failure') {
        errors.push(`regression must not be ${result} on the deploy path.`);
      }
    }
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
