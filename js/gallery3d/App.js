import { DEFAULT_QUALITY, WebGL } from './WebGL.js';
import { SceneController } from './SceneController.js';
import { InputController } from './InputController.js';
import { UIController } from './UIController.js';
import { clamp, toNumber } from './utils.js';

function fallbackOverview(index) {
  return {
    x: -120 + index * 72,
    y: 88 - index * 38,
    z: -40 - index * 110,
    rotX: (index % 3 - 1) * 0.6,
    rotY: -22 + index * 2.3,
    rotZ: (index % 4 - 1.5) * 0.5,
    scale: 1 - (index % 5) * 0.018,
    alpha: clamp(0.94 - index * 0.01, 0.56, 0.94)
  };
}

function fallbackYear(entry, index) {
  const direct = String(entry?.meta?.date || '').match(/(19|20)\d{2}/);
  if (direct) return direct[0];
  return String(2025 - Math.min(index, 2));
}

function normalizeEntry(entry, index) {
  const overview = {
    ...fallbackOverview(index),
    ...(entry.overview || {})
  };

  const normalizedIndex = {
    year: String(entry.index?.year || fallbackYear(entry, index)),
    category: String(entry.index?.category || 'Photo').toUpperCase()
  };

  return {
    id: entry.id || `photo-${index + 1}`,
    title: entry.title || `Untitled ${index + 1}`,
    src: entry.src || {},
    meta: entry.meta || {},
    colorGrade: {
      temperature: toNumber(entry.colorGrade?.temperature, 0),
      tint: toNumber(entry.colorGrade?.tint, 0),
      exposure: clamp(toNumber(entry.colorGrade?.exposure, 1), 0.96, 1.04)
    },
    overview: {
      x: toNumber(overview.x, 0),
      y: toNumber(overview.y, 0),
      z: toNumber(overview.z, 0),
      rotX: toNumber(overview.rotX, 0),
      rotY: toNumber(overview.rotY, 0),
      rotZ: toNumber(overview.rotZ, 0),
      scale: clamp(toNumber(overview.scale, 1), 0.52, 1.4),
      alpha: clamp(toNumber(overview.alpha, 0.95), 0.1, 1)
    },
    index: normalizedIndex,
    aspect: toNumber(entry.aspect, 1.5)
  };
}

async function loadSequenceFromJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}`);
  }

  const data = await response.json();
  if (!Array.isArray(data.items)) {
    throw new Error('Invalid gallery sequence schema');
  }

  return data.items.map((entry, index) => normalizeEntry(entry, index));
}

function mapPhotoToEntry(photo, index) {
  const title = photo.title || photo.filename || `Photo ${index + 1}`;
  const fallbackPath = `../../photos/${photo.filename}`;
  const mediumJpg = photo.medium?.jpg ? `../../photos/medium/${photo.medium.jpg}` : fallbackPath;
  const largeJpg = photo.large?.jpg ? `../../photos/large/${photo.large.jpg}` : mediumJpg;
  const thumbJpg = photo.thumbs?.jpg ? `../../photos/thumbs/${photo.thumbs.jpg}` : mediumJpg;

  const width = toNumber(photo.medium?.width || photo.width, 1600);
  const height = toNumber(photo.medium?.height || photo.height, 1067);

  return normalizeEntry({
    id: photo.filename || `photo-${index + 1}`,
    title,
    src: {
      thumb: thumbJpg,
      medium: mediumJpg,
      large: largeJpg,
      avif: photo.large?.avif ? `../../photos/large/${photo.large.avif}` : undefined,
      webp: photo.large?.webp ? `../../photos/large/${photo.large.webp}` : undefined
    },
    meta: {
      date: photo.exif?.date || 'Unknown date',
      lens: photo.exif?.lens || 'Unknown lens',
      location: 'Archive',
      notes: [
        photo.exif?.aperture ? `f/${photo.exif.aperture}` : null,
        photo.exif?.shutter ? `${photo.exif.shutter}s` : null,
        photo.exif?.iso ? `ISO ${photo.exif.iso}` : null
      ].filter(Boolean).join(' \u2022 ') || 'No notes'
    },
    overview: fallbackOverview(index),
    index: {
      year: fallbackYear({ meta: { date: photo.exif?.date } }, index),
      category: 'PHOTO'
    },
    aspect: width / Math.max(height, 1),
    colorGrade: {
      temperature: 0,
      tint: 0,
      exposure: 1
    }
  }, index);
}

async function loadSequenceWithFallback() {
  try {
    return await loadSequenceFromJson('../../photos/gallery-sequence.json');
  } catch (_error) {
    const response = await fetch('../../photos/photos.json');
    if (!response.ok) {
      throw new Error('Failed to load both gallery-sequence.json and photos.json');
    }

    const data = await response.json();
    const source = Array.isArray(data.photos) ? data.photos.slice(0, 18) : [];
    return source.map((photo, index) => mapPhotoToEntry(photo, index));
  }
}

function getConnection() {
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
}

function isConstrainedDevice() {
  const hardwareThreads = Number(navigator.hardwareConcurrency) || 0;
  const deviceMemory = Number(navigator.deviceMemory) || 0;
  return (
    (hardwareThreads > 0 && hardwareThreads <= 4) ||
    (deviceMemory > 0 && deviceMemory <= 4)
  );
}

function isConstrainedNetwork() {
  const connection = getConnection();
  if (!connection) return false;

  if (connection.saveData) return true;
  const effectiveType = String(connection.effectiveType || '').toLowerCase();
  return effectiveType.includes('2g') || effectiveType === '3g';
}

function pickInitialQuality({ isMobile }) {
  if (isMobile) {
    return {
      qualityName: 'mobile',
      qualityOrder: ['mobile']
    };
  }

  const constrained = isConstrainedDevice() || isConstrainedNetwork();
  return {
    qualityName: constrained ? 'medium' : 'high',
    qualityOrder: ['ultra', 'high', 'medium']
  };
}

export class App {
  constructor({
    canvasSelector = '#galleryWebglCanvas',
    shellSelector = '#galleryShell',
    scrollTrackSelector = '#galleryScrollTrack'
  } = {}) {
    this.canvas = document.querySelector(canvasSelector);
    this.shell = document.querySelector(shellSelector);
    this.scrollTrack = document.querySelector(scrollTrackSelector);

    this.isDestroyed = false;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.isMobile = window.matchMedia('(max-width: 980px), (pointer: coarse)').matches;

    const initialQuality = pickInitialQuality({ isMobile: this.isMobile });
    this.qualityOrder = initialQuality.qualityOrder;
    this.qualityName = initialQuality.qualityName;
    this.qualityProfile = DEFAULT_QUALITY[this.qualityName];

    this.mode = 'overview';
    this.renderMode = 'initializing';

    this.frameWindow = [];
    this.lastPerfCheck = 0;

    this.raf = this.raf.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handleCanvasClick = this.handleCanvasClick.bind(this);

    if (this.shell) {
      this.shell.dataset.mode = this.mode;
    }

    this.setRenderMode('initializing');

    this.init().catch((error) => {
      console.error('Gallery initialization error:', error);
      this.activateFallback('Unable to initialize gallery. Compatibility mode is active.', error);
    });
  }

  async init() {
    if (!this.canvas || !this.shell || !this.scrollTrack) {
      return;
    }

    try {
      this.entries = await loadSequenceWithFallback();
    } catch (error) {
      this.initUI([]);
      this.activateFallback('Unable to load gallery data. Compatibility mode is active.', error);
      return;
    }

    this.initUI(this.entries);
    if (!this.entries.length) {
      this.activateFallback('No gallery items are available.');
      return;
    }

    try {
      this.initRenderPipeline();
    } catch (error) {
      this.activateFallback('3D renderer unavailable. Compatibility mode is active.', error);
      return;
    }

    this.setRenderMode('render');

    this.inputController = new InputController({
      shell: this.shell,
      scrollTrack: this.scrollTrack,
      totalItems: this.entries.length,
      reducedMotion: this.reducedMotion,
      onProgress: (progress, meta = {}) => {
        if (this.mode !== 'overview') return;

        this.sceneController?.setTargetProgress(progress);
        this.sceneController?.setInputTelemetry?.({
          inertialVelocity: meta.inertialVelocity || 0,
          scrollJerk: meta.scrollJerk || 0
        });
      },
      onPointerMove: ({ clientX, clientY }) => {
        this.webgl?.setPointer(clientX, clientY);
      },
      onPointerLeave: () => {
        this.webgl?.clearPointer();
        this.sceneController?.clearHover?.();
      },
      onClick: ({ clientX, clientY }) => {
        this.handleCanvasClick(clientX, clientY);
      }
    });

    this.shell.dataset.quality = this.qualityName;
    this.setMode('overview', { initial: true });

    window.addEventListener('resize', this.handleResize, { passive: true });
    requestAnimationFrame(this.raf);
  }

  initUI(entries) {
    this.entries = Array.isArray(entries) ? entries : [];

    this.uiController?.dispose();
    this.uiController = new UIController({
      entries: this.entries,
      onSelectIndex: (index, meta = {}) => {
        this.handleSelectIndex(index, meta);
      },
      onModeChange: (mode) => {
        this.setMode(mode);
      }
    });

    this.uiController.setActive(0, this.entries[0]);
    this.uiController.setMode(this.mode);
  }

  initRenderPipeline() {
    this.webgl = new WebGL({
      canvas: this.canvas,
      perspective: 900,
      qualityName: this.qualityName,
      qualityMap: DEFAULT_QUALITY
    });

    this.sceneController = new SceneController({
      scene: this.webgl.scene,
      camera: this.webgl.camera,
      entries: this.entries,
      qualityProfile: this.qualityProfile,
      isMobile: this.isMobile,
      reducedMotion: this.reducedMotion,
      onActiveIndexChange: (index, entry) => {
        this.uiController?.setActive(index, entry);
      }
    });

    this.sceneController.init(this.webgl.getMaxAnisotropy());
  }

  setMode(nextMode, { initial = false } = {}) {
    const mode = nextMode === 'index' ? 'index' : 'overview';
    if (!initial && mode === this.mode) return;

    this.mode = mode;

    if (this.shell) {
      this.shell.dataset.mode = mode;
    }

    this.sceneController?.setMode(mode);
    this.uiController?.setMode(mode);

    if (this.inputController) {
      this.inputController.setEnabled(mode === 'overview');
      if (mode === 'overview') {
        const anchor = this.sceneController?.activeIndex ?? this.uiController?.activeIndex ?? 0;
        this.inputController.setCurrentIndex(anchor);
      }
    }

    window.__galleryMode = mode;
  }

  getMode() {
    return this.mode;
  }

  setRenderMode(mode) {
    this.renderMode = mode;
    if (this.shell) {
      this.shell.dataset.renderMode = mode;
    }
    window.__galleryRenderMode = mode;
  }

  handleSelectIndex(index, meta = {}) {
    if (!this.entries?.length) return;

    const bounded = Math.min(Math.max(index, 0), this.entries.length - 1);
    const entry = this.entries[bounded];

    if (this.inputController) {
      this.inputController.scrollToIndex(bounded);
    } else {
      this.sceneController?.jumpToIndex(bounded);
    }

    this.uiController?.setActive(bounded, entry);

    if (meta.fromIndex || this.mode === 'index') {
      this.setMode('overview');
    }
  }

  handleCanvasClick(clientX, clientY) {
    if (this.mode !== 'overview' || !this.webgl || !this.sceneController || !this.inputController) return;

    this.webgl.setPointer(clientX, clientY);
    const hit = this.webgl.raycast(this.sceneController.getRaycastTargets());
    if (!hit?.item) return;

    const hitIndex = this.sceneController.getItemIndexForItem(hit.item);
    if (hitIndex < 0) return;

    if (hitIndex !== this.sceneController.activeIndex) {
      this.inputController.scrollToIndex(hitIndex);
      this.uiController?.setActive(hitIndex, this.entries[hitIndex]);
    }
  }

  activateFallback(message, error) {
    if (error) {
      console.error('Gallery fallback activated:', error);
    }

    this.disposeRenderPipeline();
    this.setRenderMode('fallback');

    if (this.canvas) {
      this.canvas.style.opacity = '0';
    }

    const caption = document.getElementById('galleryCaption');
    if (caption) {
      caption.textContent = message;
    }

    this.uiController?.setMode('index');
  }

  disposeRenderPipeline() {
    this.inputController?.dispose();
    this.inputController = null;

    this.sceneController?.dispose();
    this.sceneController = null;

    this.webgl?.dispose();
    this.webgl = null;

    window.removeEventListener('resize', this.handleResize);
  }

  updatePerfStats(dtMs, now) {
    this.frameWindow.push(dtMs);
    if (this.frameWindow.length > 120) {
      this.frameWindow.shift();
    }

    if (now - this.lastPerfCheck < 900) {
      return;
    }

    this.lastPerfCheck = now;
    const sum = this.frameWindow.reduce((acc, value) => acc + value, 0);
    const avg = sum / Math.max(this.frameWindow.length, 1);

    window.__galleryPerfStats = {
      quality: this.qualityName,
      avgFrameMs: Number(avg.toFixed(2)),
      fps: Number((1000 / Math.max(avg, 1)).toFixed(1)),
      framesSampled: this.frameWindow.length,
      activeIndex: this.sceneController?.activeIndex ?? this.uiController?.activeIndex ?? 0,
      renderMode: this.renderMode,
      mode: this.mode
    };
  }

  raf(time) {
    if (this.isDestroyed || !this.sceneController || !this.webgl) return;

    const dtMs = this.prevTime ? time - this.prevTime : 16.67;
    this.prevTime = time;

    this.inputController?.update(dtMs, time);
    this.sceneController.update(time * 0.001, dtMs);

    if (!this.webgl.contextLost) {
      const shouldRaycast = this.mode === 'overview' && this.webgl.isPointerActive() && !this.isMobile;
      const hit = shouldRaycast
        ? this.webgl.raycast(this.sceneController.getRaycastTargets())
        : null;

      this.sceneController.applyHoverHit(hit);

      if (this.canvas) {
        const nextCursor = this.mode === 'overview' && hit?.item ? 'pointer' : 'default';
        if (this.canvas.style.cursor !== nextCursor) {
          this.canvas.style.cursor = nextCursor;
        }
      }

      this.webgl.render();
    }

    this.updatePerfStats(dtMs, time);
    requestAnimationFrame(this.raf);
  }

  handleResize() {
    const mobile = window.matchMedia('(max-width: 980px), (pointer: coarse)').matches;

    this.webgl?.handleResize();

    if (this.sceneController) {
      if (mobile !== this.isMobile) {
        this.isMobile = mobile;
        this.sceneController.refreshLayoutMode(this.isMobile);

        const nextInitialQuality = pickInitialQuality({ isMobile: this.isMobile });
        this.qualityOrder = nextInitialQuality.qualityOrder;

        if (this.qualityName !== nextInitialQuality.qualityName) {
          this.qualityName = nextInitialQuality.qualityName;
          this.qualityProfile = DEFAULT_QUALITY[this.qualityName];
          this.webgl.setQualityProfile(this.qualityName);
          this.sceneController.setQualityProfile(this.qualityProfile);
          if (this.shell) {
            this.shell.dataset.quality = this.qualityName;
          }
        }
      }

      this.sceneController.handleViewportResize();
    }

    this.inputController?.updateTrackHeight();
  }

  dispose() {
    this.isDestroyed = true;
    this.disposeRenderPipeline();
    this.uiController?.dispose();
  }
}
