#!/usr/bin/env node
// Algorithm microbenchmark, not a utilization or whole-browser throughput measurement.
// Run from the repository root: node scripts/stress-prime-bench.js
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');

// Previous production primality test, retained here only for reproducible comparison.
const baseline = `
function isPrime(candidate) {
  if (!Number.isSafeInteger(candidate) || candidate < 2) return false;
  if (candidate === 2 || candidate === 3) return true;
  if (candidate % 2 === 0 || candidate % 3 === 0) return false;
  const limit = Math.floor(Math.sqrt(candidate));
  for (let divisor = 5; divisor <= limit; divisor += 6) {
    if (candidate % divisor === 0 || candidate % (divisor + 2) === 0) return false;
  }
  return true;
}`;

function compileRunner(source, runner) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  // Both full-interval loops execute as ordinary functions in the same V8 realm.
  return new Function('exports', `${compiled}\n${runner}\nreturn exports.run;`)({});
}

const trial = compileRunner(baseline, `
exports.run = function(high) {
  let count = 1, last = 2;
  for (let n = 3; n <= high; n += 2) {
    if (isPrime(n)) { count++; last = n; }
  }
  return { count, last };
};`);

const sieve = compileRunner(fs.readFileSync('utilities-src/src/stressTestPrimes.ts', 'utf8'), `
exports.run = function(high) {
  const sieve = new SegmentedPrimeSieve();
  const batch = exports.PRIME_SEGMENT_ODDS * 2;
  let count = 0, last = 0;
  for (let low = 1; low <= high; low += batch) {
    const result = sieve.sieve(low, Math.min(high, low + batch - 1));
    count += result.primesFound;
    last = Math.max(last, result.latestPrime);
  }
  return { count, last };
};`);

for (let round = 0; round < 3; round++) {
  trial(100000);
  sieve(100000);
}

const high = 10000000;
const timings = { trial: [], sieve: [] };
let result;
for (let round = 0; round < 3; round++) {
  for (const [name, run] of [['trial', trial], ['sieve', sieve]]) {
    const start = performance.now();
    result = run(high);
    timings[name].push(performance.now() - start);
    if (result.count !== 664579 || result.last !== 9999991) {
      throw new Error(`${name} returned incorrect prime results: ${JSON.stringify(result)}`);
    }
  }
}

const median = values => [...values].sort((a, b) => a - b)[1];
const report = {
  range: [1, high], threads: 1, rounds: 3, includesBasePrimeSetup: true,
  method: 'Same-realm compiled loops; three warmups through 100000. Fresh sieve cache each run. Excludes worker startup/communication.',
  result, ms: timings,
  medianMs: { trial: median(timings.trial), sieve: median(timings.sieve) },
  speedup: median(timings.trial) / median(timings.sieve)
};
fs.mkdirSync('output/stress-bench', { recursive: true });
fs.writeFileSync('output/stress-bench/prime-comparison.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
