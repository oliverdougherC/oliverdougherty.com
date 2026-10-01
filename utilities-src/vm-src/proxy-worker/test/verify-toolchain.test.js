import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyToolchain } from '../scripts/verify-toolchain.mjs';

// Build a minimal fake worker project: lockfile + local wrangler package +
// .bin symlink. `cli` controls what the fake bin prints/exits so tests can
// stub CLI behavior without spawning anything.
function makeProject({
  lockVersion = '4.116.0',
  installedVersion = '4.116.0',
  pkgName = 'wrangler',
  omitLockEntry = false,
  lockRaw = null,
  omitPackage = false,
  omitBin = false,
  binTargetOutside = false,
  binField = 'bin/wrangler.js'
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-toolchain-'));
  const pkgDir = path.join(dir, 'node_modules', 'wrangler');
  const binDir = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });

  if (lockRaw !== null) {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), lockRaw);
  } else {
    const lock = { name: 'proxy-worker', lockfileVersion: 3, packages: { '': {}, 'node_modules/wrangler': { version: lockVersion } } };
    if (omitLockEntry) delete lock.packages['node_modules/wrangler'];
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
  }

  if (!omitPackage) {
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version: installedVersion, bin: { wrangler: binField } }));
    const realBinDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(path.join(realBinDir, 'wrangler.js'), '// fake bin\n');
  }

  if (!omitBin) {
    if (binTargetOutside) {
      const outside = path.join(dir, 'elsewhere.js');
      fs.writeFileSync(outside, '// outside bin\n');
      fs.symlinkSync(outside, path.join(binDir, 'wrangler'));
    } else {
      fs.symlinkSync(path.join(pkgDir, 'bin', 'wrangler.js'), path.join(binDir, 'wrangler'));
    }
  }
  return dir;
}

const cli = (stdout, status = 0) => () => ({ stdout, status, error: undefined });

test('accepts a correct installation where every layer agrees', () => {
  const dir = makeProject();
  const outcome = verifyToolchain({ projectDir: dir, run: cli('4.116.0\n') });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.version, '4.116.0');
});

test('rejects version drift between lockfile and installed package', () => {
  const dir = makeProject({ lockVersion: '4.116.0', installedVersion: '4.117.0' });
  const outcome = verifyToolchain({ projectDir: dir, run: cli('4.117.0\n') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /version drift: lockfile wants 4\.116\.0, installed package is 4\.117\.0/);
});

test('rejects a CLI that reports a different version than the package declares', () => {
  const dir = makeProject();
  const outcome = verifyToolchain({ projectDir: dir, run: cli('9.9.9\n') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /local CLI reports 9\.9\.9/);
});

test('rejects a missing lockfile wrangler entry', () => {
  const dir = makeProject({ omitLockEntry: true });
  const outcome = verifyToolchain({ projectDir: dir, run: cli('4.116.0\n') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /missing packages\["node_modules\/wrangler"\]\.version/);
});

test('rejects malformed lockfile metadata', () => {
  const dir = makeProject({ lockRaw: '{ not json' });
  const outcome = verifyToolchain({ projectDir: dir, run: cli('4.116.0\n') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /cannot read\/parse/);
});

test('rejects a non-semver lockfile version', () => {
  const dir = makeProject({ lockVersion: '4.116.0 (update available 5.0.0)' });
  const outcome = verifyToolchain({ projectDir: dir, run: cli('4.116.0\n') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /malformed/);
});

test('rejects a missing local installation without consulting ancestors', () => {
  const dir = makeProject({ omitPackage: true });
  const outcome = verifyToolchain({ projectDir: dir, run: cli('4.116.0\n') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /local wrangler installation not found/);
});

test('rejects a foreign package squatting node_modules/wrangler', () => {
  const dir = makeProject({ pkgName: 'some-other-tool' });
  const outcome = verifyToolchain({ projectDir: dir, run: cli('4.116.0\n') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /unexpected name/);
});

test('rejects a .bin/wrangler that resolves outside the checked package', () => {
  const dir = makeProject({ binTargetOutside: true });
  const outcome = verifyToolchain({ projectDir: dir, run: cli('4.116.0\n') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /resolves outside the checked package/);
});

test('rejects a missing .bin/wrangler', () => {
  const dir = makeProject({ omitBin: true });
  const outcome = verifyToolchain({ projectDir: dir, run: cli('4.116.0\n') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /\.bin\/wrangler is missing/);
});

test('rejects empty CLI stdout even with exit 0', () => {
  const dir = makeProject();
  const outcome = verifyToolchain({ projectDir: dir, run: cli('') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /printed no version/);
});

test('rejects malformed CLI output (banner noise) even with exit 0', () => {
  const dir = makeProject();
  const outcome = verifyToolchain({ projectDir: dir, run: cli('\n ⛅️ wrangler 4.116.0 (update available 4.99.0)\n') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /malformed version/);
});

test('rejects a failing CLI with no output', () => {
  const dir = makeProject();
  const outcome = verifyToolchain({ projectDir: dir, run: cli('', 1) });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /exited 1/);
});

test('rejects a CLI that prints a plausible version but exits nonzero', () => {
  const dir = makeProject();
  const outcome = verifyToolchain({ projectDir: dir, run: cli('4.116.0\n', 7) });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /exited 7/);
});

test('rejects a CLI process that cannot be spawned', () => {
  const dir = makeProject();
  const outcome = verifyToolchain({ projectDir: dir, run: () => ({ stdout: '', status: null, error: new Error('ENOENT') }) });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /failed to execute local wrangler CLI/);
});

test('rejects a package whose declared bin file is absent', () => {
  // .bin/wrangler itself resolves fine (bin/wrangler.js exists), but the
  // package.json bin field points at a different, missing file.
  const dir = makeProject({ binField: 'bin/gone.js' });
  const outcome = verifyToolchain({ projectDir: dir, run: cli('4.116.0\n') });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /bin does not exist/);
});
