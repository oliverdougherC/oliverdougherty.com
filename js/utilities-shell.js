/**
 * Utilities Shell — SPA hash routing and view transitions
 * Handles title card ↔ utility switching with dreamy cross-fades.
 */

(function () {
  'use strict';

  const TITLE_VIEW_ID = 'utilitiesTitleView';
  const UTILITY_VIEW_ID = 'utilitiesUtilityView';

  const UTILITY_MAP = {
    'image-transform': 'image-transform',
    'audio-fourier': 'audio-fourier',
    'local-assistant': 'local-assistant',
    'death-calculator': 'death-calculator',
    'virtual-machine': 'virtual-machine',
    'stress-test': 'stress-test',
  };

  const titleView = document.getElementById(TITLE_VIEW_ID);
  const utilityView = document.getElementById(UTILITY_VIEW_ID);
  const backBtn = document.querySelector('.nav-back-btn');
  const titleButtons = document.querySelectorAll('.utilities-buttons button[data-utility]');
  const stages = document.querySelectorAll('.utility-stage');

  const FLAIR_COLORS = ['#FF6700', '#2BA84A', '#004BA8'];

  function pickFlairColor() {
    return FLAIR_COLORS[Math.floor(Math.random() * FLAIR_COLORS.length)];
  }
  let currentUtilityId = null;
  let isTransitioning = false;
  let hasExitedTitleCard = false;
  let localAssistantScriptPromise = null;

  function getHashTarget() {
    const hash = window.location.hash.replace(/^#/, '').trim();
    if (!hash) return null;
    return UTILITY_MAP[hash] || null;
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
      if (existing) {
        resolve();
        return;
      }

      var script = document.createElement('script');
      script.type = 'module';
      script.src = '../../js/local-llm-chat.js?v=utilities-2026-05-16-local-assistant-copy';
      script.dataset.localLlmChat = 'true';
      script.onload = function() { resolve(); };
      script.onerror = function() {
        localAssistantScriptPromise = null;
        script.remove();
        reject(new Error('Unable to load Local Assistant.'));
      };
      document.body.appendChild(script);
    });
    return localAssistantScriptPromise;
  }

  function activateStage(stage, utilityId) {
    stage.classList.add('is-active');
    stage.style.setProperty('--utility-flair', pickFlairColor());
    setActiveUtility(utilityId);
    stage.dispatchEvent(new CustomEvent('utility-activate', { bubbles: true }));
    if (utilityId === 'local-assistant') {
      loadLocalAssistantScript().catch(function(error) {
        var root = document.getElementById('localLlmUtilityApp');
        if (root) {
          root.textContent = error.message || 'Unable to load Local Assistant.';
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

    setTimeout(function () {
      isTransitioning = false;
    }, 600);
  }

  function showUtility(utilityId, opts) {
    opts = opts || {};
    if (isTransitioning) return;
    isTransitioning = true;

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
      activateStage(incoming, utilityId);

      titleView.classList.remove('utilities-view--active');
      utilityView.classList.add('utilities-view--active');

      currentUtilityId = utilityId;

      setTimeout(function () {
        isTransitioning = false;
      }, 600);
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

      setTimeout(function () {
        outgoing.classList.remove('is-exiting');
        isTransitioning = false;
      }, 500);
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

  // Event listeners
  window.addEventListener('hashchange', navigateToTarget);

  backBtn && backBtn.addEventListener('click', function () {
    setHash(null);
  });

  titleButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var uid = btn.dataset.utility;
      if (uid) setHash(uid);
    });
  });

  // Initialize on load
  navigateToTarget();
})();
