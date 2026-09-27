// Preload for subprocess tests of the diagnostic's Node-side deadlines.
const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
const mode = process.env.NAV_RUNNER_HANG_MODE;
const marker = process.env.NAV_RUNNER_CLEANUP_MARKER;
const never = () => new Promise(() => {});
if (mode === 'browser-launch' && process.env.NAV_STABILITY_WORKER === '1') setInterval(() => {}, 1000);
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
  launchServer: mode === 'browser-launch' ? never : async () => browserServer,
  connect: async () => browser
};
Module._load = function patchedLoad(request, parent, isMain) {
  if (parent?.filename.endsWith('/scripts/navigation-stability-check.js')) {
    if (request === 'playwright') return { chromium: browserType, firefox: browserType, webkit: browserType };
    if (request === './lib/playwright-static') return {
      startLocalStaticServer: async () => ({ url: 'http://127.0.0.1:4173', kill: () => fs.writeFileSync(marker, 'cleaned') }),
      waitForServer: async () => {}
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
