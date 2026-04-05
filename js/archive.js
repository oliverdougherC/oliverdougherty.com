/**
 * Technical Archive JavaScript
 * Handles search and filtering. Navigation and scroll animations
 * are provided by main.js (loaded before this script).
 */

document.addEventListener('DOMContentLoaded', () => {
  const state = createArchiveState();
  if (!state.cards.length) return;

  initSearch(state);
  initFilters(state);
  applyArchiveFilters(state);
});

function createArchiveState() {
  const cards = Array.from(document.querySelectorAll('.report-card')).map((card) => ({
    element: card,
    category: card.dataset.category || '',
    searchableText: [
      card.querySelector('.report-title')?.textContent || '',
      card.querySelector('.report-desc')?.textContent || '',
      card.querySelector('.report-category')?.textContent || ''
    ]
      .join(' ')
      .toLowerCase()
  }));

  return {
    cards,
    searchInput: document.getElementById('searchInput'),
    filterButtons: Array.from(document.querySelectorAll('.filter-tag')),
    noResults: document.getElementById('noResults'),
    query: '',
    activeFilter: 'all'
  };
}

function initSearch(state) {
  if (!state.searchInput) return;

  state.searchInput.addEventListener(
    'input',
    debounce((event) => {
      state.query = event.target.value.toLowerCase().trim();
      state.activeFilter = 'all';
      syncFilterButtons(state);
      applyArchiveFilters(state);
    }, 150)
  );
}

function initFilters(state) {
  state.filterButtons.forEach((button) => {
    button.addEventListener('click', () => {
      state.activeFilter = button.dataset.filter || 'all';
      if (state.searchInput) {
        state.searchInput.value = '';
      }
      state.query = '';
      syncFilterButtons(state);
      applyArchiveFilters(state);
    });
  });
}

function syncFilterButtons(state) {
  state.filterButtons.forEach((button) => {
    const isActive = (button.dataset.filter || 'all') === state.activeFilter;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

function setCardVisible(card, visible) {
  card.element.classList.toggle('hidden', !visible);
  card.element.setAttribute('aria-hidden', String(!visible));
}

function applyArchiveFilters(state) {
  let visibleCount = 0;

  for (const card of state.cards) {
    const matchesFilter = state.activeFilter === 'all' || card.category === state.activeFilter;
    const matchesQuery = !state.query || card.searchableText.includes(state.query);
    const visible = matchesFilter && matchesQuery;

    setCardVisible(card, visible);
    if (visible) {
      visibleCount += 1;
    }
  }

  if (state.noResults) {
    state.noResults.style.display = visibleCount === 0 ? 'block' : 'none';
  }
}
