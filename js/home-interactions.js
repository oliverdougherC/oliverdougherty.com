/* Small, native-button interactions for the homepage. */
(function () {
  'use strict';

  const copyButton = document.querySelector('button[data-copy-email]');
  const copyStatus = document.querySelector('[data-copy-status]');

  if (copyButton && copyStatus) {
    let latestAttempt = 0;
    let fadeTimer;
    let clearTimer;

    const resetStatus = () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(clearTimer);
      copyStatus.classList.remove('is-fading');
      copyStatus.replaceChildren();
    };

    const showSuccessStatus = () => {
      const message = document.createElement('span');
      message.className = 'copy-status-message';
      message.textContent = 'copied! your move, ';
      const emphasis = document.createElement('span');
      emphasis.className = 'copy-status-emphasis';
      emphasis.textContent = 'stranger...';
      copyStatus.replaceChildren(message, emphasis);
      copyStatus.classList.remove('is-fading');
      fadeTimer = window.setTimeout(() => copyStatus.classList.add('is-fading'), 1800);
      clearTimer = window.setTimeout(resetStatus, 6800);
    };

    copyButton.addEventListener('click', async () => {
      const attempt = ++latestAttempt;
      resetStatus();

      try {
        await navigator.clipboard.writeText(copyButton.dataset.copyEmail);
        if (attempt === latestAttempt) {
          showSuccessStatus();
        }
      } catch (_error) {
        if (attempt === latestAttempt) {
          copyStatus.textContent = 'Select the address above to copy it.';
        }
      }
    });
  }

})();
