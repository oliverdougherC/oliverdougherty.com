document.addEventListener('DOMContentLoaded', () => {
  const name1 = document.getElementById('typeTargetName1');
  const name2 = document.getElementById('typeTargetName2');
  const subtitle = document.getElementById('typeTargetSubtitle');
  const cursor = document.getElementById('typeCursor');
  const heroContact = document.querySelector('.hero-contact');
  const metaTiny = document.querySelector('.meta-tiny');
  const navToggle = document.getElementById('navToggle');

  if (!name1 || !name2 || !cursor) {
    return;
  }

  const targetText1 = 'Oliver';
  const targetText2 = 'Dougherty';
  let typingCancelled = false;
  window.addEventListener('pagehide', () => {
    typingCancelled = true;
  }, { once: true });

  const wait = (duration) => new Promise((resolve) => {
    window.setTimeout(resolve, duration);
  });

  const revealPage = () => {
    // Stagger reveal of hero elements so they appear in sequence
    const revealSequence = [
      { el: subtitle, delay: 0 },
      { el: heroContact, delay: 200 },
      { el: metaTiny, delay: 400 },
      { el: navToggle, delay: 600 }
    ];

    revealSequence.forEach(({ el, delay }) => {
      if (!el) return;
      setTimeout(() => {
        el.classList.remove('resume-hidden');
        el.style.transition = 'opacity 0.8s ease';
        el.style.opacity = '1';
        if (el === navToggle) {
          el.style.pointerEvents = 'auto';
        }
      }, delay);
    });

    // Use IntersectionObserver for scroll-based content reveals
    // instead of forcing all sections visible at once
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

      document.querySelectorAll('.resume-main [data-animate]').forEach((el) => {
        observer.observe(el);
      });
    } else {
      // Fallback: reveal all if IntersectionObserver not available
      document.querySelectorAll('.resume-main [data-animate]').forEach((el) => {
        el.classList.add('visible');
      });
    }
  };

  const typeText = async (element, text) => {
    const hasCursor = element.contains(cursor);
    element.textContent = '';
    const textNode = document.createTextNode('');
    element.appendChild(textNode);

    if (hasCursor) {
      element.appendChild(cursor);
    }

    for (let index = 0; index < text.length && !typingCancelled; index += 1) {
      textNode.textContent += text.charAt(index);
      let delay = 60 + Math.random() * 60;
      if (Math.random() < 0.25) delay += 150 + Math.random() * 200;
      await wait(delay);
    }
  };

  const runSequence = async () => {
    // Clear both names immediately so neither is visible before typing starts
    name1.textContent = '';
    name2.textContent = '';

    // Make spans visible so typed characters appear
    name1.style.opacity = '1';
    name2.style.opacity = '1';

    name1.appendChild(cursor);
    cursor.style.display = 'inline-block';
    cursor.style.visibility = '';

    await wait(400);
    if (typingCancelled) return;

    await typeText(name1, targetText1);
    if (typingCancelled) return;

    await wait(200 + Math.random() * 100);
    if (typingCancelled) return;

    // Move cursor to name2 without resetting the CSS animation.
    // Preserving animation elapsed time prevents a visible flash caused
    // by DOM removal restarting the @keyframes blink from 0%.
    if (name1.contains(cursor)) {
      const anims = cursor.getAnimations();
      let elapsed = 0;
      if (anims.length > 0) {
        elapsed = anims[0].currentTime || 0;
      }
      name1.removeChild(cursor);
      name2.appendChild(cursor);
      if (anims.length > 0 && elapsed > 0) {
        const newAnims = cursor.getAnimations();
        if (newAnims.length > 0) {
          newAnims[0].currentTime = elapsed;
        }
      }
    }

    await wait(200 + Math.random() * 100);
    if (typingCancelled) return;

    await typeText(name2, targetText2);
    if (typingCancelled) return;

    // Reveal remaining UI elements AFTER typing is complete
    revealPage();

    // Wait then hide cursor — removed the animation restart code that
    // caused a visible flash (setting animation='none' forces opacity:1,
    // then restarting with step-end jumps to opacity:0).
    await wait(1000);
    if (typingCancelled) return;
    cursor.style.animation = 'none';
    cursor.style.visibility = 'hidden';
  };

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    name1.textContent = targetText1;
    name2.textContent = targetText2;
    cursor.style.visibility = 'hidden';
    revealPage();
  } else {
    runSequence().catch((error) => {
      console.error('Resume typing animation failed.', error);
      name1.textContent = targetText1;
      name2.textContent = targetText2;
      cursor.style.visibility = 'hidden';
      revealPage();
    });
  }
});
