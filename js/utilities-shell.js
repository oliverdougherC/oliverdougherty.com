/**
 * Utilities Shell — SPA hash routing and view transitions
 * Handles title card ↔ utility switching with dreamy cross-fades.
 */

(function () {
  'use strict';

  var GLOBAL_CONTROLLER_KEY = '__utilitiesShellController__';
  var previousController = window[GLOBAL_CONTROLLER_KEY];
  if (previousController && typeof previousController.destroy === 'function') {
    previousController.destroy();
  }

  const TITLE_VIEW_ID = 'utilitiesTitleView';
  const UTILITY_VIEW_ID = 'utilitiesUtilityView';

  const VALID_UTILITIES = new Set([
    'image-transform',
    'audio-fourier',
    'local-assistant',
    'virtual-machine',
    'stress-test',
  ]);

  const titleView = document.getElementById(TITLE_VIEW_ID);
  const utilityView = document.getElementById(UTILITY_VIEW_ID);
  const backBtn = document.querySelector('.nav-back-btn');
  const titleButtons = document.querySelectorAll('.utilities-buttons button[data-utility]');
  const stages = document.querySelectorAll('.utility-stage');
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cleanupTasks = [];
  const pendingTimers = new Set();

  const FLAIR_COLORS = ['#FF6700', '#2BA84A', '#004BA8'];
  const flairByUtilityId = new Map();

  function resolveFlairColor(utilityId) {
    if (!flairByUtilityId.has(utilityId)) {
      var hash = 0;
      for (var index = 0; index < utilityId.length; index += 1) {
        hash = ((hash * 31) + utilityId.charCodeAt(index)) >>> 0;
      }
      flairByUtilityId.set(utilityId, FLAIR_COLORS[hash % FLAIR_COLORS.length]);
    }
    return flairByUtilityId.get(utilityId);
  }
  let currentUtilityId = null;
  let isTransitioning = false;
  let hasExitedTitleCard = false;
  let localAssistantScriptPromise = null;
  let localAssistantLoadAttempt = 0;

  function listen(target, type, handler, options) {
    if (!target) return;
    target.addEventListener(type, handler, options);
    cleanupTasks.push(function () {
      target.removeEventListener(type, handler, options);
    });
  }

  function schedule(fn, delayMs) {
    if (delayMs <= 0) {
      fn();
      return 0;
    }

    var timerId = window.setTimeout(function () {
      pendingTimers.delete(timerId);
      fn();
    }, delayMs);
    pendingTimers.add(timerId);
    return timerId;
  }

  function clearPendingTimers() {
    pendingTimers.forEach(function (timerId) {
      window.clearTimeout(timerId);
    });
    pendingTimers.clear();
  }

  function getTransitionDelay(delayMs) {
    return reducedMotion ? 0 : delayMs;
  }

  function getHashTarget() {
    const hash = window.location.hash.replace(/^#/, '').trim();
    if (!hash) return null;
    return VALID_UTILITIES.has(hash) ? hash : null;
  }

  function getStage(utilityId) {
    return document.querySelector('.utility-stage[data-utility-id="' + utilityId + '"]');
  }

  function setActiveUtility(utilityId) {
    if (utilityId) {
      document.documentElement.dataset.activeUtility = utilityId;
    } else {
      delete document.documentElement.dataset.activeUtility;
    }
  }

  function loadLocalAssistantScript() {
    if (localAssistantScriptPromise) return localAssistantScriptPromise;
    localAssistantScriptPromise = new Promise(function(resolve, reject) {
      var existing = document.querySelector('script[data-local-llm-chat]');
      if (existing && existing.dataset.localLlmState !== 'failed') {
        resolve();
        return;
      }
      if (existing) {
        existing.remove();
      }

      var script = document.createElement('script');
      var attempt = String(localAssistantLoadAttempt + 1);
      localAssistantLoadAttempt += 1;
      script.type = 'module';
      script.src = '../../js/local-llm-chat.js?v=utilities-2026-05-21-todos';
      script.dataset.localLlmChat = 'true';
      script.dataset.localLlmAttempt = attempt;
      script.onload = function() {
        script.dataset.localLlmState = 'loaded';
        resolve();
      };
      script.onerror = function() {
        localAssistantScriptPromise = null;
        script.dataset.localLlmState = 'failed';
        window.dispatchEvent(new CustomEvent('local-llm-script-load-failed', {
          detail: { attempt: Number(attempt) }
        }));
        script.remove();
        reject(new Error('Unable to load Local Assistant.'));
      };
      document.body.appendChild(script);
    });
    localAssistantScriptPromise.catch(function (error) {
      console.error('[Local Assistant] Script load failed (attempt #' + localAssistantLoadAttempt + '):', error.message);
      // Persist a non-intrusive warning in sessionStorage so it surfaces on next page load
      // if the user navigates away and back without retrying.
      try {
        sessionStorage.setItem('local-assistant-load-warning',
          JSON.stringify({ message: error.message, attempt: localAssistantLoadAttempt, ts: Date.now() }));
      } catch (_) { /* sessionStorage may be unavailable (private browsing) */ }
    });
    return localAssistantScriptPromise;
  }

  function renderLocalAssistantLoadError(root, error) {
    root.textContent = '';
    var panel = document.createElement('div');
    panel.className = 'local-llm-load-error';

    var message = document.createElement('p');
    message.textContent = (error && error.message) || 'Unable to load Local Assistant.';

    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn-secondary-utility';
    retry.textContent = 'Retry';
    retry.addEventListener('click', function() {
      root.textContent = 'Loading Local Assistant...';
      loadLocalAssistantScript()
        .then(function() {
          root.textContent = '';
          root.dispatchEvent(new CustomEvent('utility-activate', { bubbles: true }));
        })
        .catch(function(nextError) {
          console.error(nextError);
          renderLocalAssistantLoadError(root, nextError);
        });
    });

    panel.append(message, retry);
    root.appendChild(panel);
  }

  function activateStage(stage, utilityId) {
    stage.classList.add('is-active');
    stage.style.setProperty('--utility-flair', resolveFlairColor(utilityId));
    setActiveUtility(utilityId);
    stage.dispatchEvent(new CustomEvent('utility-activate', { bubbles: true }));
    if (utilityId === 'local-assistant') {
      loadLocalAssistantScript().catch(function(error) {
        console.error(error);
        var root = document.getElementById('localLlmUtilityApp');
        if (root) {
          renderLocalAssistantLoadError(root, error);
        }
      });
    }
  }

  function deactivateStage(stage) {
    stage.style.removeProperty('--utility-flair');
    stage.dispatchEvent(new CustomEvent('utility-deactivate', { bubbles: true }));
  }

  function showTitleCard() {
    if (isTransitioning) return;
    isTransitioning = true;
    clearPendingTimers();

    // Hide all stages
    stages.forEach(function (stage) {
      if (stage.classList.contains('is-active')) {
        deactivateStage(stage);
      }
      stage.classList.remove('is-active', 'is-exiting');
    });

    // Swap views
    utilityView.classList.remove('utilities-view--active');
    titleView.classList.add('utilities-view--active');

    // If returning from a utility, skip entrance animations for instant visibility
    if (hasExitedTitleCard) {
      document.documentElement.classList.add('utilities-returned');
      titleButtons.forEach(function (btn) {
        if (!btn.classList.contains('is-visible')) {
          btn.style.transition = 'none';
          btn.classList.add('is-visible');
          requestAnimationFrame(function () {
            btn.style.transition = '';
          });
        }
      });
    }

    currentUtilityId = null;
    setActiveUtility(null);

    schedule(function () {
      isTransitioning = false;
      focusTitleCard();
    }, getTransitionDelay(600));
  }

  function showUtility(utilityId, opts) {
    opts = opts || {};
    if (isTransitioning) return;
    isTransitioning = true;
    clearPendingTimers();

    if (!currentUtilityId) {
      hasExitedTitleCard = true;
    }

    var incoming = getStage(utilityId);
    if (!incoming) {
      isTransitioning = false;
      return;
    }

    var outgoing = currentUtilityId ? getStage(currentUtilityId) : null;

    if (opts.fromTitle || !outgoing) {
      // Title → Utility: depth fade
      stages.forEach(function (s) {
        if (s.classList.contains('is-active')) {
          deactivateStage(s);
        }
        s.classList.remove('is-active', 'is-exiting');
      });

      titleView.classList.remove('utilities-view--active');
      utilityView.classList.add('utilities-view--active');
      activateStage(incoming, utilityId);

      currentUtilityId = utilityId;

      schedule(function () {
        isTransitioning = false;
      }, getTransitionDelay(600));
    } else if (outgoing === incoming) {
      // Same utility, nothing to do
      isTransitioning = false;
    } else {
      // Utility → Utility: cross-fade stages
      outgoing.classList.add('is-exiting');
      outgoing.classList.remove('is-active');
      deactivateStage(outgoing);

      activateStage(incoming, utilityId);

      currentUtilityId = utilityId;

      schedule(function () {
        outgoing.classList.remove('is-exiting');
        isTransitioning = false;
      }, getTransitionDelay(500));
    }
  }

  function navigateToTarget() {
    var target = getHashTarget();
    if (target) {
      showUtility(target, { fromTitle: !currentUtilityId });
    } else {
      showTitleCard();
    }
  }

  function setHash(utilityId) {
    if (utilityId) {
      window.location.hash = '#' + utilityId;
    } else {
      window.location.hash = '';
    }
  }

  function focusTitleCard() {
    var title = titleView ? titleView.querySelector('.utilities-title') : null;
    var firstButton = titleButtons[0];
    var target = title || firstButton;
    if (!target || !hasExitedTitleCard) {
      return;
    }

    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }
    target.focus({ preventScroll: true });
  }

  function destroy() {
    clearPendingTimers();
    cleanupTasks.splice(0).forEach(function (cleanup) {
      cleanup();
    });
    if (window[GLOBAL_CONTROLLER_KEY] && window[GLOBAL_CONTROLLER_KEY].destroy === destroy) {
      delete window[GLOBAL_CONTROLLER_KEY];
    }
  }

  window[GLOBAL_CONTROLLER_KEY] = { destroy: destroy };

  // Event listeners
  listen(window, 'hashchange', navigateToTarget);

  if (backBtn) {
    listen(backBtn, 'click', function () {
      if (isTransitioning) return;
      setHash(null);
    });
  }

  titleButtons.forEach(function (btn) {
    listen(btn, 'click', function () {
      if (isTransitioning) return;
      var uid = btn.dataset.utility;
      if (uid) setHash(uid);
    });
  });
  listen(window, 'pagehide', destroy, { once: true });

  // Initialize on load
  navigateToTarget();
})();
