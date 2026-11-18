#!/usr/bin/env node
/*
 * npm audit gate.
 *
 * Replaces the bare `npm audit` in CI so one class of finding can be parked
 * deliberately without weakening the rest: a brand-new advisory that has no
 * patched release upstream, and that only reaches the dev (build/test) tree.
 *
 * Rules:
 *   - The audit must actually have run. npm writes a JSON `error` object for
 *     operational failures (ENOLOCK, registry unreachable) and exits non-zero;
 *     treating that as a clean report would pass CI on a broken audit.
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

class AuditGateError extends Error {}

function runAudit(cwd, args) {
  let stdout;
  try {
    stdout = execFileSync('npm', ['audit', '--json', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (error) {
    // npm audit exits 1 when it finds vulnerabilities, so a non-zero status is
    // only fatal when the body cannot be read as a report; parseAuditReport
    // rejects the JSON error object npm emits for ENOLOCK and friends.
    stdout = error.stdout;
    if (!stdout) {
      throw new AuditGateError(`npm audit ${args.join(' ')} produced no report: ${String(error.message).split('\n')[0]}`);
    }
  }
  return parseAuditReport(stdout, `npm audit ${args.join(' ')}`);
}

// npm's JSON report is the only acceptable evidence that the audit ran.
function parseAuditReport(raw, label) {
  let report;
  try {
    report = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new AuditGateError(`${label} returned unreadable JSON: ${error.message}`);
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new AuditGateError(`${label} returned no report object.`);
  }
  const failure = report.error;
  if (failure && typeof failure === 'object') {
    throw new AuditGateError(`${label} failed (${failure.code || 'unknown code'}): ${failure.summary || failure.message || 'no detail'}`);
  }
  if (typeof failure === 'string' && failure) {
    throw new AuditGateError(`${label} failed: ${failure}`);
  }
  if (report.auditReportVersion !== 2) {
    throw new AuditGateError(`${label} returned an unsupported report (auditReportVersion ${JSON.stringify(report.auditReportVersion)}, expected 2).`);
  }
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    throw new AuditGateError(`${label} is missing its vulnerabilities section.`);
  }
  for (const [moduleName, info] of Object.entries(report.vulnerabilities)) {
    if (!info || typeof info !== 'object' || !Array.isArray(info.via)) {
      throw new AuditGateError(`${label} has a malformed vulnerability entry for ${moduleName}.`);
    }
  }
  const counts = report.metadata?.vulnerabilities;
  if (!counts || typeof counts !== 'object') {
    throw new AuditGateError(`${label} is missing its vulnerability counts.`);
  }
  const total = Number(counts.total);
  if (!Number.isInteger(total) || total < 0) {
    throw new AuditGateError(`${label} has an unreadable vulnerability total (${JSON.stringify(counts.total)}).`);
  }
  const severitySum = ['info', 'low', 'moderate', 'high', 'critical']
    .reduce((sum, severity) => sum + (Number(counts[severity]) || 0), 0);
  if (severitySum !== total) {
    throw new AuditGateError(`${label} severity counts add up to ${severitySum} but report a total of ${total}.`);
  }
  const listed = Object.keys(report.vulnerabilities).length;
  if (listed !== total) {
    // Covers both truncated sections and findings that live somewhere the
    // reader does not look; neither may masquerade as a clean audit.
    throw new AuditGateError(`${label} reports ${total} vulnerable packages but lists ${listed}.`);
  }
  return report;
}

function loadReport(envKey, cwd, args) {
  const saved = process.env[envKey];
  return saved ? parseAuditReport(fs.readFileSync(saved, 'utf8'), envKey) : runAudit(cwd, args);
}

// Collapse npm's per-package vulnerability entries into one record per advisory.
// String `via` entries are legitimate: they reference the other package whose
// advisory explains the finding. Every listed package must still resolve,
// through at most that reference chain, to an advisory URL, so an entry npm
// counts but the gate cannot read can never look like a clean audit.
function advisoriesFrom(report, label = 'audit report') {
  const advisories = new Map();
  const references = new Map();
  for (const [moduleName, info] of Object.entries(report.vulnerabilities)) {
    const refs = new Set();
    references.set(moduleName, refs);
    for (const via of info.via) {
      if (typeof via === 'string') {
        refs.add(via);
        continue;
      }
      if (!via || typeof via !== 'object' || typeof via.url !== 'string' || !via.url) {
        throw new AuditGateError(`${label} has a ${moduleName} vulnerability without an advisory reference.`);
      }
      const id = via.url.split('/').filter(Boolean).pop();
      if (!id) {
        throw new AuditGateError(`${label} has a ${moduleName} advisory URL with no identifier: ${via.url}`);
      }
      if (!advisories.has(id)) {
        advisories.set(id, { id, url: via.url, severity: via.severity, modules: new Set(), fixable: new Map() });
      }
      const advisory = advisories.get(id);
      advisory.modules.add(moduleName);
      // A package's fixAvailable says whether an in-range upgrade exists.
      advisory.fixable.set(moduleName, info.fixAvailable);
    }
  }

  // A package with only string references is covered when every referenced
  // package resolves; a cycle or a dangling name is not coverage. Attribution
  // follows the chain so the verdict names every affected package.
  const direct = new Map();
  for (const advisory of advisories.values()) {
    for (const moduleName of advisory.modules) {
      if (!direct.has(moduleName)) direct.set(moduleName, []);
      direct.get(moduleName).push(advisory.id);
    }
  }
  const idsByModule = new Map();
  const resolve = (moduleName, seen) => {
    if (idsByModule.has(moduleName)) return idsByModule.get(moduleName);
    if (seen.has(moduleName)) return null;
    seen.add(moduleName);
    let ids = null;
    if (direct.get(moduleName)) {
      ids = [...direct.get(moduleName)];
    } else {
      const targets = [...(references.get(moduleName) || [])];
      if (targets.length && targets.every((target) => references.has(target))) {
        const merged = new Set();
        for (const target of targets) {
          const resolved = resolve(target, seen);
          if (!resolved) { ids = null; break; }
          resolved.forEach((id) => merged.add(id));
          ids = [...merged];
        }
      }
    }
    seen.delete(moduleName);
    if (ids) idsByModule.set(moduleName, ids);
    return ids;
  };
  for (const moduleName of references.keys()) {
    const ids = resolve(moduleName, new Set());
    if (!ids) {
      throw new AuditGateError(`${label} lists ${moduleName} as vulnerable without a resolvable advisory.`);
    }
    for (const id of ids) {
      const advisory = advisories.get(id);
      advisory.modules.add(moduleName);
      advisory.fixable.set(moduleName, report.vulnerabilities[moduleName].fixAvailable);
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

// Two validated reports in, verdict out: failures block the build, parked
// lines document what the gate consciously accepted.
function checkAudit(shippedReport, fullReport, now = Date.now()) {
  const shipped = advisoriesFrom(shippedReport, 'shipped audit report');
  const full = advisoriesFrom(fullReport, 'full audit report');
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

  return { failures, parked };
}

function main() {
  const scope = process.argv[2] || process.cwd();
  const cwd = fs.realpathSync(scope);
  const shipped = loadReport('AUDIT_SHIPPED_JSON', cwd, ['--omit=dev', '--include=optional', '--audit-level=low']);
  const full = loadReport('AUDIT_FULL_JSON', cwd, ['--include=dev', '--include=optional', '--audit-level=low']);
  const { failures, parked } = checkAudit(shipped, full);

  console.log(`Audit gate: ${cwd}`);
  parked.forEach((line) => console.log(`PARKED: ${line}`));
  if (!parked.length && !failures.length) console.log('No vulnerabilities.');
  failures.forEach((line) => console.error(`FAIL: ${line}`));
  if (failures.length) {
    console.error('Audit gate failed.');
    process.exitCode = 1;
    return;
  }
  console.log('Audit gate passed.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Audit gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { ALLOWLIST, AuditGateError, advisoriesFrom, checkAudit, parseAuditReport };
