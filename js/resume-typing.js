document.addEventListener('DOMContentLoaded', () => {
  const name1 = document.getElementById('typeTargetName1');
  const name2 = document.getElementById('typeTargetName2');
  const subtitle = document.getElementById('typeTargetSubtitle');
  const heroContact = document.querySelector('.hero-contact');
  const metaTiny = document.querySelector('.meta-tiny');
  const navActions = document.querySelector('[data-nav-actions]');

  if (!name1 || !name2) {
    return;
  }

  let pageRevealed = false;

  const revealEssentialImmediately = () => {
    for (const element of [heroContact, metaTiny, navActions]) {
      if (!element) continue;
      element.classList.remove('resume-hidden');
      element.style.transition = 'none';
      element.style.opacity = '1';
    }
  };

  const revealPage = (immediate = false) => {
    // Content reveal (hero stagger + scroll observers) must be installed
    // exactly once per document. A BFCache restore keeps this DOM and JS
    // state alive, and lifecycle recovery may call revealPage() again.
    if (pageRevealed) {
      return;
    }
    pageRevealed = true;

    // Stagger reveal of remaining hero elements
    const revealSequence = [
      { el: heroContact, delay: 0 },
      { el: metaTiny, delay: 200 },
      { el: navActions, delay: 400, usesSharedReveal: true }
    ];

    revealSequence.forEach(({ el, delay, usesSharedReveal = false }) => {
      if (!el) return;
      const revealDelay = immediate ? 0 : delay;
      setTimeout(() => {
        el.classList.remove('resume-hidden');
        if (usesSharedReveal) {
          if (immediate) {
            el.style.transition = 'none';
          } else {
            el.style.transition = 'opacity 0.8s ease';
          }
          el.style.opacity = '1';
          return;
        }
        if (immediate) {
          el.style.transition = 'none';
        } else {
          el.style.transition = 'opacity 0.8s ease';
        }
        el.style.opacity = '1';
      }, revealDelay);
    });

    // Use IntersectionObserver for scroll-based content reveals
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            if (entry.target.classList.contains('redact-target')) {
              // Slight random delay so they don't all reveal perfectly in sync if they enter at the exact same time
              setTimeout(() => {
                entry.target.classList.add('is-revealing');
              }, Math.random() * 200);
            } else {
              entry.target.classList.add('visible');
            }
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

      document.querySelectorAll('.resume-main [data-animate], .resume-content .redact-target').forEach((el) => {
        observer.observe(el);
      });
    } else {
      // Fallback: reveal all if IntersectionObserver not available
      document.querySelectorAll('.resume-main [data-animate]').forEach((el) => {
        el.classList.add('visible');
      });
      document.querySelectorAll('.resume-content .redact-target').forEach((el) => {
        el.classList.add('is-revealing');
      });
    }
  };

  // The intro is a step list driven by owned timers instead of one linear
  // promise chain. A persisted `pagehide` (BFCache freeze) can land between
  // any two steps; the old permanent `animationCancelled` flag left restored
  // documents half-revealed forever because DOMContentLoaded never reruns.
  // Now: suspend clears the owned step timer, and the matching persisted
  // `pageshow` resumes from the exact step index that was pending.
  const introSteps = [
    { delay: 300, reveal: () => name1.classList.add('is-revealing') },
    { delay: 300, reveal: () => name2.classList.add('is-revealing') },
    { delay: 400, reveal: () => { if (subtitle) subtitle.classList.add('is-revealing'); } },
    { delay: 400, reveal: () => revealPage() }
  ];

  let nextStepIndex = 0;
  let stepTimer = null;
  let settleTimer = null;
  let suspended = false; // between a persisted pagehide and its pageshow
  let settled = false;   // intro has reached its terminal revealed state

  const clearOwnedTimers = () => {
    if (stepTimer !== null) {
      window.clearTimeout(stepTimer);
      stepTimer = null;
    }
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  // Terminal state: everything revealed, nothing left to wait on. Used by
  // the watchdog so a stalled or interrupted run can never leave essential
  // navigation, contact info, or content hidden.
  const finishIntro = () => {
    if (settled) {
      return;
    }
    clearOwnedTimers();
    settled = true;
    name1.classList.add('is-revealing');
    name2.classList.add('is-revealing');
    if (subtitle) {
      subtitle.classList.add('is-revealing');
    }
    revealPage();
  };

  const runNextStep = () => {
    const step = introSteps[nextStepIndex];
    stepTimer = window.setTimeout(() => {
      stepTimer = null;
      if (suspended || settled) {
        return;
      }
      try {
        step.reveal();
      } catch (error) {
        console.error('Resume animation failed.', error);
        finishIntro();
        return;
      }
      nextStepIndex += 1;
      if (nextStepIndex >= introSteps.length) {
        settled = true;
        if (settleTimer !== null) {
          window.clearTimeout(settleTimer);
          settleTimer = null;
        }
      } else {
        runNextStep();
      }
    }, step.delay);
  };

  const startOrResumeIntro = () => {
    // Re-arming replaces any stale watchdog from a previous attempt so a
    // long suspension does not trip the old deadline the instant timers
    // restart; the watchdog remains armed during suspension itself, so a
    // document that is revived without pageshow (or whose resume is
    // swallowed) still converges to the fully revealed state.
    clearOwnedTimers();
    let remaining = 0;
    for (let i = nextStepIndex; i < introSteps.length; i += 1) {
      remaining += introSteps[i].delay;
    }
    settleTimer = window.setTimeout(finishIntro, remaining + 1500);
    runNextStep();
  };

  window.addEventListener('pagehide', (event) => {
    // Only documents that announce BFCache eligibility can come back later;
    // a discarded document has no future to protect. If a browser hides the
    // page without setting `persisted` yet keeps the document alive, the
    // frozen step timers simply resume on their own.
    if (!event.persisted) return;
    if (settled) {
      revealEssentialImmediately();
      return;
    }
    suspended = true;
    if (stepTimer !== null) {
      window.clearTimeout(stepTimer);
      stepTimer = null;
    }
  });

  window.addEventListener('pageshow', (event) => {
    // DOMContentLoaded owns fresh loads; this handler only revives documents
    // that were suspended by a persisted pagehide. Re-entrant synthetic
    // events cannot double-arm because resume requires `suspended`.
    if (!event.persisted) return;
    if (settled) {
      revealEssentialImmediately();
      return;
    }
    if (!suspended) return;
    suspended = false;
    startOrResumeIntro();
  });

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    settled = true;
    name1.classList.add('is-revealing');
    name2.classList.add('is-revealing');
    if (subtitle) {
      subtitle.classList.add('is-revealing');
    }
    revealPage();
  } else if (window.pageAnimations?.shouldSkip?.()) {
    settled = true;
    name1.classList.add('is-revealing');
    name2.classList.add('is-revealing');
    if (subtitle) {
      subtitle.classList.add('is-revealing');
    }
    revealPage(true);
  } else {
    window.pageAnimations?.markSeen?.();
    startOrResumeIntro();
  }
});
