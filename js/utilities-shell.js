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
  };

  const titleView = document.getElementById(TITLE_VIEW_ID);
  const utilityView = document.getElementById(UTILITY_VIEW_ID);
  const backBtn = document.querySelector('.utility-back-btn');
  const switcherTrigger = document.querySelector('.utility-switcher-trigger');
  const switcherDropdown = document.querySelector('.utility-switcher-dropdown');
  const titleButtons = document.querySelectorAll('.utilities-buttons button[data-utility]');
  const dropdownButtons = document.querySelectorAll('.utility-switcher-dropdown button[data-utility]');
  const stages = document.querySelectorAll('.utility-stage');

  let currentUtilityId = null;
  let isTransitioning = false;

  function getHashTarget() {
    const hash = window.location.hash.replace(/^#/, '').trim();
    if (!hash) return null;
    return UTILITY_MAP[hash] || null;
  }

  function getStage(utilityId) {
    return document.querySelector('.utility-stage[data-utility-id="' + utilityId + '"]');
  }

  function showTitleCard() {
    if (isTransitioning) return;
    isTransitioning = true;

    // Hide all stages
    stages.forEach(function (stage) {
      stage.classList.remove('is-active', 'is-exiting');
    });

    // Swap views
    utilityView.classList.remove('utilities-view--active');
    titleView.classList.add('utilities-view--active');

    currentUtilityId = null;

    setTimeout(function () {
      isTransitioning = false;
    }, 600);
  }

  function showUtility(utilityId, opts) {
    opts = opts || {};
    if (isTransitioning) return;
    isTransitioning = true;

    var incoming = getStage(utilityId);
    if (!incoming) {
      isTransitioning = false;
      return;
    }

    var outgoing = currentUtilityId ? getStage(currentUtilityId) : null;

    if (opts.fromTitle || !outgoing) {
      // Title → Utility: depth fade
      stages.forEach(function (s) {
        s.classList.remove('is-active', 'is-exiting');
      });
      incoming.classList.add('is-active');

      // Fire activate event for lazy-init listeners
      incoming.dispatchEvent(new CustomEvent('utility-activate', { bubbles: true }));

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
      var wrapper = outgoing.parentElement;
      var currentHeight = wrapper.scrollHeight;
      wrapper.style.minHeight = currentHeight + 'px';

      outgoing.classList.add('is-exiting');
      outgoing.classList.remove('is-active');

      incoming.classList.add('is-active');
      incoming.dispatchEvent(new CustomEvent('utility-activate', { bubbles: true }));

      currentUtilityId = utilityId;

      setTimeout(function () {
        outgoing.classList.remove('is-exiting');
        wrapper.style.minHeight = '';
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

  dropdownButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var uid = btn.dataset.utility;
      if (uid) setHash(uid);
      closeDropdown();
    });
  });

  // Dropdown toggle
  switcherTrigger && switcherTrigger.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleDropdown();
  });

  // Close dropdown on outside click
  document.addEventListener('click', function (e) {
    if (switcherDropdown && switcherDropdown.classList.contains('is-open') && !e.target.closest('.utility-switcher')) {
      closeDropdown();
    }
  });

  // Keyboard: Escape closes dropdown
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeDropdown();
    }
  });

  function toggleDropdown() {
    if (switcherDropdown.classList.contains('is-open')) {
      closeDropdown();
    } else {
      openDropdown();
    }
  }

  function openDropdown() {
    switcherDropdown.classList.add('is-open');
    switcherTrigger.setAttribute('aria-expanded', 'true');
  }

  function closeDropdown() {
    switcherDropdown.classList.remove('is-open');
    switcherTrigger.setAttribute('aria-expanded', 'false');
  }

  // Initialize on load
  navigateToTarget();
})();
