#!/usr/bin/env node
// Local preview server for the site.
//
// The utilities workbench runs built bundles, not source: pages/utilities/index.html
// imports a compatibility loader in pages/utilities/assets, that loader imports the
// hashed entry, the entry lazily loads controller chunks, and a controller chunk
// spawns module workers. Serving the repository without rebuilding therefore serves
// whatever was built last — a page that looks current while running old code, which
// is exactly how a stale preview once made a fix look ineffective. So `npm run serve`
// rebuilds the utilities before it listens, then verifies the graph it is about to
// serve: the HTML's script, the loader's entry, every emitted chunk, the chunk each
// tool lazy-loads, and every worker file a chunk references. Worker files are emitted
// into a nested assets folder and named only from inside a chunk, so a missing one is
// invisible until the page throws a 404 at runtime — nothing else proves it exists.
//
// A different STATIC_ROOT is not ours to write into — usually a built deploy artifact
// — so there the same verification runs read-only and staleness is reported with the
// command to fix it instead of being silently served. SKIP_UTILITIES_BUILD=1 skips
// the rebuild of the repository tree; the verification still runs.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { startLocalStaticServer } = require('./lib/playwright-static');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.STATIC_ROOT ? path.resolve(process.env.STATIC_ROOT) : REPO_ROOT;
const SERVING_REPO = ROOT === REPO_ROOT;
const PORT = Number(process.env.PORT || process.argv[2] || 4173);
const URL = `http://127.0.0.1:${PORT}`;
// Everything whose mtime means "the built bundles may no longer describe the code".
const BUILD_INPUTS = ['utilities-src', 'config/vite.utilities.mts', 'package.json', 'pages/utilities/index.html'];
const LAZY_CHUNKS = ['audioFourierController', 'retroVmController', 'stressTestController'];

function newestMtime(target) {
  const stats = fs.statSync(target);
  if (!stats.isDirectory()) return stats.mtimeMs;
  let newest = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    newest = Math.max(newest, newestMtime(path.join(target, entry.name)));
  }
  return newest;
}

function newestInputMtime(root) {
  return BUILD_INPUTS
    .map(input => path.join(root, input))
    .filter(input => fs.existsSync(input))
    .map(input => newestMtime(input))
    .reduce((newest, mtime) => Math.max(newest, mtime), 0);
}

function buildUtilities(root) {
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) throw new Error(`Vite is not installed at ${path.relative(root, vite)}. Run npm install first.`);
  console.log('Building utilities — pages/utilities runs built bundles, not source…');
  const result = spawnSync(process.execPath, [vite, 'build', '--config', path.join('config', 'vite.utilities.mts')],
    { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Utilities build failed (exit ${result.status}). Fix the build, or serve with SKIP_UTILITIES_BUILD=1 to preview the committed bundles.`);
  }
}

function importedSpecifiers(code) {
  return [...code.matchAll(/(?:^|[;}\n])\s*import\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
}

/**
 * Resolves the module graph the served page will actually load, from the files on
 * disk. Anything missing here fails the serve rather than the browser session,
 * because every one of these failures is a blank panel or a tool that never starts.
 */
function inspectUtilitiesBundle(root) {
  const assetsDir = path.join(root, 'pages', 'utilities', 'assets');
  const manifestPath = path.join(assetsDir, '.vite', 'manifest.json');
  if (!fs.existsSync(assetsDir) || !fs.existsSync(manifestPath)) {
    throw new Error(`No built utilities at ${path.relative(root, assetsDir)}. Run npm run utilities:build, or serve the repository root so npm run serve builds them.`);
  }
  const problems = [];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = Object.values(manifest);
  if (!entries.some(entry => entry.isEntry)) throw new Error(`${path.relative(root, manifestPath)} declares no entry chunk.`);
  for (const entry of entries) {
    if (!fs.existsSync(path.join(assetsDir, entry.file))) problems.push(`manifest declares ${entry.file}, which is not on disk`);
  }
  for (const chunk of LAZY_CHUNKS) {
    if (!entries.some(entry => entry.name === chunk)) problems.push(`no lazy-loaded chunk for ${chunk}; that tool cannot start`);
  }

  // The page imports whatever its script tag names: the compatibility loader in the
  // repository, the hashed entry itself in a deploy artifact. Either way the file it
  // names, and anything that file re-imports, must exist.
  const html = path.join(root, 'pages', 'utilities', 'index.html');
  const htmlSource = fs.readFileSync(html, 'utf8');
  const servedScripts = [...htmlSource.matchAll(/<script\b[^>]*\bsrc="([^"?#]+)(?:[^"]*)"[^>]*>/g)]
    .filter(match => /utilities-app/.test(match[1]))
    .map(match => match[1].replace(/^\.\//, ''));
  if (servedScripts.length === 0) problems.push('pages/utilities/index.html imports no utilities entry');
  for (const script of servedScripts) {
    const scriptPath = path.join(root, 'pages', 'utilities', script);
    if (!fs.existsSync(scriptPath)) {
      problems.push(`the page imports ${script}, which is not on disk`);
      continue;
    }
    for (const specifier of importedSpecifiers(fs.readFileSync(scriptPath, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      if (!fs.existsSync(path.resolve(path.dirname(scriptPath), specifier))) {
        problems.push(`${script} imports ${specifier}, which is not on disk (the build and the page disagree)`);
      }
    }
  }

  // Workers are emitted into a nested assets folder and named from inside a chunk,
  // so this is the only place their existence can be checked before a browser asks.
  for (const chunk of fs.readdirSync(assetsDir).filter(name => name.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(assetsDir, chunk), 'utf8');
    for (const worker of new Set(code.match(/[\w.-]+\.worker-[\w-]+\.js/g) ?? [])) {
      const candidates = [path.join(assetsDir, worker), path.join(assetsDir, 'assets', worker)];
      if (!candidates.some(candidate => fs.existsSync(candidate))) {
        problems.push(`${chunk} spawns ${worker}, which is not on disk`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`The utilities bundles about to be served are not loadable:\n  - ${problems.join('\n  - ')}`);
  }
  return { builtAt: fs.statSync(manifestPath).mtimeMs, newestSource: newestInputMtime(root) };
}

async function main() {
  const skipBuild = process.env.SKIP_UTILITIES_BUILD === '1';
  if (SERVING_REPO && !skipBuild) buildUtilities(ROOT);
  const bundle = inspectUtilitiesBundle(ROOT);

  if (bundle.newestSource > bundle.builtAt) {
    const advice = SERVING_REPO
      ? (skipBuild ? 'Re-run without SKIP_UTILITIES_BUILD=1, or run npm run utilities:build.' : 'The rebuild did not pick these up; run npm run utilities:build and check the build output.')
      : 'This tree is not built by npm run serve. Run npm run utilities:build and copy pages/utilities into it, or serve the repository root instead.';
    console.warn(`Warning: utilities source is newer than the bundles being served. ${advice}`);
  }

  const server = await startLocalStaticServer({ url: URL, cwd: ROOT, cacheControl: process.env.STATIC_CACHE_CONTROL || 'no-cache' });
  console.log(`Serving ${ROOT}`);
  console.log(`Utilities bundles verified: entry, lazy chunks and worker files all present${SERVING_REPO && !skipBuild ? ' (rebuilt)' : ' (as built)'}.`);
  console.log(`Local: ${server.url}`);
  console.log('Press Ctrl+C to stop.');
}

main().catch((error) => {
  console.error(`Failed to start static server: ${error.message}`);
  process.exitCode = 1;
});
