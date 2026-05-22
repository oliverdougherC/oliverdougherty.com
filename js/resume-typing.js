document.addEventListener('DOMContentLoaded', () => {
  const name1 = document.getElementById('typeTargetName1');
  const name2 = document.getElementById('typeTargetName2');
  const subtitle = document.getElementById('typeTargetSubtitle');
  const heroContact = document.querySelector('.hero-contact');
  const metaTiny = document.querySelector('.meta-tiny');
  const navToggle = document.getElementById('navToggle');

  if (!name1 || !name2) {
    return;
  }

  let animationCancelled = false;
  window.addEventListener('pagehide', () => {
    animationCancelled = true;
  }, { once: true });

  const wait = (duration) => new Promise((resolve) => {
    window.setTimeout(resolve, duration);
  });

  const revealPage = (immediate = false) => {
    // Stagger reveal of remaining hero elements
    const revealSequence = [
      { el: heroContact, delay: 0 },
      { el: metaTiny, delay: 200 },
      { el: navToggle, delay: 400 }
    ];

    revealSequence.forEach(({ el, delay }) => {
      if (!el) return;
      const revealDelay = immediate ? 0 : delay;
      setTimeout(() => {
        el.classList.remove('resume-hidden');
        if (immediate) {
          el.style.transition = 'none';
        } else {
          el.style.transition = 'opacity 0.8s ease';
        }
        el.style.opacity = '1';
        if (el === navToggle) {
          el.style.pointerEvents = 'auto';
        }
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

  const runSequence = async () => {
    await wait(300);
    if (animationCancelled) return;

    name1.classList.add('is-revealing');

    await wait(300);
    if (animationCancelled) return;

    name2.classList.add('is-revealing');

    await wait(400);
    if (animationCancelled) return;

    if (subtitle) {
      subtitle.classList.add('is-revealing');
    }

    await wait(400);
    if (animationCancelled) return;

    // Reveal remaining UI elements
    revealPage();
  };

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    name1.classList.add('is-revealing');
    name2.classList.add('is-revealing');
    if (subtitle) {
      subtitle.classList.add('is-revealing');
    }
    revealPage();
  } else if (window.pageAnimations?.shouldSkip?.()) {
    name1.classList.add('is-revealing');
    name2.classList.add('is-revealing');
    if (subtitle) {
      subtitle.classList.add('is-revealing');
    }
    revealPage(true);
  } else {
    window.pageAnimations?.markSeen?.();
    runSequence().catch((error) => {
      console.error('Resume animation failed.', error);
      name1.classList.add('is-revealing');
      name2.classList.add('is-revealing');
      if (subtitle) {
        subtitle.classList.add('is-revealing');
      }
      revealPage();
    });
  }
});
