/** Utilities workbench: immediate hash navigation and controller lifecycle. */
(function () {
  'use strict';

  const controllerKey = '__utilitiesShellController__';
  const entryExecutedKey = '__utilitiesEntryExecuted__';
  window[controllerKey]?.destroy();

  const titleView = document.getElementById('utilitiesTitleView');
  const utilityView = document.getElementById('utilitiesUtilityView');
  if (!titleView || !utilityView) return;

  const allowedIds = new Set(['image-transform', 'audio-fourier', 'stress-test']);
  const stages = Array.from(document.querySelectorAll('.utility-stage[data-utility-id]'));
  const entries = Array.from(document.querySelectorAll('.utilities-buttons [data-utility]'));
  const tools = new Map(stages
    .filter(stage => allowedIds.has(stage.dataset.utilityId))
    .map(stage => [stage.dataset.utilityId, stage]));
  const heading = document.getElementById('utilityTitle');
  const number = document.getElementById('utilityNumber');
  const switcher = document.getElementById('utilitySwitcher');
  const indexTitle = document.title;
  const cleanupTasks = [];
  const stageTimers = new Map();
  const retryButtons = new WeakSet();
  const missingRootWarned = new WeakSet();
  let currentId = null;
  let initialized = false;
  let returnEntry = null;
  let indexScroll = null;

  // A stalled-but-alive import never fires onerror, so each activation runs
  // against a deadline. 0 disables the watchdog.
  function initDeadlineMs() {
    const override = window.__OD_UTILITIES_INIT_TIMEOUT_MS;
    return typeof override === 'number' && Number.isFinite(override) && override >= 0
      ? override
      : 20000;
  }

  function stageLabel(stage) {
    return stage.dataset.utilityTitle ||
      entries.find(entry => entry.dataset.utility === stage.dataset.utilityId)?.textContent.trim() ||
      stage.dataset.utilityId;
  }

  function statusUi(stage) {
    let host = stage.querySelector(':scope > .utility-stage-status');
    if (!host) {
      host = document.createElement('div');
      host.className = 'utility-stage-status';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      const text = document.createElement('span');
      text.className = 'utility-stage-status-text';
      const button = document.createElement('button');
      button.type = 'button';
      button.hidden = true;
      host.append(text, button);
      stage.append(host);
    }
    const button = host.querySelector('button');
    if (button && !retryButtons.has(button)) {
      listen(button, 'click', () => {
        if (button.dataset.utilityRetryMode === 'reload') {
          window.location.reload();
          return;
        }
        // Same-URL dynamic imports stay rejected/pending in the browser module
        // map, so an in-page retry re-activates and lets main.ts re-attempt.
        beginStage(stage);
        notify(stage, 'utility-activate');
      });
      retryButtons.add(button);
    }
    return {
      host,
      text: host.querySelector('.utility-stage-status-text'),
      button: host.querySelector('button'),
    };
  }

  function clearStageTimer(stage) {
    const timer = stageTimers.get(stage);
    if (timer) {
      window.clearTimeout(timer);
      stageTimers.delete(stage);
    }
  }

  function applyGating(stage, loading) {
    const root = stage.querySelector('[data-utility-root]');
    if (!root) {
      if (loading && !missingRootWarned.has(stage)) {
        missingRootWarned.add(stage);
        console.warn(`Utility stage ${stage.dataset.utilityId} has no [data-utility-root]; readiness gating unavailable.`);
      }
      return;
    }
    if (loading) {
      root.setAttribute('inert', '');
    } else {
      root.removeAttribute('inert');
    }
  }

  function beginStage(stage) {
    clearStageTimer(stage);
    stage.dataset.utilityReady = 'loading';
    stage.setAttribute('aria-busy', 'true');
    applyGating(stage, true);
    const ui = statusUi(stage);
    ui.host.setAttribute('role', 'status');
    ui.host.hidden = false;
    ui.text.textContent = `Loading ${stageLabel(stage)}…`;
    ui.button.hidden = true;
    const deadline = initDeadlineMs();
    if (deadline > 0) {
      stageTimers.set(stage, window.setTimeout(() => {
        stageTimers.delete(stage);
        if (stage.dataset.utilityReady !== 'loading') return;
        if (window[entryExecutedKey] === true) {
          // main.ts owns the controller deadline and must release its attempt
          // before Retry is offered. Give its event a brief grace period; if
          // that listener never runs, a reload remains the safe fallback.
          stageTimers.set(stage, window.setTimeout(() => {
            stageTimers.delete(stage);
            if (stage.dataset.utilityReady === 'loading') {
              applyError(stage, { message: `${stageLabel(stage)} took too long to load.`, retryable: false });
            }
          }, 1000));
          return;
        }
        // Before the entry module executes, a retry cannot reach any listener:
        // only a fresh document re-fetches the entry.
        applyError(stage, {
          message: `${stageLabel(stage)} took too long to load.`,
          retryable: false,
        });
      }, deadline));
    }
  }

  function applyError(stage, detail) {
    clearStageTimer(stage);
    stage.dataset.utilityReady = 'error';
    stage.setAttribute('aria-busy', 'false');
    applyGating(stage, true);
    const ui = statusUi(stage);
    ui.host.setAttribute('role', 'alert');
    ui.host.hidden = false;
    ui.text.textContent = detail.message || 'The tool could not be loaded.';
    ui.button.hidden = false;
    ui.button.dataset.utilityRetryMode = detail.retryable ? 'retry' : 'reload';
    ui.button.textContent = detail.retryable ? 'Retry' : 'Reload tools';
  }

  function applyReady(stage) {
    clearStageTimer(stage);
    stage.dataset.utilityReady = 'ready';
    stage.setAttribute('aria-busy', 'false');
    applyGating(stage, false);
    const ui = statusUi(stage);
    ui.host.hidden = true;
  }

  function listen(target, type, handler, options) {
    if (!target) return;
    target.addEventListener(type, handler, options);
    cleanupTasks.push(() => target.removeEventListener(type, handler, options));
  }

  function routeFromHash() {
    try {
      const id = decodeURIComponent(window.location.hash.slice(1));
      return tools.has(id) ? id : null;
    } catch {
      return null;
    }
  }

  function focus(element) {
    if (!element) return;
    if (!element.matches('a, button, input, select, textarea, [tabindex]')) {
      element.tabIndex = -1;
    }
    element.focus({ preventScroll: true });
  }

  function notify(stage, type) {
    // Controllers listen on their root; bubbling also reaches the lazy loader.
    const root = stage.querySelector('[data-utility-root]') || stage;
    root.dispatchEvent(new CustomEvent(type, { bubbles: true }));
  }

  function render() {
    const nextId = routeFromHash();
    if (initialized && nextId === currentId) return;
    const previousId = currentId;
    const wasInitialized = initialized;

    if (!previousId && nextId) {
      if (wasInitialized) indexScroll = { left: window.scrollX, top: window.scrollY };
      returnEntry = returnEntry || entries.find(entry => entry.dataset.utility === nextId);
    }
    if (previousId) {
      notify(tools.get(previousId), 'utility-deactivate');
      // Deactivation drops the presentation deadline; re-entry re-arms it.
      clearStageTimer(tools.get(previousId));
    }

    stages.forEach(stage => {
      const active = stage.dataset.utilityId === nextId;
      stage.hidden = !active;
      stage.classList.toggle('is-active', active);
    });
    titleView.hidden = Boolean(nextId);
    utilityView.hidden = !nextId;
    titleView.classList.toggle('utilities-view--active', !nextId);
    utilityView.classList.toggle('utilities-view--active', Boolean(nextId));
    currentId = nextId;
    initialized = true;

    if (nextId) {
      const stage = tools.get(nextId);
      const label = stage.dataset.utilityTitle ||
        entries.find(entry => entry.dataset.utility === nextId)?.textContent.trim() || nextId;
      if (heading) heading.textContent = label;
      if (number) number.textContent = stage.dataset.utilityNumber || '';
      if (switcher) switcher.value = nextId;
      document.title = label;
      document.documentElement.dataset.activeUtility = nextId;
      // Re-entering a settled stage must not reset it to loading: main.ts
      // resolves already-initialized utilities silently.
      if (stage.dataset.utilityReady !== 'ready') beginStage(stage);
      notify(stage, 'utility-activate');
      focus(heading);
      // Every workspace starts at its controls, including browser-history navigation.
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    } else {
      document.title = indexTitle;
      delete document.documentElement.dataset.activeUtility;
      if (previousId) {
        focus(returnEntry || entries[0]);
        if (indexScroll) window.scrollTo({ ...indexScroll, behavior: 'instant' });
        returnEntry = null;
      }
    }
  }

  function navigate(id) {
    if (id && !tools.has(id)) return;
    const url = new URL(window.location.href);
    url.hash = id || '';
    if (url.href !== window.location.href) {
      window.history.pushState(null, '', url);
    }
    render();
  }

  entries.forEach(entry => {
    listen(entry, 'click', event => {
      // Preserve native link behavior for opening a tool in another tab.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
      event.preventDefault();
      if (!tools.has(entry.dataset.utility)) return;
      returnEntry = entry;
      navigate(entry.dataset.utility);
    });
  });
  listen(document.querySelector('.nav-back-btn'), 'click', event => {
    event.preventDefault();
    navigate(null);
  });
  listen(switcher, 'change', () => navigate(switcher.value));
  listen(window, 'hashchange', render);
  listen(window, 'popstate', render);

  // Readiness signals from main.ts (dispatched on each [data-utility-root]).
  // Capture on the wrapper also sees non-bubbling events on nested roots.
  listen(utilityView, 'utility-ready', event => {
    const stage = event.target instanceof Element ? event.target.closest('[data-utility-id]') : null;
    if (!stage || !tools.has(stage.dataset.utilityId)) return;
    // Late resolutions only arrive from live attempts: main.ts token-guards
    // timed-out initializations, so accepting ready here cannot resurrect a
    // stale controller.
    applyReady(stage);
  }, true);
  listen(utilityView, 'utility-failed', event => {
    const stage = event.target instanceof Element ? event.target.closest('[data-utility-id]') : null;
    if (!stage || !tools.has(stage.dataset.utilityId)) return;
    const detail = event.detail || {};
    applyError(stage, {
      message: detail.reason === 'deadline' ? `${stageLabel(stage)} took too long to load.` : detail.message,
      retryable: detail.retryable === true || detail.retryMode === 'retry',
    });
  }, true);

  // Load-failure signal (vite:preloadError path or controller worker/GPU
  // failure). main.ts shows the global banner; the shell marks still-pending
  // stages errored. Ready stages own their runtime errors via their own UI.
  listen(window, 'utility-load-error', () => {
    stages.forEach(stage => {
      if (!tools.has(stage.dataset.utilityId) || stage.dataset.utilityReady !== 'loading') return;
      applyError(stage, { message: 'The tools could not load. Reload for the latest version.', retryable: false });
    });
  });

  function destroy() {
    stageTimers.forEach(timer => window.clearTimeout(timer));
    stageTimers.clear();
    cleanupTasks.splice(0).forEach(cleanup => cleanup());
    if (window[controllerKey]?.destroy === destroy) delete window[controllerKey];
  }

  window[controllerKey] = { destroy };
  render();
})();
