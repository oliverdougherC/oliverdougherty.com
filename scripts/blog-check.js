#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const {
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', 'blog-check');
const BLOG_POST_URL = '/pages/blog/index.html?full=1#post=it-s-time-to-use-ai-properly';
const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';
let baseUrl = process.env.BLOG_CHECK_URL || DEFAULT_BASE_URL;

const VIEWPORTS = [
  { label: 'desktop', width: 1280, height: 900 },
  { label: 'narrow', width: 390, height: 844 }
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function collectBlogLayoutState(page) {
  return page.evaluate(() => {
    const body = document.querySelector('.blog-body');
    const firstParagraph = body ? body.querySelector('p') : null;
    const codeBlocks = body ? Array.from(body.querySelectorAll('pre.blog-code-block, pre')) : [];

    return {
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      paragraphRight: firstParagraph ? firstParagraph.getBoundingClientRect().right : null,
      copyButtonCount: body ? body.querySelectorAll('.blog-code-copy').length : 0,
      shellCount: body ? body.querySelectorAll('.blog-code-block-shell').length : 0,
      codeBlocks: codeBlocks.map((pre) => ({
        scrollWidth: pre.scrollWidth,
        clientWidth: pre.clientWidth,
        right: pre.getBoundingClientRect().right,
        hasBlogClass: pre.classList.contains('blog-code-block'),
        hasShell: Boolean(pre.closest('.blog-code-block-shell')),
        scrollbarColor: getComputedStyle(pre).scrollbarColor
      }))
    };
  });
}

async function assertBlogLayout(page, label) {
  await page.waitForSelector('.blog-body pre', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.highlightBlogCode === 'function', { timeout: 5000 });
  await page.evaluate(() => window.highlightBlogCode());

  const state = await collectBlogLayoutState(page);
  const tolerance = 2;

  assert(
    state.scrollWidth <= state.width + 1,
    `[${label}] document overflows horizontally: ${state.scrollWidth} > ${state.width}`
  );
  assert(
    state.bodyScrollWidth <= state.width + 1,
    `[${label}] body overflows horizontally: ${state.bodyScrollWidth} > ${state.width}`
  );

  assert(state.paragraphRight !== null, `[${label}] blog post is missing paragraph content`);
  assert(
    state.paragraphRight <= state.width + tolerance,
    `[${label}] paragraph extends past viewport (${state.paragraphRight} > ${state.width})`
  );

  assert(state.codeBlocks.length > 0, `[${label}] expected at least one code block`);
  assert(
    state.copyButtonCount === state.codeBlocks.length,
    `[${label}] expected one copy button per code block (${state.copyButtonCount} vs ${state.codeBlocks.length})`
  );
  assert(
    state.shellCount === state.codeBlocks.length,
    `[${label}] expected one code block shell per block (${state.shellCount} vs ${state.codeBlocks.length})`
  );
  state.codeBlocks.forEach((block, index) => {
    assert(block.hasBlogClass, `[${label}] code block ${index} missing blog-code-block class`);
    assert(block.hasShell, `[${label}] code block ${index} missing blog-code-block-shell wrapper`);
    assert(
      block.right <= state.width + tolerance,
      `[${label}] code block ${index} extends past viewport (${block.right} > ${state.width})`
    );
    assert(
      /254,\s*208,\s*187|#fed0bb/i.test(block.scrollbarColor),
      `[${label}] code block ${index} scrollbar should use blog flare color`
    );
  });

  const scrollableBlock = state.codeBlocks.find((block) => block.scrollWidth > block.clientWidth + 1);
  assert(
    scrollableBlock,
    `[${label}] expected a horizontally scrollable code block (scrollWidth > clientWidth)`
  );
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const server = await startLocalStaticServer({
    url: baseUrl,
    cwd: ROOT,
    skip: Boolean(process.env.BLOG_CHECK_URL),
    bindHost: null
  });
  baseUrl = server?.url || baseUrl;

  let browser;

  try {
    await waitForServer(baseUrl);
    browser = await chromium.launch({ headless: true });

    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }
      });
      const page = await context.newPage();

      await page.goto(`${baseUrl}${BLOG_POST_URL}`, { waitUntil: 'networkidle' });
      await assertBlogLayout(page, viewport.label);
      await page.screenshot({
        path: path.join(OUTPUT_DIR, `${viewport.label}-blog-code-block.png`),
        fullPage: false
      });

      await context.close();
      console.log(`Verified blog code block layout at ${viewport.label} (${viewport.width}px).`);
    }
  } finally {
    if (browser) await browser.close();
    if (server) server.kill('SIGTERM');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
