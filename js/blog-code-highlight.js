(function () {
  var COPY_LABEL = 'COPY';
  var COPIED_LABEL = 'COPIED';
  var COPY_FEEDBACK_MS = 1600;

  function extractLanguageFromClass(className) {
    var match = String(className || '').match(/\blanguage-([a-z0-9+#.-]+)/i);
    return match ? match[1] : '';
  }

  function getCodeText(code) {
    return (code && (code.innerText || code.textContent)) || '';
  }

  function showCopyFeedback(button) {
    button.textContent = COPIED_LABEL;
    button.classList.add('is-copied');
    window.setTimeout(function () {
      button.textContent = COPY_LABEL;
      button.classList.remove('is-copied');
    }, COPY_FEEDBACK_MS);
  }

  function fallbackCopyText(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    var copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    document.body.removeChild(area);
    return copied;
  }

  function copyCodeFromButton(button) {
    var shell = button.closest('.blog-code-block-shell');
    var code = shell && shell.querySelector('pre code');
    var text = getCodeText(code);
    if (!text) return;

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () {
        showCopyFeedback(button);
      }).catch(function () {
        if (fallbackCopyText(text)) showCopyFeedback(button);
      });
      return;
    }

    if (fallbackCopyText(text)) showCopyFeedback(button);
  }

  function ensureCopyButton(shell) {
    var button = shell.querySelector('.blog-code-copy');
    if (button) return button;

    var toolbar = document.createElement('div');
    toolbar.className = 'blog-code-block-toolbar';

    button = document.createElement('button');
    button.type = 'button';
    button.className = 'blog-code-copy';
    button.setAttribute('aria-label', 'Copy code to clipboard');
    button.textContent = COPY_LABEL;
    button.addEventListener('click', function () {
      copyCodeFromButton(button);
    });

    toolbar.appendChild(button);
    shell.insertBefore(toolbar, shell.firstChild);
    return button;
  }

  function wrapCodeBlock(pre) {
    var parent = pre.parentElement;
    if (parent && parent.classList.contains('blog-code-block-shell')) {
      ensureCopyButton(parent);
      return parent;
    }

    var shell = document.createElement('div');
    shell.className = 'blog-code-block-shell';
    pre.parentNode.insertBefore(shell, pre);
    shell.appendChild(pre);
    ensureCopyButton(shell);
    return shell;
  }

  function prepareCodeBlocks(root) {
    root.querySelectorAll('pre').forEach(function (pre) {
      var code = pre.querySelector('code');
      if (!code) return;

      var lang =
        pre.getAttribute('data-language') ||
        pre.getAttribute('data-lang') ||
        extractLanguageFromClass(code.className);

      if (lang && !/\blanguage-/.test(code.className)) {
        code.classList.add('language-' + lang);
      }
    });
  }

  function syncOverflowFocus(pre) {
    if (pre.scrollWidth > pre.clientWidth) {
      pre.setAttribute('tabindex', '0');
    } else {
      pre.removeAttribute('tabindex');
    }
  }

  window.normalizeBlogCodeBlocks = function normalizeBlogCodeBlocks(root) {
    if (!root) return;

    root.querySelectorAll('pre').forEach(function (pre) {
      pre.classList.add('blog-code-block');
      wrapCodeBlock(pre);
      syncOverflowFocus(pre);
    });

    prepareCodeBlocks(root);
  };

  window.highlightBlogCode = function highlightBlogCode() {
    var root = document.querySelector('.blog-body');
    if (!root) return;

    normalizeBlogCodeBlocks(root);

    if (typeof Prism === 'undefined') return;

    root.querySelectorAll('pre code').forEach(function (block) {
      if (!extractLanguageFromClass(block.className)) return;
      Prism.highlightElement(block);
    });

    root.querySelectorAll('pre.blog-code-block').forEach(syncOverflowFocus);
  };

  function init() {
    if (typeof Prism !== 'undefined' && Prism.plugins && Prism.plugins.autoloader) {
      Prism.plugins.autoloader.languages_path =
        'https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/';
    }
    highlightBlogCode();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
