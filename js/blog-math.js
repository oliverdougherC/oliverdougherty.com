(function () {
  function logMathDebug(payload) {
    // #region agent log
    fetch('http://127.0.0.1:7403/ingest/a2020613-78e7-4ef7-9f13-5525141f6258', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': '4dda7d'
      },
      body: JSON.stringify({
        sessionId: '4dda7d',
        timestamp: Date.now(),
        location: 'js/blog-math.js',
        ...payload
      })
    }).catch(function () {});
    // #endregion
  }

  function inspectMathState(phase) {
    var latexBlock = document.querySelector('.latex-block');
    var inlineParagraph = document.querySelector('.blog-body p:nth-of-type(4)');
    logMathDebug({
      runId: 'post-fix',
      hypothesisId: 'A',
      message: 'KaTeX availability check',
      data: {
        phase: phase,
        katexDefined: typeof katex !== 'undefined',
        renderMathDefined: typeof renderMathInElement !== 'undefined',
        katexElementCount: document.querySelectorAll('.katex').length,
        latexBlockHasRawDelimiters: latexBlock ? /\$\$/.test(latexBlock.textContent) : null,
        inlineParagraphHasRawDelimiters: inlineParagraph ? /\\\(|\\\)/.test(inlineParagraph.textContent) : null
      }
    });
  }

  function renderBlogMath() {
    inspectMathState('before-render');

    if (typeof renderMathInElement !== 'function') {
      logMathDebug({
        runId: 'post-fix',
        hypothesisId: 'B',
        message: 'renderMathInElement unavailable',
        data: { readyState: document.readyState }
      });
      return;
    }

    try {
      renderMathInElement(document.body, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\(', right: '\\)', display: false }
        ]
      });
      inspectMathState('after-render');
    } catch (error) {
      logMathDebug({
        runId: 'post-fix',
        hypothesisId: 'E',
        message: 'renderMathInElement threw',
        data: { error: String(error && error.message ? error.message : error) }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderBlogMath);
  } else {
    renderBlogMath();
  }
})();
