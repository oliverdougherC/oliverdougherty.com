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
    const revealEls = [subtitle, heroContact, metaTiny, navToggle];
    revealEls.forEach((el) => {
      if (!el) return;
      el.classList.remove('resume-hidden');
      el.style.transition = 'opacity 0.8s ease';
      el.style.opacity = '1';
    });

    document.querySelectorAll('.resume-main [data-animate]').forEach((el) => {
      el.classList.add('visible');
    });
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
    name1.appendChild(cursor);
    cursor.style.display = 'inline-block';
    cursor.style.visibility = '';

    await wait(400);
    if (typingCancelled) return;

    await typeText(name1, targetText1);
    if (typingCancelled) return;

    await wait(200 + Math.random() * 100);
    if (typingCancelled) return;

    if (name1.contains(cursor)) {
      name1.removeChild(cursor);
    }
    name2.appendChild(cursor);

    await wait(200 + Math.random() * 100);
    if (typingCancelled) return;

    // Reveal subtitle and contact info in parallel while surname types
    revealPage();

    await typeText(name2, targetText2);
    if (typingCancelled) return;

    await wait(200);
    if (typingCancelled) return;

    cursor.style.animation = 'none';
    void cursor.offsetHeight;
    cursor.style.animation = 'blink 1s step-end infinite';

    await wait(800);
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
