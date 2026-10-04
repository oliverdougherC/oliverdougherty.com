#!/usr/bin/env node
/** Rebuild from pinned vendored Keiri; no remote service, npm dependency or browser generation. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(root, 'utilities-src/keiri');
const target = path.join(root, '.codex-tmp/keiri-target');
const manifest = path.join(engine, 'Cargo.toml');
const sysrootResult = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' });
if (sysrootResult.status !== 0) throw new Error('Rust toolchain is unavailable');
const sysroot = sysrootResult.stdout.trim();
const rustFlags = [`--remap-path-prefix=${root}=/keiri`, `--remap-path-prefix=${sysroot}=/rust`].join('\x1f');
const provenance = JSON.parse(readFileSync(path.join(engine, 'provenance.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = readFileSync(path.join(engine, 'vendor/keiri/src/lib.rs'));
if (hash(source) !== provenance.patchedSourceSha256) throw new Error('Vendored source changed; review the upstream patch and update provenance first');
// Reverse the checked-in cfg-only patch to prove the source is exactly the pinned upstream.
const proof = mkdtempSync(path.join(tmpdir(), 'keiri-provenance-'));
try {
  mkdirSync(path.join(proof, 'src'));
  copyFileSync(path.join(engine, 'vendor/keiri/src/lib.rs'), path.join(proof, 'src/lib.rs'));
  const result = spawnSync('git', ['apply', '--reverse', path.join(engine, 'wasm-target.patch')], { cwd: proof, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Source patch no longer reverses: ${result.stderr}`);
  if (hash(readFileSync(path.join(proof, 'src/lib.rs'))) !== provenance.upstreamSourceSha256) throw new Error('Source differs from pinned upstream after reversing patch');
} finally { rmSync(proof, { recursive: true, force: true }); }
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS: '', CARGO_ENCODED_RUSTFLAGS: rustFlags } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const rust = spawnSync('rustc', ['--version'], { encoding: 'utf8' });
if (!rust.stdout.startsWith(`rustc ${provenance.rustVersion} `)) throw new Error(`Use Rust ${provenance.rustVersion} for the reproducible build (installed: ${rust.stdout.trim()})`);
mkdirSync(target, { recursive: true });
if (process.argv.includes('--generate-table')) {
  const generated = path.join(target, 'bbg-anchor-v2.bin');
  run('cargo', ['run', '--locked', '--release', '--manifest-path', manifest, '--bin', 'generate-table', '--', generated]);
  copyFileSync(generated, path.join(engine, 'assets/bbg-anchor-v2.bin'));
}
run('cargo', ['test', '--locked', '--manifest-path', manifest, '--lib']);
run('cargo', ['build', '--locked', '--manifest-path', manifest, '--lib', '--target', 'wasm32-unknown-unknown', '--release']);
copyFileSync(path.join(target, 'wasm32-unknown-unknown/release/keiri_web.wasm'), path.join(engine, 'assets/keiri.wasm'));
chmodSync(path.join(engine, 'assets/keiri.wasm'), 0o644);
for (const name of ['keiri.wasm', 'bbg-anchor-v2.bin']) {
  const bytes = readFileSync(path.join(engine, 'assets', name));
  if (!process.argv.includes('--write-asset-hashes') && hash(bytes) !== provenance.assets[name].sha256) {
    throw new Error(`${name} differs from recorded provenance; inspect changes before explicitly refreshing asset hashes`);
  }
  console.log(`${name}: ${bytes.length} bytes; SHA-256 ${hash(bytes)}`);
}
if (process.argv.includes('--write-asset-hashes')) {
  for (const name of ['keiri.wasm', 'bbg-anchor-v2.bin']) {
    const bytes = readFileSync(path.join(engine, 'assets', name));
    provenance.assets[name] = { bytes: bytes.length, sha256: hash(bytes) };
  }
  writeFileSync(path.join(engine, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
}
