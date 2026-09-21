/* A decorative chance study: three kept dice, two independently rerolled dice. */
(function () {
  'use strict';
  const piece = document.querySelector('[data-motion="keiri"]');
  if (!piece) return;
  const pairs = Array.from({ length: 36 }, (_, i) => [Math.floor(i / 6) + 1, i % 6 + 1]);
  const pips = [
    [[0,0]], [[-3.5,-3.5],[3.5,3.5]], [[-3.5,-3.5],[0,0],[3.5,3.5]],
    [[-3.5,-3.5],[3.5,-3.5],[-3.5,3.5],[3.5,3.5]],
    [[-3.5,-3.5],[3.5,-3.5],[0,0],[-3.5,3.5],[3.5,3.5]],
    [[-3.5,-4],[3.5,-4],[-3.5,0],[3.5,0],[-3.5,4],[3.5,4]]
  ];
  const roll = () => 1 + Math.floor(Math.random() * 6);
  function draw(group, value) {
    group.dataset.face = String(value);
    group.replaceChildren(...pips[value - 1].map(([x,y]) => {
      const pip = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      pip.setAttribute('cx', String(x));
      pip.setAttribute('cy', String(y));
      pip.setAttribute('r', '1.5');
      return pip;
    }));
  }
  function nextRoll() {
    const kept = roll();
    const outcome = [roll(), roll()];
    const index = (outcome[0] - 1) * 6 + outcome[1] - 1;
    piece.keiriPossibility = { kept: [kept, kept, kept], outcome, pairs };
    piece.dataset.cycle = String(Number(piece.dataset.cycle || 0) + 1);
    piece.querySelectorAll('.keiri-core-die').forEach((die) => draw(die, kept));
    draw(piece.querySelector('.keiri-observed-a'), outcome[0]);
    draw(piece.querySelector('.keiri-observed-b'), outcome[1]);
    const source = piece.querySelector(`.keiri-pair[data-pair-index="${index}"]`);
    const ring = Number(source.dataset.ring);
    const angle = Number(source.dataset.angle) + (ring === 0 ? 20 : -20);
    const radius = ring === 0 ? 128 : 88;
    const observed = piece.querySelector('.keiri-observed');
    observed.style.setProperty('--observed-x', `${250 + Math.cos(angle * Math.PI / 180) * radius}px`);
    observed.style.setProperty('--observed-y', `${160 + Math.sin(angle * Math.PI / 180) * radius}px`);
    // Choose the shortest turn home, including outcomes on the left of the ring.
    observed.style.setProperty('--observed-angle', `${((angle + 270) % 360) - 180}deg`);
    observed.dataset.pairIndex = String(index);
  }
  nextRoll();
  piece.addEventListener('animationiteration', (event) => {
    if (event.animationName === 'keiri-rosette-clock' && piece.dataset.running === 'true') nextRoll();
  });
})();
