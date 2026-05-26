(function () {
  'use strict';

  var posts = [];
  var currentSlug = null;

  /* --- Slugify --- */
  function slugify(filename) {
    return filename
      .replace('.md', '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  /* --- Frontmatter parser --- */
  function parseFrontmatter(content) {
    var match = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!match) return { meta: {}, body: content };

    var meta = {};
    for (var i = 0; i < match[1].split('\n').length; i++) {
      var line = match[1].split('\n')[i];
      var sep = line.indexOf(':');
      if (sep === -1) continue;
      var key = line.slice(0, sep).trim();
      var value = line.slice(sep + 1).trim();
      if (key && value) meta[key] = value;
    }
    return { meta: meta, body: content.slice(match[0].length) };
  }

  /* --- Format date for display --- */
  function formatDate(dateStr) {
    if (!dateStr) return '';
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];

    var parts = dateStr.split(' ');
    if (parts.length >= 3) {
      var month = parts[0];
      var day = parts[1].replace(/,/g, '');
      var year = parts[2];
      var monthIdx = months.indexOf(month);
      if (monthIdx === -1) monthIdx = months.indexOf(month.charAt(0).toUpperCase() + month.slice(1, 3));
      if (monthIdx !== -1) {
        return months[monthIdx] + ' ' + day + ', ' + year;
      }
    }
    return dateStr;
  }

  /* --- Extract title from markdown body --- */
  function extractTitle(body) {
    var match = body.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : '';
  }

  /* --- Build sidebar --- */
  function buildSidebar() {
    var sidebar = document.querySelector('.blog-sidebar');
    if (!sidebar) return;

    var html = '';
    for (var i = 0; i < posts.length; i++) {
      var post = posts[i];
      var title = post.title || post.filename.replace('.md', '');
      var dateStr = post.date ? formatDate(post.date) : '';
      var activeClass = post.slug === currentSlug ? ' active' : '';
      html += '<a href="#post=' + post.slug + '" class="blog-list-item' + activeClass + '">' +
        '<div class="blog-list-title">' + escapeHtml(title) + '</div>';
      if (dateStr) {
        html += '<div class="blog-list-date">' + escapeHtml(dateStr) + '</div>';
      }
      html += '</a>';
    }
    sidebar.innerHTML = html;
  }

  /* --- Escape HTML --- */
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  /* --- Render post --- */
  function renderPost(slug) {
    var post = null;
    for (var i = 0; i < posts.length; i++) {
      if (posts[i].slug === slug) {
        post = posts[i];
        break;
      }
    }
    if (!post) return;

    currentSlug = slug;

    var bodyEl = document.querySelector('.blog-body');
    var titleEl = document.querySelector('.blog-title');
    var subtitleEl = document.querySelector('.blog-subtitle');

    if (bodyEl) {
      var rendered = marked.parse(post.body);
      bodyEl.innerHTML = rendered;
    }

    if (titleEl) {
      var title = post.title || post.filename.replace('.md', '');
      titleEl.textContent = title;
    }

    if (subtitleEl) {
      subtitleEl.textContent = post.date ? formatDate(post.date) : '';
    }

    document.title = (post.title || post.filename.replace('.md', '')) + ' | Blog';

    buildSidebar();
    renderPostExtras();
  }

  /* --- Re-run Prism + KaTeX after render --- */
  function renderPostExtras() {
    /* Prism */
    if (typeof window.highlightBlogCode === 'function') {
      window.highlightBlogCode();
    }

    /* KaTeX */
    if (typeof window.renderBlogMath === 'function') {
      window.renderBlogMath();
    }
  }

  /* --- Resolve hash to slug --- */
  function hashToSlug() {
    var hash = window.location.hash;
    if (hash.startsWith('#post=')) {
      return hash.slice(6);
    }
    return null;
  }

  /* --- Initialize --- */
  function init() {
    /* Wait for marked to load */
    if (typeof marked === 'undefined') {
      setTimeout(init, 50);
      return;
    }

    var manifestUrl = '../../blogs/manifest.json';
    var blogsDir = '../../blogs/';

    fetch(manifestUrl)
      .then(function (res) { return res.json(); })
      .then(function (manifest) {
        /* Fetch all markdown files */
        var fetches = manifest.map(function (entry) {
          return fetch(blogsDir + entry.filename)
            .then(function (res) { return res.text(); })
            .then(function (content) {
              var parsed = parseFrontmatter(content);
              return {
                filename: entry.filename,
                slug: entry.slug,
                date: entry.date,
                title: extractTitle(parsed.body),
                body: parsed.body
              };
            });
        });

        return Promise.all(fetches);
      })
      .then(function (loadedPosts) {
        posts = loadedPosts;

        var slug = hashToSlug();
        if (!slug) {
          /* Default to first (newest) post */
          slug = posts.length > 0 ? posts[0].slug : null;
          if (slug) {
            window.location.hash = '#post=' + slug;
          }
        }

        if (slug) {
          renderPost(slug);
        }
      })
      .catch(function (err) {
        console.error('Blog engine failed to load:', err);
      });
  }

  /* --- Hash change listener --- */
  window.addEventListener('hashchange', function () {
    var slug = hashToSlug();
    if (slug && slug !== currentSlug) {
      renderPost(slug);
    }
  });

  /* Start */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
