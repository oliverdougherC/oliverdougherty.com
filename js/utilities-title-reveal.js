(function () {
  'use strict';

  var buttons = Array.from(document.querySelectorAll('.utilities-buttons button'));
  var homeBtn = document.querySelector('.nav-home-btn');
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function enableHomeButton() {
    if (homeBtn) {
      homeBtn.style.pointerEvents = 'auto';
    }
  }

  function revealAllButtons() {
    buttons.forEach(function (btn) {
      btn.classList.add('is-visible');
    });
  }

  if (!buttons.length) {
    enableHomeButton();
    return;
  }

  if (reducedMotion) {
    revealAllButtons();
    enableHomeButton();
    return;
  }

  var shuffled = buttons.slice();
  for (var index = shuffled.length - 1; index > 0; index -= 1) {
    var swapIndex = Math.floor(Math.random() * (index + 1));
    var current = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = current;
  }

  var startDelayMs = 3500;
  var totalStaggerMs = 2000;
  var stepMs = shuffled.length > 1 ? totalStaggerMs / (shuffled.length - 1) : totalStaggerMs;
  var revealSchedule = shuffled.map(function (btn, index) {
    var jitter = (Math.random() - 0.5) * (stepMs * 0.35);
    return {
      button: btn,
      at: Math.max(0, startDelayMs + (index * stepMs) + jitter)
    };
  });
  var revealedCount = 0;
  var activeElapsedMs = 0;
  var lastTimestamp = null;

  function tick(timestamp) {
    if (lastTimestamp !== null) {
      activeElapsedMs += Math.min(timestamp - lastTimestamp, 120);
    }
    lastTimestamp = timestamp;

    while (revealedCount < revealSchedule.length && activeElapsedMs >= revealSchedule[revealedCount].at) {
      revealSchedule[revealedCount].button.classList.add('is-visible');
      revealedCount += 1;
    }

    if (revealedCount < revealSchedule.length) {
      window.requestAnimationFrame(tick);
    }
  }

  window.requestAnimationFrame(tick);

  if (homeBtn) {
    function handleAnimationEnd() {
      enableHomeButton();
      homeBtn.removeEventListener('animationend', handleAnimationEnd);
    }

    homeBtn.addEventListener('animationend', handleAnimationEnd);
    window.setTimeout(enableHomeButton, 7600);
  }
})();
