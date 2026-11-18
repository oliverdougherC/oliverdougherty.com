#!/usr/bin/env node
/*
 * npm audit gate.
 *
 * Replaces the bare `npm audit` in CI so one class of finding can be parked
 * deliberately without weakening the rest: a brand-new advisory that has no
 * patched release upstream, and that only reaches the dev (build/test) tree.
 *
 * Rules:
 *   - Anything in the shipped tree (--omit=dev) always fails. The allowlist
 *     cannot cover it.
 *   - A dev-tree advisory fails unless its GHSA id is listed in ALLOWLIST
 *     with a reason, an owner-reviewed expiry, and no non-breaking upgrade
 *     available.
 *
 * Test seam: AUDIT_SHIPPED_JSON / AUDIT_FULL_JSON point at saved `npm audit
 * --json` reports and skip the npm calls.
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// GHSA id -> the parked exception. Delete the entry as soon as upstream ships
// a patched release; the expiry check forces a re-review even if nobody notices.
const ALLOWLIST = new Map([
  [
    'GHSA-fc5q-39xc-vjpf',
    {
      module: 'picomatch',
      reviewBy: '2027-01-31',
      reason: 'Advisory covers every published picomatch (4.0.7 is latest; upstream PRs #259/#260/#262 are open), ' +
        'so no upgrade removes it. Reached only through vite/vitest, which never ship to the browser.'
    }
  ]
]);

function runAudit(cwd, args) {
  try {
    return JSON.parse(execFileSync('npm', ['audit', '--json', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }));
  } catch (error) {
    // npm audit exits 1 when it finds vulnerabilities; the JSON report is still
    // the verdict. Anything else (bad flag, no lockfile) has no parseable body.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
}

function loadReport(envKey, cwd, args) {
  const saved = process.env[envKey];
  return saved ? JSON.parse(fs.readFileSync(saved, 'utf8')) : runAudit(cwd, args);
}

// Collapse npm's per-package vulnerability entries into one record per advisory.
function advisoriesFrom(report) {
  const advisories = new Map();
  for (const [moduleName, info] of Object.entries(report.vulnerabilities || {})) {
    for (const via of info.via || []) {
      if (typeof via !== 'object' || !via.url) continue;
      const id = via.url.split('/').filter(Boolean).pop();
      if (!advisories.has(id)) {
        advisories.set(id, { id, url: via.url, severity: via.severity, modules: new Set(), fixable: new Map() });
      }
      const advisory = advisories.get(id);
      advisory.modules.add(moduleName);
      // A package's fixAvailable says whether an in-range upgrade exists.
      advisory.fixable.set(moduleName, info.fixAvailable);
    }
  }
  return advisories;
}

function format(advisory) {
  return `${advisory.id} (${advisory.severity}) via ${[...advisory.modules].sort().join(', ')}`;
}

// True only when some affected package can move to a patched release without a
// semver-major jump; parking is otherwise pointless.
function hasPatchedUpgrade(advisory) {
  for (const fix of advisory.fixable.values()) {
    // npm reports fixAvailable as true, a target version string, or an object
    // naming the package whose update (possibly semver-major) clears it.
    if (fix === true || (typeof fix === 'string' && fix)) return true;
    if (fix && typeof fix === 'object' && fix.name && !fix.isSemVerMajor) return true;
  }
  return false;
}

function review(advisory, now) {
  const entry = ALLOWLIST.get(advisory.id);
  if (!entry) return `Unreviewed advisory: ${format(advisory)}.`;
  if (hasPatchedUpgrade(advisory)) {
    return `${advisory.id} now has a non-breaking patched release; upgrade instead of parking it.`;
  }
  if (!advisory.modules.has(entry.module)) {
    return `${advisory.id} allowlist entry names ${entry.module}, which the advisory no longer reports.`;
  }
  const expires = new Date(`${entry.reviewBy}T23:59:59Z`).getTime();
  if (Number.isNaN(expires)) return `${advisory.id} allowlist entry has an unreadable reviewBy date.`;
  if (now > expires) {
    return `${advisory.id} parked exception expired on ${entry.reviewBy}; re-check upstream for a patched release.`;
  }
  return null;
}

function main() {
  const scope = process.argv[2] || process.cwd();
  const cwd = fs.realpathSync(scope);
  const now = Date.now();
  const shipped = advisoriesFrom(loadReport('AUDIT_SHIPPED_JSON', cwd, ['--omit=dev', '--include=optional', '--audit-level=low']));
  const full = advisoriesFrom(loadReport('AUDIT_FULL_JSON', cwd, ['--include=dev', '--include=optional', '--audit-level=low']));

  const failures = [];
  const parked = [];

  for (const advisory of shipped.values()) failures.push(`Shipped dependency vulnerability: ${format(advisory)}.`);

  for (const advisory of full.values()) {
    if (shipped.has(advisory.id)) continue; // already failed as shipped
    const problem = review(advisory, now);
    if (problem) failures.push(problem);
    else if (!parked.some((line) => line.startsWith(advisory.id))) {
      parked.push(`${format(advisory)} — ${ALLOWLIST.get(advisory.id).reason} Re-review by ${ALLOWLIST.get(advisory.id).reviewBy}.`);
    }
  }

  console.log(`Audit gate: ${cwd}`);
  parked.forEach((line) => console.log(`PARKED: ${line}`));
  if (!parked.length && !failures.length) console.log('No vulnerabilities.');
  failures.forEach((line) => console.error(`FAIL: ${line}`));
  if (failures.length) {
    console.error('Audit gate failed.');
    process.exit(1);
  }
  console.log('Audit gate passed.');
}

main();
