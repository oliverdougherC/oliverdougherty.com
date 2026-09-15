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

  // Hovering “excursions” plays a short, non-looping audio excerpt, fading in
  // and out smoothly; moving the pointer away fades it out and stops, and the
  // file’s own abrupt ending dissolves into silence instead of cutting.
  const excursionTrigger = document.querySelector('.excursion-trigger');
  if (excursionTrigger) {
    const PEAK_VOLUME = 0.35;
    const FADE_IN_MS = 600;
    const FADE_OUT_MS = 1500;
    const TAIL_FADE_MS = 1500;

    let audio = null;
    let playing = false;
    let volume = 0;
    let fadeToken = 0;

    const ensureAudio = () => {
      if (!audio) {
        audio = new Audio(excursionTrigger.dataset.audio);
        audio.preload = 'auto';
        audio.addEventListener('ended', () => {
          fadeToken += 1;
          playing = false;
          volume = 0;
          audio.volume = 0;
        });
      }
      return audio;
    };

    const start = () => {
      const source = ensureAudio();
      fadeToken += 1;
      const token = fadeToken;
      playing = true;
      volume = 0;
      source.currentTime = 0;
      source.volume = 0;
      const startedAt = window.performance.now();
      const tick = (now) => {
        if (token !== fadeToken || !playing) {
          return;
        }
        let target = PEAK_VOLUME;
        const sinceStart = now - startedAt;
        if (sinceStart < FADE_IN_MS) {
          target = PEAK_VOLUME * (sinceStart / FADE_IN_MS);
        }
        // The excerpt itself ends mid-note: dissolve to silence over its final
        // TAIL_FADE_MS so the end reads as a fade, not a cut.
        const remainingMs = (source.duration - source.currentTime) * 1000;
        if (source.duration > 0 && remainingMs <= TAIL_FADE_MS) {
          const tail = Math.max(remainingMs / TAIL_FADE_MS, 0);
          target = Math.min(target, PEAK_VOLUME * tail * tail);
        }
        volume = target;
        source.volume = volume;
        window.requestAnimationFrame(tick);
      };
      source
        .play()
        .then(() => {
          if (token === fadeToken && playing) {
            window.requestAnimationFrame(tick);
          }
        })
        .catch(() => {
          // Autoplay blocked or playback failed: the excerpt stays silent.
        });
    };

    const stop = () => {
      if (!playing) {
        return;
      }
      playing = false;
      const source = ensureAudio();
      fadeToken += 1;
      const token = fadeToken;
      const startVolume = volume;
      const startedAt = window.performance.now();
      const fadeDown = (now) => {
        if (token !== fadeToken) {
          return;
        }
        const progress = Math.min((now - startedAt) / FADE_OUT_MS, 1);
        const fade = 1 - progress;
        volume = startVolume * fade * fade;
        source.volume = volume;
        if (progress < 1) {
          window.requestAnimationFrame(fadeDown);
        } else {
          source.pause();
          source.currentTime = 0;
          volume = 0;
          source.volume = 0;
        }
      };
      window.requestAnimationFrame(fadeDown);
    };

    excursionTrigger.addEventListener('mouseenter', start);
    excursionTrigger.addEventListener('mouseleave', stop);
  }

})();
