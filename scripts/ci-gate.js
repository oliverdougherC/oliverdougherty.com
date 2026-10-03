#!/usr/bin/env node
const { GROUPS } = require('./ci-select');

const REQUIRED_JOBS = ['security-audit', 'lint', 'typecheck', 'test', 'select', 'package'];

function checkGate(needs) {
  const errors = [];
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) return ['Missing or malformed job results.'];
  for (const job of REQUIRED_JOBS) {
    if (needs[job]?.result !== 'success') errors.push(`${job} must succeed (received ${needs[job]?.result || 'missing'}).`);
  }
  const outputs = needs.select?.outputs;
  const flag = outputs?.['has-regressions'];
  let groups;
  try { groups = JSON.parse(outputs?.groups); } catch { /* Report malformed selection below. */ }
  const validGroups = Array.isArray(groups) && groups.every((group) => GROUPS.includes(group)) && new Set(groups).size === groups.length;
  if ((flag !== 'true' && flag !== 'false') || !validGroups || (flag === 'true') !== (groups.length > 0)) {
    errors.push('Missing, malformed, or inconsistent regression selection outputs.');
  } else {
    const expected = flag === 'true' ? 'success' : 'skipped';
    if (needs.regression?.result !== expected) errors.push(`regression must be ${expected} (received ${needs.regression?.result || 'missing'}).`);
  }
  return errors;
}

if (require.main === module) {
  try {
    const errors = checkGate(JSON.parse(process.env.NEEDS_JSON));
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('All required CI checks passed; regression selection is consistent.');
  } catch (error) {
    console.error(`CI gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { REQUIRED_JOBS, checkGate };
