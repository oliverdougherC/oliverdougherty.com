#!/usr/bin/env node
// Verify that the Wrangler toolchain visible to deployment is exactly the
// one recorded in package-lock.json, without installing or downloading
// anything. Shared by PR CI (ci.yml "Security Audit") and the worker
// deployment workflow (deploy-worker.yml) so both paths run identical
// checks before cloudflare/wrangler-action@v3 consumes the toolchain.
//
// Checks, in order:
//   1. package-lock.json exists, parses, and its
//      packages["node_modules/wrangler"].version is a clean semver string.
//   2. node_modules/wrangler/package.json exists (the LOCAL install, never
//      an ancestor or global package), declares name "wrangler", and its
//      version equals the lockfile version.
//   3. node_modules/.bin/wrangler resolves inside node_modules/wrangler
//      (this is the binary `npx --no-install wrangler` finds, so proving
//      this proves the action consumes the same installation).
//   4. The local package's own bin script, executed directly with the
//      current node, exits 0 and prints exactly the locked version as its
//      entire trimmed stdout. Any nonzero exit, empty output, or extra
//      banner text fails.
//
// Exit 0 only when every check passes; each failure prints a specific
// reason to stderr and exits 1.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function fail(reason) {
  return { ok: false, reason };
}

export function verifyToolchain({
  projectDir,
  run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', cwd: projectDir })
} = {}) {
  const root = projectDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  // 1. Lockfile metadata
  const lockPath = path.join(root, 'package-lock.json');
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (e) {
    return fail(`cannot read/parse ${lockPath}: ${e.message}`);
  }
  const lockedVersion = lock?.packages?.['node_modules/wrangler']?.version;
  if (typeof lockedVersion !== 'string' || lockedVersion.length === 0) {
    return fail('package-lock.json is missing packages["node_modules/wrangler"].version');
  }
  if (!SEMVER_RE.test(lockedVersion)) {
    return fail(`package-lock.json wrangler version is malformed: ${JSON.stringify(lockedVersion)}`);
  }

  // 2. Local installed package (explicit path; never require.resolve upward)
  const pkgDir = path.join(root, 'node_modules', 'wrangler');
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch (e) {
    return fail(`local wrangler installation not found or unreadable at ${pkgDir}: ${e.message}`);
  }
  if (pkg.name !== 'wrangler') {
    return fail(`node_modules/wrangler/package.json declares unexpected name: ${JSON.stringify(pkg.name)}`);
  }
  if (typeof pkg.version !== 'string' || !SEMVER_RE.test(pkg.version)) {
    return fail(`installed wrangler package.json version is malformed: ${JSON.stringify(pkg.version)}`);
  }
  if (pkg.version !== lockedVersion) {
    return fail(`version drift: lockfile wants ${lockedVersion}, installed package is ${pkg.version}`);
  }

  // 3. The npx-visible bin must be the checked package's bin
  const binLink = path.join(root, 'node_modules', '.bin', 'wrangler');
  let binTarget;
  try {
    binTarget = fs.realpathSync(binLink);
  } catch (e) {
    return fail(`node_modules/.bin/wrangler is missing: ${e.message}`);
  }
  if (!binTarget.startsWith(fs.realpathSync(pkgDir) + path.sep)) {
    return fail(`node_modules/.bin/wrangler resolves outside the checked package: ${binTarget}`);
  }

  // 4. Execute the checked package's own bin; exact output, clean exit
  const relBin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.wrangler;
  if (typeof relBin !== 'string' || relBin.length === 0) {
    return fail('installed wrangler package.json declares no string bin entry');
  }
  const binPath = path.resolve(pkgDir, relBin);
  if (!fs.existsSync(binPath)) {
    return fail(`installed wrangler bin does not exist: ${binPath}`);
  }
  const result = run([binPath, '--version']);
  if (result.error) {
    return fail(`failed to execute local wrangler CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    return fail(`local wrangler CLI exited ${result.status} (stdout: ${JSON.stringify(result.stdout?.trim())})`);
  }
  const reported = (result.stdout ?? '').trim();
  if (reported.length === 0) {
    return fail('local wrangler CLI printed no version on stdout');
  }
  if (!SEMVER_RE.test(reported)) {
    return fail(`local wrangler CLI printed malformed version: ${JSON.stringify(reported)}`);
  }
  if (reported !== lockedVersion) {
    return fail(`version drift: lockfile wants ${lockedVersion}, local CLI reports ${reported}`);
  }

  return { ok: true, version: lockedVersion };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = verifyToolchain({ projectDir: process.cwd() });
  if (outcome.ok) {
    console.log(`verified: local wrangler ${outcome.version} matches package-lock.json`);
    process.exit(0);
  }
  console.error(`wrangler toolchain verification FAILED: ${outcome.reason}`);
  process.exit(1);
}