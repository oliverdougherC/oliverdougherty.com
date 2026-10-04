#!/usr/bin/env node

// Exercises the shipped engine/table through the public UI. Only randomness and
// network delivery are controlled; no bot decisions or game state are injected.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const STORAGE_KEY = 'od.yahtzee-keiri.v1';
const RULES_WASM_URL = /\/keiri-[^/]*\.wasm(?:\?.*)?$/;
const TABLE_URL = /\/bbg-anchor[^/]*\.bin(?:\?.*)?$/;
const APP = '#yahtzeeKeiriApp';
const OUTPUT = path.join(ROOT, 'output', 'yahtzee');

async function createPage(browser, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce', ...options });
  await page.addInitScript(() => {
    // Persist the seed through reload, just as a real random stream continues.
    crypto.getRandomValues = function (array) {
      let seed = Number(sessionStorage.getItem('yahtzee-check.seed')) || 0x1a2b3c4d;
      for (let i = 0; i < array.length; i += 1) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
        array[i] = seed;
      }
      sessionStorage.setItem('yahtzee-check.seed', String(seed));
      return array;
    };
  });
  return page;
}

async function saved(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
}

async function waitForSaved(page, turn, count) {
  await page.waitForFunction(({ key, turn, count }) => {
    const state = JSON.parse(localStorage.getItem(key) || 'null');
    return state?.match.turn === turn && (count === undefined || state.match.keiri.scores.filter(score => score !== null).length === count);
  }, { key: STORAGE_KEY, turn, count }, { timeout: 30000 });
  return saved(page);
}

async function navigate(page, id) {
  await page.evaluate(route => { location.hash = route; }, id);
  await page.waitForFunction(route => document.querySelector(`.utility-stage[data-utility-id="${route}"]`)?.classList.contains('is-active'), id);
}

async function openGame(page, baseUrl) {
  await page.goto(`${baseUrl}/pages/utilities/index.html#yahtzee-keiri`, { waitUntil: 'domcontentloaded' });
  await page.locator(APP).waitFor({ state: 'visible' });
}

async function assertFits(page, label) {
  const problems = await page.evaluate(selector => {
    const board = document.querySelector(selector);
    const problems = [];
    const width = innerWidth;
    const height = innerHeight;
    if (document.documentElement.scrollWidth > width + 1 || document.documentElement.scrollHeight > height + 1) problems.push('document scrolls');
    for (const node of [board, ...board.querySelectorAll('*')]) {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden' || node.closest('[hidden]')) continue;
      // Screen-reader-only live regions deliberately use an offscreen box.
      if (style.clip !== 'auto' || style.clipPath === 'inset(50%)') continue;
      if (box.left < -1 || box.top < -1 || box.right > width + 1 || box.bottom > height + 1) problems.push(`${node.tagName}#${node.id}.${node.className}: outside viewport ${JSON.stringify({ left: box.left, top: box.top, right: box.right, bottom: box.bottom })}`);
      if (['auto', 'scroll'].includes(style.overflowY) && node.scrollHeight > node.clientHeight + 1) problems.push(`${node.id || node.className}: scrolls vertically`);
      if (['auto', 'scroll'].includes(style.overflowX) && node.scrollWidth > node.clientWidth + 1) problems.push(`${node.id || node.className}: scrolls horizontally`);
    }
    return problems;
  }, APP);
  assert.deepEqual(problems, [], `${label}: ${problems.join('; ')}`);
}

async function waitForEngine(page, phase = 'ready') {
  await page.waitForFunction(({ selector, phase }) => document.querySelector(selector)?.dataset.engineState === phase, { selector: APP, phase }, { timeout: 60000 });
}

async function roll(page) {
  await page.locator(`${APP} [data-roll]`).click();
  await page.locator(`${APP} [data-score]:enabled`).first().waitFor();
}

async function scoreFirst(page) {
  await page.locator(`${APP} [data-score]:enabled`).first().click();
}

async function assertLoadingAndRetry(browser, baseUrl) {
  const page = await createPage(browser);
  let release;
  const delivery = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(TABLE_URL, async route => {
    requests += 1;
    await delivery;
    await route.continue();
  });
  try {
    await page.goto(`${baseUrl}/pages/utilities/index.html`, { waitUntil: 'networkidle' });
    assert.equal(requests, 0, 'The index must not fetch the exact table');
    await navigate(page, 'stress-test');
    assert.equal(requests, 0, 'Other tools must not fetch the exact table');
    await page.locator('.nav-back-btn').click();
    await page.locator('[data-utility="yahtzee-keiri"]').click();
    await page.locator(APP).waitFor({ state: 'visible' });
    await roll(page);
    assert.equal((await saved(page)).match.turn, 'human', 'Human begins while the exact table is blocked');
    assert.equal(await page.locator(`${APP} [data-progress]`).getAttribute('value'), null, 'Unknown-length download must be indeterminate');
    await scoreFirst(page);
    const waiting = await saved(page);
    assert.equal(waiting.match.turn, 'keiri');
    assert.equal(waiting.match.keiri.scores.filter(value => value !== null).length, 0, 'No heuristic fallback may play while pending');
    await navigate(page, 'stress-test');
    await navigate(page, 'yahtzee-keiri');
    assert.deepEqual((await saved(page)).match, waiting.match, 'Switching during download preserves the human turn');
    assert.equal(requests, 1, 'Reactivation must reuse the in-flight table request');
    release();
    await waitForEngine(page);
    await waitForSaved(page, 'human', 1);
    assert.equal(requests, 1);
    assert.deepEqual(errors, [], 'Loading and route changes must not throw browser errors');
  } finally {
    release();
    await page.close();
  }

  for (const mode of ['404', 'interrupted', 'corrupt', 'truncated', 'version', 'checksum']) {
    const failedPage = await createPage(browser);
    let shouldFail = true;
    await failedPage.route(TABLE_URL, async route => {
      if (!shouldFail) return route.continue();
      if (mode === '404') return route.fulfill({ status: 404, body: 'Missing exact table' });
      if (mode === 'interrupted') return route.abort('connectionreset');
      const response = await route.fetch();
      let body = Buffer.from(await response.body());
      if (mode === 'corrupt') body[0] ^= 255;
      if (mode === 'truncated') body = body.subarray(0, body.length - 16);
      if (mode === 'version') body.writeUInt32LE(0xffffffff, 8);
      if (mode === 'checksum') body[body.length - 1] ^= 1;
      await route.fulfill({ response, body });
    });
    try {
      await openGame(failedPage, baseUrl);
      await roll(failedPage);
      await scoreFirst(failedPage);
      await waitForEngine(failedPage, 'failed');
      const before = await saved(failedPage);
      assert.equal(before.match.turn, 'keiri', `${mode}: entire first human turn remains playable`);
      assert.equal(before.match.keiri.scores.filter(value => value !== null).length, 0, `${mode}: invalid exact engine must not play`);
      assert(await failedPage.locator(`${APP} [data-retry]`).isVisible(), `${mode}: visible retry`);
      shouldFail = false;
      await failedPage.locator(`${APP} [data-retry]`).click();
      await waitForEngine(failedPage);
      const after = await waitForSaved(failedPage, 'human', 1);
      assert.deepEqual(after.match.human, before.match.human, `${mode}: retry preserves the scorecard`);
      assert.deepEqual(after.record, before.record, `${mode}: retry preserves the rivalry`);
    } finally {
      await failedPage.close();
    }
  }
  console.log('Yahtzee: lazy loading, pending first turn, validation failures and retry passed.');
}

async function assertByteProgress(browser, baseUrl) {
  const page = await createPage(browser);
  let release;
  const tail = new Promise(resolve => { release = resolve; });
  let bytes;
  const streamServer = http.createServer(async (_request, response) => {
    response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
    response.write(bytes.subarray(0, 262144));
    await tail;
    response.end(bytes.subarray(262144));
  });
  await new Promise(resolve => streamServer.listen(0, '127.0.0.1', resolve));
  await page.route(TABLE_URL, async route => {
    bytes = Buffer.from(await (await route.fetch()).body());
    await route.continue({ url: `http://127.0.0.1:${streamServer.address().port}/exact-table` });
  });
  try {
    await openGame(page, baseUrl);
    await page.waitForFunction(selector => {
      const progress = document.querySelector(`${selector} [data-progress]`);
      return progress?.hasAttribute('value') && progress.value > 0 && progress.value < progress.max;
    }, APP, { timeout: 30000 });
    const progress = await page.locator(`${APP} [data-progress]`).evaluate(node => ({ value: node.value, max: node.max }));
    assert.equal(progress.max, bytes.length, 'Determinate total reflects actual response Content-Length');
    assert(progress.value <= 262144, 'Progress never exceeds actual received bytes');
    await roll(page);
    await scoreFirst(page);
    assert.equal((await saved(page)).match.turn, 'keiri');
    release();
    await waitForEngine(page);
    await waitForSaved(page, 'human', 1);
  } finally {
    release();
    await page.close();
    streamServer.closeAllConnections();
    await new Promise(resolve => streamServer.close(resolve));
  }
  console.log('Yahtzee: real streamed byte progress and first-turn play passed.');
}

async function assertMatchAndPersistence(browser, baseUrl) {
  const page = await createPage(browser);
  const errors = [];
  let tableRequests = 0;
  page.on('request', request => { if (TABLE_URL.test(request.url())) tableRequests += 1; });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await openGame(page, baseUrl);
    await waitForEngine(page);
    assert.equal((await saved(page)).match.turn, 'human');
    await page.locator(`${APP} [data-roll]`).focus();
    await page.keyboard.press('Enter');
    await page.locator(`${APP} [data-score]:enabled`).first().waitFor();
    const initial = await saved(page);
    const ones = initial.match.dice.filter(face => face === 1).length;
    assert.equal(await page.locator(`${APP} [data-score="0"]`).textContent(), String(ones), 'Preview reflects actual dice');
    assert(await page.locator(`${APP} [data-score="0"]`).evaluate(node => node.classList.contains('is-preview')));
    assert.deepEqual(await page.locator(`${APP} [data-keiri-score]`).allTextContents(), Array(13).fill('—'), 'Unfilled Keiri scores have no previews');
    await page.locator(`${APP} [data-die="0"]`).focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator(`${APP} [data-die="0"]`).getAttribute('aria-pressed'), 'true');
    assert(await page.locator(`${APP} [data-die="0"]`).evaluate(node => node.matches(':focus-visible') && (parseFloat(getComputedStyle(node).outlineWidth) > 0 || getComputedStyle(node).boxShadow !== 'none')), 'Keyboard dice focus has a visible treatment');
    const held = await saved(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForEngine(page);
    assert.deepEqual((await saved(page)).match, held.match, 'Reload restores current dice, held state and roll count');
    await roll(page);
    assert.equal((await saved(page)).match.dice[0], initial.match.dice[0], 'Held die survives reroll');
    await roll(page);
    assert.equal((await saved(page)).match.rolls, 3);
    assert(await page.locator(`${APP} [data-roll]`).isDisabled(), 'Fourth roll is unavailable');
    await page.locator(`${APP} [data-roll]`).evaluate(button => button.click());
    assert.equal((await saved(page)).match.rolls, 3, 'Programmatic click cannot bypass roll cap');
    const category = await page.locator(`${APP} [data-score]:enabled`).first().getAttribute('data-score');
    await page.locator(`${APP} [data-score="${category}"]`).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).botFrame?.rolls === 1);
    const pending = await saved(page);
    assert.equal(pending.match.turn, 'keiri');
    assert.equal(await page.locator(`${APP} [data-score].is-preview`).count(), 0, 'Human previews disappear during Keiri turn');
    const beforeSwitchRequests = tableRequests;
    await navigate(page, 'stress-test');
    await page.waitForTimeout(1400); // Longer than a normal bot turn: hidden work must remain cancelled.
    assert.deepEqual((await saved(page)).match, pending.match, 'A deactivated bot cannot commit a stale score');
    await page.goBack();
    await page.locator(APP).waitFor({ state: 'visible' });
    await page.goForward();
    await page.locator(APP).waitFor({ state: 'hidden' });
    await navigate(page, 'yahtzee-keiri');
    await waitForSaved(page, 'human', 1);
    assert.equal(tableRequests, beforeSwitchRequests, 'Returning to a loaded game reuses its exact engine without a new download');
    assert(await page.locator(`${APP} [data-score="${category}"]`).isDisabled(), 'Filled category remains unavailable');
    await roll(page);
    const beforeReload = await saved(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForEngine(page);
    assert.deepEqual((await saved(page)).match, beforeReload.match, 'Committed scorecards and current human turn survive reload');

    // Finish entirely offline after assets load: neither scoring nor exact bot
    // decisions may depend on a remote match service or additional requests.
    await page.context().setOffline(true);
    const botTurnMs = [];
    for (let round = 1; round < 13; round += 1) {
      if ((await saved(page)).match.rolls === 0) await roll(page);
      const started = performance.now();
      await scoreFirst(page);
      await waitForSaved(page, round === 12 ? 'complete' : 'human', round + 1);
      botTurnMs.push(Math.round(performance.now() - started));
    }
    const complete = await saved(page);
    fs.writeFileSync(path.join(OUTPUT, `${browser.browserType().name()}-fixture.json`), `${JSON.stringify({ seed: '0x1a2b3c4d', botTurnMs, result: complete }, null, 2)}\n`);
    assert.equal(complete.match.human.scores.filter(value => value !== null).length, 13);
    assert.equal(complete.match.keiri.scores.filter(value => value !== null).length, 13);
    assert.equal(Object.values(complete.record).reduce((sum, value) => sum + value, 0), 1);
    assert(await page.locator(`${APP} [data-again]`).isVisible());
    assert.match(await page.locator(`${APP} [data-status]`).textContent(), /wins?|tie/i);
    await page.screenshot({ path: path.join(OUTPUT, `${browser.browserType().name()}-result.png`) });
    await page.context().setOffline(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForEngine(page);
    assert.deepEqual(await saved(page), complete, 'Completed game reload must not count the result twice');

    // A fresh tab in a restored browser-local profile also restores the result.
    const restoredContext = await browser.newContext({ storageState: await page.context().storageState() });
    try {
      const reopened = await restoredContext.newPage();
      await openGame(reopened, baseUrl);
      await waitForEngine(reopened);
      assert.deepEqual(await saved(reopened), complete, 'Durable local storage restores a reopened browser profile');
    } finally { await restoredContext.close(); }

    await page.locator(`${APP} [data-again]`).click();
    const again = await saved(page);
    assert.equal(again.match.turn, 'human', 'Every game starts with the human');
    assert.equal(again.match.rolls, 0);
    assert.deepEqual(again.record, complete.record, 'Play again retains the match record');
    await roll(page);
    await page.locator(`${APP} [data-die="0"]`).click();
    await page.locator(`${APP} [data-reset-game]`).click();
    assert.deepEqual(await saved(page), again, 'Reset game immediately clears a human turn and preserves the rivalry');
    await roll(page);
    await scoreFirst(page);
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).botFrame !== null);
    await page.locator(`${APP} [data-reset-game]`).click();
    await page.waitForTimeout(1400);
    assert.deepEqual(await saved(page), again, 'Reset game during a bot turn cancels stale work without counting the abandoned match');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForEngine(page);
    assert.deepEqual(await saved(page), again, 'Reset game persists through reload');
    await page.locator(`${APP} [data-reset]`).click();
    assert.deepEqual((await saved(page)).record, complete.record, 'Reset record requires a deliberate confirmation');
    await page.locator(`${APP} [data-reset-cancel]`).click();
    assert.deepEqual((await saved(page)).record, complete.record, 'Cancelling reset preserves the record');
    await page.locator(`${APP} [data-reset]`).click();
    await page.locator(`${APP} [data-reset]`).click();
    assert.deepEqual((await saved(page)).record, { human: 0, keiri: 0, ties: 0 });
    assert.deepEqual((await saved(page)).match, again.match, 'Reset record keeps the current match');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForEngine(page);
    assert.deepEqual((await saved(page)).record, { human: 0, keiri: 0, ties: 0 }, 'Cleared record persists');
    assert.deepEqual(errors, [], 'Full game and navigation must not throw browser errors');
    console.log(`Yahtzee: normal bot turn milliseconds ${JSON.stringify(botTurnMs)}.`);
    console.log(`Yahtzee: full real-engine match, keyboard, resume, navigation and record passed (${JSON.stringify(complete.record)}).`);
  } finally { await page.close(); }
}

async function assertViewports(browser, baseUrl) {
  const page = await createPage(browser, { reducedMotion: 'no-preference' });
  try {
    await openGame(page, baseUrl);
    await waitForEngine(page);
    const shadowCenters = await page.locator(`${APP} .yahtzee-ground-shadow`).evaluateAll(shadows => shadows.map(shadow => {
      const box = shadow.getBoundingClientRect(); return (box.top + box.bottom) / 2;
    }));
    assert.equal(shadowCenters.length, 5, 'Every die has a persistent ground shadow');
    await page.locator(`${APP} [data-roll]`).click();
    await page.waitForFunction(selector => {
      const shadow = document.querySelector(`${selector} .yahtzee-ground-shadow`);
      return shadow && Number(getComputedStyle(shadow).opacity) < .139;
    }, APP);
    const settling = await page.locator(APP).evaluate((root, key) => ({
      rolls: JSON.parse(localStorage.getItem(key)).match.rolls,
      rolling: root.dataset.rolling,
      scoreDisabled: root.querySelector('[data-score="0"]').disabled,
      cubeFaces: root.querySelectorAll('.yahtzee-cube-side').length,
      cubes: [...root.querySelectorAll('.is-tumbling')].map(cube => getComputedStyle(cube).transformStyle),
      animations: root.querySelector('.yahtzee-dice').getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && !('transitionProperty' in animation) && !('animationName' in animation)).map(animation => ({
        target: animation.effect.target.className,
        finalOpacity: animation.effect.getKeyframes().at(-1).opacity,
        value: animation.effect.target.closest('.yahtzee-cube-side')?.dataset.value,
        landedValue: animation.effect.target.closest('[data-die]')?.dataset.face
      })),
      sideMaterials: [...root.querySelectorAll('.yahtzee-cube-side')].map(side => getComputedStyle(side).backgroundColor),
      shadows: [...root.querySelectorAll('.yahtzee-ground-shadow')].map(shadow => {
        const box = shadow.getBoundingClientRect(); const style = getComputedStyle(shadow);
        const transform = new DOMMatrixReadOnly(style.transform);
        return { centerY: (box.top + box.bottom) / 2, opacity: Number(style.opacity), scale: transform.m11,
          offDiagonal: [transform.m12, transform.m21, transform.m13, transform.m23, transform.m31, transform.m32],
          translateY: transform.m42, dieSize: shadow.parentElement.getBoundingClientRect().width, sibling: shadow.parentElement === shadow.parentElement.querySelector('.yahtzee-face')?.parentElement };
      })
    }), STORAGE_KEY);
    assert.equal(settling.rolls, 1, 'Roll outcomes persist before visual settling');
    assert.equal(settling.rolling, 'true', 'Pointer rolls visibly settle before scoring');
    assert(settling.scoreDisabled, 'Scores are gated while dice settle');
    assert.equal(settling.animations.filter(animation => /(?:^| )yahtzee-face(?: |$)/.test(animation.target)).length, 5, 'All five dice have independent movement animations');
    assert.equal(settling.animations.filter(animation => animation.target.includes('yahtzee-face-shade')).length, 30, 'Six face lighting tracks follow each die');
    assert.equal(settling.animations.filter(animation => animation.target.includes('yahtzee-ground-shadow')).length, 5, 'Each ground shadow has its own anchored animation');
    settling.animations.filter(animation => animation.target.includes('yahtzee-face-shade') && animation.value === animation.landedValue).forEach(animation => assert.equal(Number(animation.finalOpacity), 0, 'The landing face ends with zero shade before returning to the resting die'));
    assert(settling.sideMaterials.every(color => color === 'rgb(255, 255, 255)'), 'All numbered faces use the same white material');
    settling.shadows.forEach((shadow, index) => {
      assert(shadow.sibling, 'Ground shadows live outside the rotating die surface');
      assert(shadow.centerY >= shadowCenters[index] - .01 && shadow.centerY <= shadowCenters[index] + shadow.dieSize * .045 + .1, 'Shadow stays on the ground with only its small cast-light offset');
      assert(shadow.opacity < .14 && shadow.scale > 1, 'The elevated die has a broader, fainter shadow');
      assert(shadow.offDiagonal.every(value => Math.abs(value) < .00001) && shadow.translateY >= 0 && shadow.translateY <= shadow.dieSize * .045 + .00001, 'Ground shadows never rotate or rise with the dice');
    });
    assert.equal(settling.cubeFaces, 30, 'Rolling dice expose six real faces each');
    assert.deepEqual(settling.cubes, Array(5).fill('preserve-3d'), 'The faces form three-dimensional dice');
    await page.waitForFunction(selector => document.querySelector(selector)?.dataset.rolling !== 'true', APP);
    const landedMaterials = await page.locator(`${APP} .yahtzee-face`).evaluateAll(faces => faces.map(face => getComputedStyle(face).backgroundColor));
    assert.deepEqual(landedMaterials, Array(5).fill('rgb(255, 255, 255)'), 'The settled material matches the white front face at the animation endpoint');
    const landedShadows = await page.locator(`${APP} .yahtzee-ground-shadow`).evaluateAll(shadows => shadows.map(shadow => Number(getComputedStyle(shadow).opacity)));
    landedShadows.forEach(opacity => assert(Math.abs(opacity - .14) < .00001, 'Shadow opacity matches its animation endpoint at rest'));
    await page.locator(`${APP} [data-die="0"]`).click();
    await page.locator(`${APP} [data-roll]`).click();
    const heldMoves = await page.locator(`${APP} [data-die="0"]`).evaluate(die => die.getAnimations({ subtree: true }).filter(animation => !('transitionProperty' in animation) && !('animationName' in animation)).length);
    assert.equal(heldMoves, 0, 'A held die stays still while other dice reroll');
    await page.waitForFunction(selector => document.querySelector(selector)?.dataset.rolling !== 'true', APP);
    assert.equal(await page.locator(`${APP} .yahtzee-cube-side`).count(), 0, 'Temporary faces are removed after landing');
    assert.equal(await page.locator(`${APP} .yahtzee-pip`).count(), 45, 'Five dice use nine geometric pips each');
    const faces = await page.locator(`${APP} [data-die]`).evaluateAll(dice => dice.map(die => ({ face: Number(die.dataset.face), visible: [...die.querySelectorAll('.yahtzee-pip')].filter(pip => getComputedStyle(pip).visibility === 'visible').length })));
    faces.forEach(die => assert.equal(die.visible, die.face, 'Visible pips exactly match the generated die outcome'));
    assert.deepEqual(await page.locator(`${APP} .yahtzee-held`).allTextContents(), ['HELD', '', '', '', ''], 'Only held dice have a label');
    const previews = await page.locator(`${APP} [data-score].is-preview`).evaluateAll(buttons => buttons.map(button => ({ points: Number(button.textContent), alpha: Number(button.style.getPropertyValue('--score-strength')) })));
    for (const left of previews) for (const right of previews) {
      if (left.points < right.points) assert(left.alpha < right.alpha, 'Higher absolute scores have stronger preview shading');
      if (left.points === right.points) assert.equal(left.alpha, right.alpha, 'Equal scores share the same preview shading');
    }
    for (const [width, height] of [[1440, 900], [1280, 720], [1024, 600], [800, 600]]) {
      await page.setViewportSize({ width, height });
      await assertFits(page, `${width}x${height} human turn`);
      const layout = await page.locator(APP).evaluate(root => {
        const dice = root.querySelector('.yahtzee-dice').getBoundingClientRect();
        const card = root.querySelector('.yahtzee-scorecard').getBoundingClientRect();
        return { diceBottom: dice.bottom, cardTop: card.top, diceCenter: (dice.left + dice.right) / 2, cardCenter: (card.left + card.right) / 2 };
      });
      assert(layout.diceBottom <= layout.cardTop + 1, `${width}x${height}: dice sit above the shared scorecard`);
      assert(Math.abs(layout.diceCenter - layout.cardCenter) < 2, `${width}x${height}: dice and scorecard share a center`);
      await page.screenshot({ path: path.join(OUTPUT, `${browser.browserType().name()}-${width}x${height}.png`) });
    }
    await scoreFirst(page);
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).botFrame !== null);
    await assertFits(page, '800x600 bot turn');
    await waitForSaved(page, 'human', 1);
  } finally { await page.close(); }
  console.log('Yahtzee: all visible child bounds and screenshots passed at four required viewports.');
}

async function assertWarmCache() {
  // Resource Timing in Chromium workers distinguishes an actual cached table
  // response from merely retaining an already initialized engine in memory.
  if (process.env.UTILITIES_CHECK_URL) return;
  const server = await startLocalStaticServer({ url: 'http://127.0.0.1:4189', cwd: ROOT, cacheControl: 'public, max-age=3600' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yahtzee-cache-check-'));
  // Incognito contexts have only a small in-memory HTTP cache. Use an isolated
  // disk-backed profile large enough to hold the production table.
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true, timeout: 30000, args: ['--disk-cache-size=268435456'], viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    let page = await context.newPage();
    await openGame(page, server.url);
    await waitForEngine(page);
    const warmed = await page.context().newPage();
    await page.close();
    page = warmed;
    await openGame(page, server.url);
    await waitForEngine(page);
    const timings = (await Promise.all(page.workers().map(worker => worker.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.toJSON()))))).flat();
    const table = timings.find(entry => /bbg-anchor.*\.bin/.test(entry.name));
    assert(table, 'Cached worker exposes the exact-table Resource Timing entry');
    assert.equal(table.transferSize, 0, 'Warm new-tab navigation must use the cached table without another transfer');
    assert(table.decodedBodySize > 12000000, 'The cached response still contains the complete production table');
    assert(await page.locator(`${APP} [data-progress]`).isHidden(), 'Warm readiness removes the loading indicator');
    await roll(page);
    await scoreFirst(page);
    await waitForSaved(page, 'human', 1);
  } finally {
    await context?.close();
    server.kill();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log('Yahtzee: actual warm-cache navigation reuses the complete table with zero transfer.');
}

async function assertInvalidStorage(browser, baseUrl) {
  for (const raw of ['{invalid JSON', JSON.stringify({ version: 0, record: { human: 999 }, match: {} })]) {
    const page = await createPage(browser);
    let releaseRules;
    const rulesGate = new Promise(resolve => { releaseRules = resolve; });
    await page.route(RULES_WASM_URL, async route => {
      await rulesGate;
      await route.continue();
    });
    try {
      await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), { key: STORAGE_KEY, raw });
      const rulesRequested = page.waitForRequest(RULES_WASM_URL);
      await openGame(page, baseUrl);
      await rulesRequested;
      // Do not use roll(), which waits for score previews and therefore rules.
      await page.locator(`${APP} [data-roll]`).click();
      await page.locator(`${APP} [data-die="1"]`).click();
      await page.locator(`${APP} [data-roll]`).click();
      const before = await saved(page);
      assert.equal(before.version, 1);
      assert.deepEqual(before.record, { human: 0, keiri: 0, ties: 0 });
      assert.equal(before.match.turn, 'human');
      assert.equal(before.match.rolls, 2);
      assert.equal(before.match.held[1], true);
      assert.equal(await page.locator(`${APP} [data-score]:enabled`).count(), 0, 'Rules are still blocked during fresh-game play');

      releaseRules();
      await waitForEngine(page);
      await page.locator(`${APP} [data-score]:enabled`).first().waitFor();
      assert.deepEqual(await saved(page), before, 'Late rules validation must preserve rolls/holds after invalid-storage recovery');
    } finally {
      releaseRules();
      await page.close();
    }
  }
  console.log('Yahtzee: malformed/obsolete storage recovery preserves early rolls and holds through delayed rules loading.');
}

async function runYahtzeeChecks(browser, baseUrl) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  await assertLoadingAndRetry(browser, baseUrl);
  await assertByteProgress(browser, baseUrl);
  await assertMatchAndPersistence(browser, baseUrl);
  await assertViewports(browser, baseUrl);
  await assertInvalidStorage(browser, baseUrl);
  if (browser.browserType().name() === 'chromium') await assertWarmCache();
  console.log(`Yahtzee browser check passed: ${browser.browserType().name()}.`);
}

async function main() {
  const requestedUrl = process.env.UTILITIES_CHECK_URL || 'http://127.0.0.1:4188';
  const server = await startLocalStaticServer({ url: requestedUrl, cwd: ROOT, skip: Boolean(process.env.UTILITIES_CHECK_URL) });
  const baseUrl = server?.url || requestedUrl;
  const browserName = process.env.UTILITIES_BROWSER || 'chromium';
  const browserType = { chromium, firefox, webkit }[browserName];
  assert(browserType, `Unsupported browser: ${browserName}`);
  let browser;
  try {
    await waitForServer(`${baseUrl}/pages/utilities/index.html`);
    browser = await browserType.launch({ headless: true, timeout: 30000 });
    await runYahtzeeChecks(browser, baseUrl);
  } finally {
    await browser?.close();
    server?.kill();
  }
}

module.exports = { runYahtzeeChecks };
if (require.main === module) main().catch(error => {
  console.error('Yahtzee browser check failed:', error.stack || error.message);
  process.exitCode = 1;
});
