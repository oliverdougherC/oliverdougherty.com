#!/usr/bin/env node
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer } = require('./lib/playwright-static');
const { assertIndexArrow } = require('./lib/index-arrow-check');

async function main() {
  const name = process.env.UTILITIES_BROWSER || 'chromium';
  const url = process.env.UTILITIES_CHECK_URL;
  const server = await startLocalStaticServer({ url: url || 'http://127.0.0.1:0', cwd: path.resolve(__dirname, '..'), skip: Boolean(url) });
  let browser;
  try {
    browser = await { chromium, firefox, webkit }[name].launch({
      headless: true,
      executablePath: process.env.INDEX_ARROW_BROWSER_EXECUTABLE || undefined
    });
    await assertIndexArrow(browser, server?.url || url, name);
  } finally {
    await browser?.close();
    server?.kill();
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
