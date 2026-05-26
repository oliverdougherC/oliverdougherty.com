(function () {
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

  function extractLanguageFromClass(className) {
    var match = String(className || '').match(/\blanguage-([a-z0-9+#.-]+)/i);
    return match ? match[1] : '';
  }

  window.highlightBlogCode = function highlightBlogCode() {
    var root = document.querySelector('.blog-body');
    if (!root || typeof Prism === 'undefined') return;

    prepareCodeBlocks(root);
    root.querySelectorAll('pre code').forEach(function (block) {
      if (!extractLanguageFromClass(block.className)) return;
      Prism.highlightElement(block);
    });
  }

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
