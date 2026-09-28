// Preload for subprocess tests of the diagnostic's Node-side deadlines.
const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
const mode = process.env.NAV_RUNNER_HANG_MODE;
const marker = process.env.NAV_RUNNER_CLEANUP_MARKER;
const never = () => new Promise(() => {});
if (mode === 'windows-browser-launch') Object.defineProperty(process, 'platform', { value: 'win32' });
if ((mode === 'browser-launch' || mode === 'windows-browser-launch') &&
    process.env.NAV_STABILITY_WORKER === '1') setInterval(() => {}, 1000);
const page = {
  on() {},
  setDefaultTimeout() {},
  setDefaultNavigationTimeout() {},
  goto: async () => {},
  waitForFunction: async () => ({ jsonValue: async () => 'ready' }),
  waitForURL: async () => {},
  goBack: async () => {},
  goForward: async () => {},
  url: () => 'http://127.0.0.1:4173/index.html',
  locator: () => ({ count: async () => 1, click: async () => {}, first() { return this; } }),
  evaluate: mode === 'evaluation' ? never : async () => true,
  close: async () => {}
};
const context = {
  newPage: async () => page,
  close: mode === 'context-close' ? never : async () => {}
};
const browser = {
  newContext: async () => context,
  close: mode === 'browser-close' ? never : async () => {}
};
const browserServer = {
  wsEndpoint: () => 'ws://owned-browser',
  close: mode === 'browser-close' ? never : async () => {},
  kill: mode === 'browser-close' ? never : async () => {},
  process: () => ({ kill: () => { throw new Error('forced cleanup failed'); } })
};
const browserType = {
  launch: async () => browser,
  launchServer: mode === 'browser-launch' || mode === 'windows-browser-launch' ? never : async () => browserServer,
  connect: async () => browser
};
let ownedPid;
let taskkillCalls = 0;
Module._load = function patchedLoad(request, parent, isMain) {
  if (parent?.filename.replace(/\\/g, '/').endsWith('/scripts/navigation-stability-check.js')) {
    if (request === 'node:child_process' && mode === 'windows-browser-launch') {
      const childProcess = originalLoad.call(this, request, parent, isMain);
      return {
        ...childProcess,
        spawn(...args) {
          const child = childProcess.spawn(...args);
          ownedPid = child.pid;
          fs.appendFileSync(process.env.NAV_RUNNER_WINDOWS_LOG, `${JSON.stringify({ kind: 'spawn', pid: ownedPid })}\n`);
          return child;
        },
        execFileSync(command, args, options) {
          if (command !== 'taskkill') return childProcess.execFileSync(command, args, options);
          taskkillCalls++;
          fs.appendFileSync(process.env.NAV_RUNNER_WINDOWS_LOG, `${JSON.stringify({ kind: 'taskkill', command, args })}\n`);
          // Simulate either an effective initial taskkill or one that requires
          // the forced attempt. Only the real test-owned worker is terminated.
          if (taskkillCalls === Number(process.env.NAV_RUNNER_WINDOWS_KILL_ATTEMPT || 2)) {
            process.kill(ownedPid, 'SIGKILL');
            fs.appendFileSync(process.env.NAV_RUNNER_WINDOWS_LOG, `${JSON.stringify({ kind: 'terminated', pid: ownedPid })}\n`);
          }
        }
      };
    }
    if (request === 'playwright') return { chromium: browserType, firefox: browserType, webkit: browserType };
    if (request === './lib/playwright-static') return {
      startLocalStaticServer: async () => ({ url: 'http://127.0.0.1:4173', kill: () => fs.writeFileSync(marker, 'cleaned') }),
      waitForServer: async () => {}
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
