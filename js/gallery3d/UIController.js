export class UIController {
  constructor({
    entries,
    onSelectIndex,
    onModeChange,
    onInspectToggle,
    onInspectExit
  }) {
    this.entries = Array.isArray(entries) ? entries : [];
    this.onSelectIndex = onSelectIndex;
    this.onModeChange = onModeChange;
    this.onInspectToggle = onInspectToggle;
    this.onInspectExit = onInspectExit;

    this.shellEl = document.getElementById('galleryShell');
    this.counterEl = document.getElementById('galleryCounter');
    this.captionEl = document.getElementById('galleryCaption');
    this.indexPanelEl = document.getElementById('galleryIndexPanel');
    this.indexListEl = document.getElementById('galleryIndexList');
    this.modeOverviewBtn = document.getElementById('galleryModeOverview');
    this.modeIndexBtn = document.getElementById('galleryModeIndex');
    this.srDescEl = document.getElementById('gallerySrDesc');

    this.activeIndex = 0;
    this.mode = 'overview';
    this.renderMode = 'initializing';
    this.indexButtons = [];
    this.inspectMode = false;
    this.focusOverlayEl = null;

    this.handleGlobalKey = this.handleGlobalKey.bind(this);

    this.buildIndex();
    this.bindEvents();
    this.ensureFocusOverlay();
  }

  bindEvents() {
    this.modeOverviewBtn?.addEventListener('click', () => {
      this.onModeChange?.('overview');
    });

    this.modeIndexBtn?.addEventListener('click', () => {
      this.onModeChange?.('index');
    });

    document.addEventListener('keydown', this.handleGlobalKey);
  }

  ensureFocusOverlay() {
    if (this.focusOverlayEl || !this.shellEl) return;

    const overlay = document.createElement('div');
    overlay.id = 'galleryFocusOverlay';
    overlay.className = 'gallery-focus-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    this.shellEl.appendChild(overlay);
    this.focusOverlayEl = overlay;
  }

  buildIndex() {
    if (!this.indexListEl) return;

    this.indexListEl.innerHTML = '';
    this.indexButtons.length = 0;

    for (let i = 0; i < this.entries.length; i += 1) {
      const entry = this.entries[i];
      const li = document.createElement('li');
      li.className = 'gallery-index-item';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gallery-index-btn gallery-index-row';
      button.dataset.index = String(i);

      const year = document.createElement('span');
      year.className = 'year';
      year.textContent = entry.index?.year || this.extractYearFromDate(entry.meta?.date) || '----';

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = entry.title || `Photo ${i + 1}`;

      const category = document.createElement('span');
      category.className = 'category';
      category.textContent = entry.index?.category || 'Photo';

      button.appendChild(year);
      button.appendChild(title);
      button.appendChild(category);

      button.addEventListener('click', () => {
        this.onSelectIndex?.(i, { fromIndex: true });
      });

      li.appendChild(button);
      this.indexListEl.appendChild(li);
      this.indexButtons.push(button);
    }
  }

  extractYearFromDate(dateValue) {
    if (!dateValue) return '';
    const normalized = String(dateValue);
    const match = normalized.match(/(19|20)\d{2}/);
    return match ? match[0] : '';
  }

  setRenderMode(mode) {
    this.renderMode = mode;
  }

  setDepthState(depthState = {}) {
    this.setInspectMode(Boolean(depthState.focused));
  }

  setInspectMode(active) {
    const next = Boolean(active) && this.mode === 'overview';
    this.inspectMode = next;
    this.ensureFocusOverlay();
    this.focusOverlayEl?.classList.toggle('is-active', next);
    this.focusOverlayEl?.setAttribute('aria-hidden', String(!next));
    document.body?.setAttribute('data-gallery-inspect', String(next));
    if (this.shellEl) {
      this.shellEl.dataset.inspect = String(next);
    }
  }

  setMode(nextMode) {
    const mode = nextMode === 'index' ? 'index' : 'overview';
    this.mode = mode;

    const inIndex = mode === 'index';
    if (this.indexPanelEl) {
      this.indexPanelEl.hidden = !inIndex;
    }

    this.modeOverviewBtn?.classList.toggle('is-active', !inIndex);
    this.modeOverviewBtn?.setAttribute('aria-selected', String(!inIndex));
    this.modeIndexBtn?.classList.toggle('is-active', inIndex);
    this.modeIndexBtn?.setAttribute('aria-selected', String(inIndex));

    if (inIndex) {
      this.setInspectMode(false);
      const activeButton = this.indexButtons[this.activeIndex];
      activeButton?.focus({ preventScroll: true });
    }
  }

  getMode() {
    return this.mode;
  }

  setActive(index, entry) {
    if (!this.entries.length) {
      if (this.counterEl) this.counterEl.textContent = '00 / 00';
      if (this.captionEl) this.captionEl.textContent = 'No photos';
      return;
    }

    const bounded = Math.max(0, Math.min(index, this.entries.length - 1));
    const resolved = entry || this.entries[bounded];
    this.activeIndex = bounded;

    if (this.counterEl) {
      const current = String(bounded + 1).padStart(2, '0');
      const total = String(this.entries.length).padStart(2, '0');
      this.counterEl.textContent = `${current} / ${total}`;
    }

    if (this.captionEl) {
      this.captionEl.textContent = resolved?.title || `Photo ${bounded + 1}`;
    }

    for (let i = 0; i < this.indexButtons.length; i += 1) {
      this.indexButtons[i].classList.toggle('is-active', i === bounded);
    }

    this.updateSrDescription(resolved);
  }

  updateSrDescription(entry) {
    if (!this.srDescEl || !entry) return;

    const parts = [entry.title || 'Untitled'];
    if (entry.index?.year) parts.push(`Year ${entry.index.year}`);
    if (entry.index?.category) parts.push(entry.index.category);
    this.srDescEl.textContent = `Photo: ${parts.join(' \u2014 ')}`;
  }

  focusIndexRow(index) {
    const target = this.indexButtons[Math.max(0, Math.min(index, this.indexButtons.length - 1))];
    target?.focus();
  }

  handleGlobalKey(event) {
    const activeEl = document.activeElement;
    if (activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA' || activeEl?.isContentEditable) {
      return;
    }

    if (!this.entries.length) return;

    if (event.key === 'i' || event.key === 'I') {
      event.preventDefault();
      this.onModeChange?.(this.mode === 'index' ? 'overview' : 'index');
      return;
    }

    if (event.key === 'Escape' && this.inspectMode) {
      event.preventDefault();
      this.onInspectExit?.();
      return;
    }

    if (event.key === 'Escape' && this.mode === 'index') {
      event.preventDefault();
      this.onModeChange?.('overview');
      return;
    }

    if ((event.key === 'Enter' || event.key === ' ') && this.mode === 'overview') {
      event.preventDefault();
      this.onInspectToggle?.(this.activeIndex);
      return;
    }

    if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      const next = Math.min(this.entries.length - 1, this.activeIndex + 1);
      this.onSelectIndex?.(next, { fromKeyboard: true });
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      const prev = Math.max(0, this.activeIndex - 1);
      this.onSelectIndex?.(prev, { fromKeyboard: true });
      return;
    }

    if (this.mode === 'index' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const next = Math.max(0, Math.min(this.entries.length - 1, this.activeIndex + direction));
      this.onSelectIndex?.(next, { fromKeyboard: true, fromIndex: true });
      this.focusIndexRow(next);
    }
  }

  dispose() {
    document.removeEventListener('keydown', this.handleGlobalKey);
    document.body?.removeAttribute('data-gallery-inspect');
    this.focusOverlayEl?.remove();
    this.focusOverlayEl = null;
  }
}
