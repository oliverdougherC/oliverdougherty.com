/**
 * Shared footer-year utility and global color-mode toggle.
 */

const COLOR_MODE_STORAGE_KEY = 'od-color-mode';
const COLOR_MODE_DARK = 'dark';
const COLOR_MODE_LIGHT = 'light';
const COLOR_MODE_DISABLED = (() => {
  const attr = document.documentElement.getAttribute('data-disable-color-mode');
  return attr != null && attr !== 'false';
})();

applyColorMode(getInitialColorMode());

document.addEventListener('DOMContentLoaded', () => {
  setCurrentYear();
  if (!COLOR_MODE_DISABLED) {
    initColorModeToggle();
    window.addEventListener('storage', handleColorModeStorageSync);
  }
});

function setCurrentYear() {
  const currentYear = String(new Date().getFullYear());
  document.querySelectorAll('[data-current-year]').forEach((el) => {
    el.textContent = currentYear;
  });
}

function getInitialColorMode() {
  if (COLOR_MODE_DISABLED) {
    return COLOR_MODE_DARK;
  }

  const storedColorMode = readStoredColorMode();
  if (storedColorMode) return storedColorMode;
  return COLOR_MODE_DARK;
}

 function readStoredColorMode() {
  try {
    const stored = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY);
    if (stored === COLOR_MODE_DARK || stored === COLOR_MODE_LIGHT) {
      return stored;
    }
  } catch (_error) {
    // Ignore storage failures (privacy modes / blocked storage).
  }

  return null;
}

function persistColorMode(mode) {
  try {
    window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, mode);
  } catch (_error) {
    // Ignore storage failures.
  }
}

function applyColorMode(mode) {
  if (COLOR_MODE_DISABLED) {
    document.documentElement.setAttribute('data-color-mode', COLOR_MODE_DARK);
    document.documentElement.style.colorScheme = COLOR_MODE_DARK;
    return;
  }

  const normalizedMode = mode === COLOR_MODE_LIGHT ? COLOR_MODE_LIGHT : COLOR_MODE_DARK;
  document.documentElement.setAttribute('data-color-mode', normalizedMode);
  document.documentElement.style.colorScheme = normalizedMode;
}

function getAppliedColorMode() {
  const applied = document.documentElement.getAttribute('data-color-mode');
  return applied === COLOR_MODE_LIGHT ? COLOR_MODE_LIGHT : COLOR_MODE_DARK;
}

function handleColorModeStorageSync(event) {
  if (COLOR_MODE_DISABLED) return;
  if (event.key !== COLOR_MODE_STORAGE_KEY) return;

  const nextMode = event.newValue === COLOR_MODE_LIGHT ? COLOR_MODE_LIGHT : COLOR_MODE_DARK;
  applyColorMode(nextMode);
  syncColorModeToggleLabels(nextMode);
}

function buildThemeToggleButton() {
  const toggleButton = document.createElement('button');
  toggleButton.type = 'button';
  toggleButton.className = 'theme-toggle';
  toggleButton.setAttribute('data-theme-toggle', '');
  toggleButton.setAttribute('data-cursor', 'hover');
  toggleButton.innerHTML = '<span class="theme-toggle-icon" aria-hidden="true"></span>';
  return toggleButton;
}

function bindThemeToggleButton(button) {
  if (button.dataset.themeToggleBound === 'true') {
    return;
  }

  button.dataset.themeToggleBound = 'true';
  button.type = 'button';
  button.classList.add('theme-toggle');
  if (!button.querySelector('.theme-toggle-icon')) {
    button.innerHTML = '<span class="theme-toggle-icon" aria-hidden="true"></span>';
  }
  if (!button.hasAttribute('data-cursor')) {
    button.setAttribute('data-cursor', 'hover');
  }

  button.addEventListener('click', () => {
    const currentMode = getAppliedColorMode();
    const nextMode = currentMode === COLOR_MODE_LIGHT ? COLOR_MODE_DARK : COLOR_MODE_LIGHT;
    applyColorMode(nextMode);
    persistColorMode(nextMode);
    syncColorModeToggleLabels(nextMode);
  });
}

function initColorModeToggle() {
  if (COLOR_MODE_DISABLED) return;
  let toggleButtons = Array.from(document.querySelectorAll('[data-theme-toggle], .theme-toggle'));

  if (!toggleButtons.length) {
    const mount = findColorModeToggleMount();
    if (!mount) return;

    const toggleButton = buildThemeToggleButton();
    if (mount.type === 'shared-nav') {
      const navToggleButton = mount.element.querySelector('#navToggle, .nav-toggle');
      if (navToggleButton) {
        mount.element.insertBefore(toggleButton, navToggleButton);
      } else {
        mount.element.appendChild(toggleButton);
      }
    } else {
      mount.element.appendChild(toggleButton);
    }

    toggleButtons = [toggleButton];
  }

  toggleButtons.forEach(bindThemeToggleButton);
  syncColorModeToggleLabels(getAppliedColorMode());
}

function findColorModeToggleMount() {
  const sharedNavControls = document.querySelector('.nav-controls');
  if (sharedNavControls) {
    return { type: 'shared-nav', element: sharedNavControls };
  }

  const abstractNavLinks = document.querySelector('.abstract-nav .nav-links');
  if (abstractNavLinks) {
    return { type: 'abstract-nav', element: abstractNavLinks };
  }

  const galleryActions = document.querySelector('.gallery-actions');
  if (galleryActions) {
    return { type: 'gallery-actions', element: galleryActions };
  }

  return null;
}

function syncColorModeToggleLabels(mode) {
  const toggleButtons = document.querySelectorAll('[data-theme-toggle], .theme-toggle');
  const nextMode = mode === COLOR_MODE_LIGHT ? COLOR_MODE_DARK : COLOR_MODE_LIGHT;

  toggleButtons.forEach((button) => {
    const label = button.querySelector('.theme-toggle-text');
    if (label) {
      label.textContent = nextMode === COLOR_MODE_LIGHT ? 'Light' : 'Dark';
    }

    button.setAttribute('aria-pressed', String(mode === COLOR_MODE_LIGHT));
    button.setAttribute('aria-label', `Switch to ${nextMode} mode`);
    button.dataset.mode = mode;
  });
}
