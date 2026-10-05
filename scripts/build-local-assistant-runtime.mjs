import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'utilities-src/local-assistant-runtime');
const scratch = path.join(root, '.codex-tmp/local-assistant-runtime-build');
const source = process.env.LOCAL_ASSISTANT_WLLAMA_SOURCE || path.join(scratch, 'wllama');
const sdk = process.env.LOCAL_ASSISTANT_EMSDK || path.join(scratch, 'emsdk');
const revisions = {
  wllama: '7ed17361caf221a84aa1e80ca85a3d6324f3af85',
  llamaCpp: '46ca246de9bb1c35269722a6240d37d9dfd79cad',
  emsdk: '96c657fc60920d2a6a82318aa50e0abf82749604',
  emscripten: '4.0.20',
  dawn: 'v20260317.182325',
};

function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.error || result.status}`);
  }
  return result.stdout?.trim();
}

async function checkout(directory, url, revision) {
  if (!existsSync(path.join(directory, '.git'))) {
    await mkdir(directory, { recursive: true });
    run('git', ['init', '--quiet'], directory);
    run('git', ['fetch', '--depth', '1', url, revision], directory);
    run('git', ['checkout', '--detach', 'FETCH_HEAD'], directory);
  }
  if (run('git', ['rev-parse', 'HEAD'], directory, true) !== revision) {
    throw new Error(`Unexpected checkout in ${directory}; refusing to reset existing work.`);
  }
}

function applyPatch(directory, name) {
  const patch = path.join(output, 'patches', name);
  const check = spawnSync('git', ['apply', '--check', patch], { cwd: directory });
  if (check.status === 0) return run('git', ['apply', patch], directory);
  const applied = spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: directory });
  if (applied.status !== 0) throw new Error(`Patch conflict: ${name}; existing source was preserved.`);
}

function emrun(command, args) {
  return run('bash', ['-c', 'source "$1/emsdk_env.sh" >/dev/null 2>&1; shift; exec "$@"', '--', sdk, command, ...args], source);
}

await mkdir(scratch, { recursive: true });
await checkout(source, 'https://github.com/ngxson/wllama.git', revisions.wllama);
run('git', ['submodule', 'update', '--init', '--depth', '1'], source);
if (run('git', ['rev-parse', 'HEAD'], path.join(source, 'llama.cpp'), true) !== revisions.llamaCpp) {
  throw new Error('Unexpected llama.cpp submodule revision.');
}
applyPatch(source, 'wllama-observatory.patch');
applyPatch(path.join(source, 'llama.cpp'), 'llama-observatory.patch');

await checkout(sdk, 'https://github.com/emscripten-core/emsdk.git', revisions.emsdk);
run(path.join(sdk, 'emsdk'), ['install', revisions.emscripten]);
run(path.join(sdk, 'emsdk'), ['activate', revisions.emscripten]);

const dawnDirectory = path.join(source, 'build/emdawn');
const dawnPackage = path.join(dawnDirectory, 'emdawnwebgpu_pkg');
if (!existsSync(dawnPackage)) {
  await mkdir(dawnDirectory, { recursive: true });
  const archive = path.join(dawnDirectory, 'emdawn.zip');
  run('curl', ['--fail', '--location', '--output', archive,
    `https://github.com/google/dawn/releases/download/${revisions.dawn}/emdawnwebgpu_pkg-${revisions.dawn}.zip`]);
  run('unzip', ['-q', archive, '-d', dawnDirectory]);
}

run('npm', ['ci', '--ignore-scripts'], source);
run('node', ['cpp/generate_glue_prototype.js'], source);
emrun('emcmake', ['cmake', '-S', '.', '-B', 'build-native', '-G', 'Ninja',
  '-DGGML_WEBGPU=ON', '-DGGML_WEBGPU_JSPI=ON', `-DEMDAWNWEBGPU_DIR=${dawnPackage}`,
  '-DWLLAMA_TEST_BACKEND=OFF', '-DCMAKE_BUILD_TYPE=Release']);
emrun('cmake', ['--build', 'build-native', '--target', 'wllama', '-j', '8']);
await cp(path.join(source, 'build-native/wllama.js'), path.join(source, 'src/wasm/wllama.js'));
await cp(path.join(source, 'build-native/wllama.wasm'), path.join(source, 'src/wasm/wllama.wasm'));
run('npm', ['run', 'build:worker'], source);
run('npm', ['run', 'build:tsup'], source);
run('npm', ['run', 'build:typedef'], source);

const dist = path.join(output, 'dist');
await mkdir(dist, { recursive: true });
await cp(path.join(source, 'esm'), dist, { recursive: true });
await rm(path.join(dist, 'index.cjs'), { force: true });
await cp(path.join(source, 'build-native/wllama.wasm'), path.join(dist, 'wllama.wasm'));
await cp(path.join(source, 'LICENCE'), path.join(output, 'LICENSE.wllama'));
await cp(path.join(source, 'llama.cpp/LICENSE'), path.join(output, 'LICENSE.llama.cpp'));

async function manifest(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await manifest(filename, name));
    else {
      const bytes = await readFile(filename);
      files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
  }
  return files;
}
await writeFile(path.join(output, 'provenance.json'), `${JSON.stringify({
  version: '3.8.1-observatory.2',
  revisions,
  features: ['WebGPU', 'WASM64', 'JSPI', 'GPU residual RMS reduction', 'token-aligned sampler telemetry'],
  patches: await manifest(path.join(output, 'patches')),
  files: await manifest(dist),
}, null, 2)}\n`);
console.log(`Built instrumented runtime in ${dist}`);
