/** Utilities workbench: immediate hash navigation and controller lifecycle. */
(function () {
  'use strict';

  const controllerKey = '__utilitiesShellController__';
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
  let currentId = null;
  let initialized = false;
  let returnEntry = null;
  let indexScroll = null;

  function listen(target, type, handler) {
    if (!target) return;
    target.addEventListener(type, handler);
    cleanupTasks.push(() => target.removeEventListener(type, handler));
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

  function destroy() {
    cleanupTasks.splice(0).forEach(cleanup => cleanup());
    if (window[controllerKey]?.destroy === destroy) delete window[controllerKey];
  }

  window[controllerKey] = { destroy };
  render();
})();
