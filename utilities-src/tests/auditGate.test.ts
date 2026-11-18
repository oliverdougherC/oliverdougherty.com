import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALLOWLIST, checkAudit, parseAuditReport } from '../../scripts/audit-check.js';

const PARKED_ID = 'GHSA-fc5q-39xc-vjpf';
const PARKED_MODULE = ALLOWLIST.get(PARKED_ID)!.module;

function report(vulnerabilities: Record<string, unknown> = {}, total = Object.keys(vulnerabilities).length) {
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: total, critical: 0, total } } };
}

function advisoryEntry(id = PARKED_ID, module = PARKED_MODULE, fixAvailable: unknown = { name: 'vite', version: '6.2.7', isSemVerMajor: true }) {
  return { [module]: { name: module, via: [{ source: 1, name: module, severity: 'high', title: 'ReDoS', url: `https://github.com/advisories/${id}` }], fixAvailable } };
}

const cleanShipped = report();
const parkedFull = report(advisoryEntry());

describe('npm audit gate report validation', () => {
  it('rejects the JSON error object npm emits for an audit that never ran', () => {
    const enolock = { error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } };
    expect(() => parseAuditReport(JSON.stringify(enolock), 'npm audit')).toThrow(/ENOLOCK/);
    expect(() => parseAuditReport({ error: 'something broke' }, 'npm audit')).toThrow(/something broke/);
  });

  it('rejects unreadable, empty, and non-object reports', () => {
    expect(() => parseAuditReport('not json at all', 'npm audit')).toThrow(/unreadable JSON/);
    expect(() => parseAuditReport('', 'npm audit')).toThrow(/unreadable JSON|no report object/);
    expect(() => parseAuditReport(null, 'npm audit')).toThrow(/no report object/);
    expect(() => parseAuditReport('[]', 'npm audit')).toThrow(/no report object/);
  });

  it.each([
    ['a report from another audit version', { ...report(), auditReportVersion: 1 }, /auditReportVersion/],
    ['a report without vulnerabilities', { auditReportVersion: 2, metadata: { vulnerabilities: { total: 0 } } }, /missing its vulnerabilities section/],
    ['a report whose vulnerability entry is malformed', { ...report({ foo: { name: 'foo' } }), metadata: { vulnerabilities: { total: 1 } } }, /malformed vulnerability entry for foo/],
    ['findings counted but absent from the section', { ...report({}, 3) }, /3 vulnerabilities with an empty vulnerabilities section/],
    ['a report without metadata counts', { auditReportVersion: 2, vulnerabilities: {} }, /missing its vulnerability counts/]
  ])('rejects %s', (_label, body, pattern) => {
    expect(() => parseAuditReport(JSON.stringify(body), 'npm audit')).toThrow(pattern);
  });

  it('accepts a clean report and a report with vulnerability entries', () => {
    expect(parseAuditReport(JSON.stringify(cleanShipped), 'npm audit')).toEqual(cleanShipped);
    expect(parseAuditReport(JSON.stringify(parkedFull), 'npm audit').vulnerabilities).toHaveProperty(PARKED_MODULE);
  });
});

describe('npm audit gate verdict', () => {
  it('parks the reviewed dev-only advisory and passes', () => {
    const { failures, parked } = checkAudit(cleanShipped, parkedFull);
    expect(failures).toEqual([]);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toContain(PARKED_ID);
  });

  it('passes a clean tree with nothing parked', () => {
    expect(checkAudit(cleanShipped, cleanShipped)).toEqual({ failures: [], parked: [] });
  });

  it('fails an advisory that nobody reviewed', () => {
    const full = report({ 'left-pad': { name: 'left-pad', via: [{ source: 2, name: 'left-pad', severity: 'critical', title: 'x', url: 'https://github.com/advisories/GHSA-0000-0000-0001' }], fixAvailable: false } });
    const result = checkAudit(cleanShipped, full);
    expect(result.failures.join('\n')).toMatch(/Unreviewed advisory: GHSA-0000-0000-0001/);
    expect(result.parked).toEqual([]);
  });

  it('fails a parked advisory the moment it reaches the shipped tree', () => {
    const shipped = report(advisoryEntry());
    const result = checkAudit(shipped, shipped);
    expect(result.failures.join('\n')).toMatch(/Shipped dependency vulnerability/);
    expect(result.parked).toEqual([]);
  });

  it.each([
    ['a non-breaking target version', '4.0.8'],
    ['fixAvailable true', true],
    ['a non-major fix object', { name: 'vite', version: '7.4.0', isSemVerMajor: false }]
  ])('fails the parked advisory when npm reports %s', (_label, fixAvailable) => {
    const full = report(advisoryEntry(PARKED_ID, PARKED_MODULE, fixAvailable));
    expect(checkAudit(cleanShipped, full).failures.join('\n')).toMatch(/non-breaking patched release/);
  });

  it('fails the parked advisory once its review date passes', () => {
    const future = new Date(`${ALLOWLIST.get(PARKED_ID)!.reviewBy}T23:59:59Z`).getTime() + 1000;
    expect(checkAudit(cleanShipped, parkedFull, future).failures.join('\n')).toMatch(/expired on/);
  });

  it('fails when the allowlist entry no longer matches the advisory module', () => {
    const full = report(advisoryEntry(PARKED_ID, 'tinyglobby'));
    expect(checkAudit(cleanShipped, full).failures.join('\n')).toMatch(/names picomatch, which the advisory no longer reports/);
  });
});

describe('npm audit gate as CI runs it', () => {
  const script = resolve(__dirname, '../../scripts/audit-check.js');

  function fixture(contents: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'audit-gate-'));
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify(contents));
    return file;
  }

  function run(env: Record<string, string>) {
    return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, ...env } });
  }

  it('passes with a clean shipped tree and the parked dev advisory', () => {
    const result = run({ AUDIT_SHIPPED_JSON: fixture(cleanShipped), AUDIT_FULL_JSON: fixture(parkedFull) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`PARKED: ${PARKED_ID}`);
    expect(result.stdout).toContain('Audit gate passed.');
  });

  it.each([
    ['ENOLOCK error object', { error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } }],
    ['wrong report version', { ...report(), auditReportVersion: 1 }],
    ['missing vulnerabilities', { auditReportVersion: 2, metadata: { vulnerabilities: { total: 0 } } }]
  ])('fails (%s) instead of reporting a clean audit', (_label, body) => {
    const result = run({ AUDIT_SHIPPED_JSON: fixture(cleanShipped), AUDIT_FULL_JSON: fixture(body) });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Audit gate failed/);
  });

  it('fails when npm audit itself cannot run in the scoped project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-nolock-'));
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'no-lock', version: '1.0.0' }));
    const result = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', env: { ...process.env, AUDIT_SHIPPED_JSON: '', AUDIT_FULL_JSON: '' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Audit gate failed/);
    expect(result.stderr).not.toMatch(/Audit gate passed|No vulnerabilities/);
  });
});
