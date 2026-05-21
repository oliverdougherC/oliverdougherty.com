/**
 * Redirect phone-sized visitors away from desktop-only experiences.
 * Pages that include this script remain available with ?full=1.
 */

(function mobileGate() {
  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get('full') === '1') return;
  if (window.location.pathname.includes('/mobile/')) return;

  const coarseNarrow = window.matchMedia('(pointer: coarse) and (max-width: 900px)').matches;
  const narrowViewport = window.matchMedia('(max-width: 760px)').matches;
  if (!coarseNarrow && !narrowViewport) return;

  const path = window.location.pathname;
  const explicitTarget = document.currentScript?.dataset?.mobileTarget;
  if (explicitTarget) {
    window.location.replace(new URL(explicitTarget, window.location.href).href);
    return;
  }

  const pagesIndex = path.indexOf('/pages/');
  const siteRoot = pagesIndex >= 0 ? path.slice(0, pagesIndex) : '';
  const mobileHome = `${siteRoot}/mobile/`;

  window.location.replace(mobileHome);
})();
