import * as THREE from 'three';
import { GalleryItem } from './GalleryItem.js';
import { clamp, lerp } from './utils.js';

const SCENE_TUNING = {
  easingDivisor: 148,
  easingMin: 0.08,
  easingMax: 0.24,

  shiftXDesktop: 62,
  shiftXMobile: 38,
  shiftYDesktop: 34,
  shiftYMobile: 22,
  shiftZDesktop: 124,
  shiftZMobile: 96,

  visibleRangeDesktop: 9.2,
  visibleRangeMobile: 6.6,

  yawDriftDesktop: -1.7,
  yawDriftMobile: -1.2,
  rollDriftDesktop: 0.22,
  rollDriftMobile: 0.12,

  opacityFalloffDesktop: 0.07,
  opacityFalloffMobile: 0.09,
  scaleFalloffDesktop: 0.018,
  scaleFalloffMobile: 0.024,

  heroMaxVwDesktop: 0.46,
  heroMaxVhDesktop: 0.56,
  heroMaxVwMobile: 0.84,
  heroMaxVhMobile: 0.54,
  heroMinHeightDesktop: 154,
  heroMinHeightMobile: 118,

  indexModeOpacity: 0.02,
  minProjectedGapDesktop: -140,
  minProjectedGapMobile: -96
};

function toRadians(value) {
  return (Number(value) || 0) * (Math.PI / 180);
}

export class SceneController {
  constructor({
    scene,
    camera,
    entries,
    qualityProfile,
    isMobile = false,
    reducedMotion = false,
    onActiveIndexChange
  }) {
    this.scene = scene;
    this.camera = camera;
    this.entries = Array.isArray(entries) ? entries : [];
    this.qualityProfile = qualityProfile;
    this.isMobile = isMobile;
    this.reducedMotion = reducedMotion;
    this.onActiveIndexChange = onActiveIndexChange;

    this.textureLoader = new THREE.TextureLoader();
    this.items = [];
    this.progress = 0;
    this.targetProgress = 0;
    this.activeIndex = 0;
    this.mode = 'overview';

    this.visibleTargets = [];
    this.hoveredItem = null;
    this.inertialVelocity = 0;
    this.scrollJerk = 0;
    this.lights = [];

    this.layoutDebugState = {
      activeIndex: 0,
      activeCenterPx: 0,
      visibleRects: [],
      minGapPx: Infinity,
      maxGapPx: 0,
      activeNeighborGapPx: Infinity,
      activeYawDeg: 0,
      focusYawDeg: 0,
      inertialVelocity: 0,
      scrollJerk: 0,
      focusSafeZoneBreach: false,
      nearestFocusNeighborGapPx: Infinity,
      focus: {
        enabled: false,
        index: -1,
        safeTopPx: 0,
        safeBottomPx: 0,
        rectTopPx: 0,
        rectBottomPx: 0,
        safeTopBreached: false,
        safeBottomBreached: false,
        nearestGapPx: Infinity,
        nearestOpacity: 0
      }
    };

    this.layout = {
      viewportWidth: Math.max(window.innerWidth, 1),
      viewportHeight: Math.max(window.innerHeight, 1),
      fitMaxWidth: this.isMobile ? 520 : 820,
      fitMaxHeight: this.isMobile ? 340 : 540,
      heroMinHeight: this.isMobile ? SCENE_TUNING.heroMinHeightMobile : SCENE_TUNING.heroMinHeightDesktop,
      visibleRange: this.isMobile ? SCENE_TUNING.visibleRangeMobile : SCENE_TUNING.visibleRangeDesktop
    };
  }

  setupLighting() {
    if (this.lights.length) return;

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    const key = new THREE.DirectionalLight(0xffffff, 0.18);
    key.position.set(-300, 220, 520);

    const rim = new THREE.DirectionalLight(0xffffff, 0.12);
    rim.position.set(420, -180, 460);

    this.lights = [ambient, key, rim];
    for (const light of this.lights) {
      this.scene.add(light);
    }
  }

  init(maxAnisotropy) {
    this.items = this.entries.map((entry) => {
      const item = new GalleryItem({
        entry,
        textureLoader: this.textureLoader,
        maxAnisotropy,
        qualityLevel: this.qualityProfile.qualityLevel,
        isMobile: this.isMobile
      });
      this.scene.add(item.mesh);
      return item;
    });

    this.setupLighting();
    this.refreshLayoutMode(this.isMobile);
  }

  setMode(mode) {
    this.mode = mode === 'index' ? 'index' : 'overview';
    this.clearHover();
  }

  getMode() {
    return this.mode;
  }

  getItemCount() {
    return this.items.length;
  }

  getActiveEntry() {
    return this.entries[this.activeIndex] || null;
  }

  getDepthState() {
    return {
      focused: false,
      activeIndex: this.activeIndex,
      mode: this.mode
    };
  }

  getLayoutDebugState() {
    return this.layoutDebugState;
  }

  setInputTelemetry({ inertialVelocity = 0, scrollJerk = 0 } = {}) {
    this.inertialVelocity = Number.isFinite(inertialVelocity) ? inertialVelocity : 0;
    this.scrollJerk = Number.isFinite(scrollJerk) ? scrollJerk : 0;
  }

  setTargetProgress(progress01) {
    if (this.items.length <= 1) {
      this.targetProgress = 0;
      return;
    }

    this.targetProgress = clamp(progress01, 0, 1) * (this.items.length - 1);
  }

  jumpToIndex(index) {
    const bounded = clamp(index, 0, this.items.length - 1);
    this.targetProgress = bounded;
    if (this.reducedMotion) {
      this.progress = bounded;
    }
  }

  setQualityProfile(profile) {
    this.qualityProfile = profile;
    for (const item of this.items) {
      item.setQualityLevel(profile.qualityLevel);
    }
  }

  refreshLayoutMode(isMobile) {
    this.isMobile = isMobile;
    this.layout.visibleRange = this.isMobile ? SCENE_TUNING.visibleRangeMobile : SCENE_TUNING.visibleRangeDesktop;
    this.layout.heroMinHeight = this.isMobile ? SCENE_TUNING.heroMinHeightMobile : SCENE_TUNING.heroMinHeightDesktop;

    for (const item of this.items) {
      item.setViewportMode(this.isMobile);
    }

    this.updateViewportFitMetrics();
  }

  handleViewportResize() {
    this.updateViewportFitMetrics();
  }

  updateViewportFitMetrics() {
    this.layout.viewportWidth = Math.max(window.innerWidth, 1);
    this.layout.viewportHeight = Math.max(window.innerHeight, 1);

    const distance = Math.max(this.camera.position.z, 1);
    const fovRad = (this.camera.fov * Math.PI) / 180;

    const worldHeightAtCenter = 2 * Math.tan(fovRad * 0.5) * distance;
    const worldWidthAtCenter = worldHeightAtCenter * (this.layout.viewportWidth / this.layout.viewportHeight);

    const maxVw = this.isMobile ? SCENE_TUNING.heroMaxVwMobile : SCENE_TUNING.heroMaxVwDesktop;
    const maxVh = this.isMobile ? SCENE_TUNING.heroMaxVhMobile : SCENE_TUNING.heroMaxVhDesktop;

    this.layout.fitMaxWidth = worldWidthAtCenter * maxVw;
    this.layout.fitMaxHeight = worldHeightAtCenter * maxVh;
  }

  getBaseHeroHeightForAspect(aspectRatio) {
    const safeAspect = clamp(Number(aspectRatio) || 1.5, 0.45, 3.2);
    const maxHeight = Math.max(this.layout.fitMaxHeight, this.layout.heroMinHeight * 0.9);

    let height = Math.min(maxHeight, this.layout.fitMaxWidth / safeAspect);
    if (safeAspect < 1) {
      height *= lerp(1, 1.12, clamp((1 - safeAspect) / 0.5, 0, 1));
    }

    return clamp(height, this.layout.heroMinHeight, maxHeight);
  }

  getPixelScaleAtDepth(zPosition) {
    const distance = Math.max(this.camera.position.z - zPosition, 1);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const worldHeight = 2 * Math.tan(fovRad * 0.5) * distance;
    const worldWidth = worldHeight * (this.layout.viewportWidth / this.layout.viewportHeight);
    return this.layout.viewportWidth / Math.max(worldWidth, 1e-3);
  }

  getRaycastTargets() {
    return this.mode === 'overview' ? this.visibleTargets : [];
  }

  getItemIndexForItem(item) {
    if (!item) return -1;
    return this.items.indexOf(item);
  }

  clearHover() {
    if (this.hoveredItem) {
      this.hoveredItem.setHoverState(false);
      this.hoveredItem = null;
    }
  }

  applyHoverHit(hit) {
    if (this.mode !== 'overview' || !hit || !hit.item || this.isMobile) {
      this.clearHover();
      return;
    }

    if (this.hoveredItem && this.hoveredItem !== hit.item) {
      this.hoveredItem.setHoverState(false);
    }

    hit.item.setHoverState(true, hit.uv);
    this.hoveredItem = hit.item;
  }

  // Focus APIs retained as noops for backward compatibility.
  enterFocus() {}
  exitFocus() {}
  isFocused() {
    return false;
  }

  updateLayoutDebugState(debugRects, activeIndex, activeYawDeg) {
    if (!debugRects.length) {
      this.layoutDebugState = {
        activeIndex,
        activeCenterPx: this.layout.viewportWidth * 0.5,
        visibleRects: [],
        minGapPx: Infinity,
        maxGapPx: 0,
        activeNeighborGapPx: Infinity,
        activeYawDeg,
        focusYawDeg: 0,
        inertialVelocity: this.inertialVelocity,
        scrollJerk: this.scrollJerk,
        focusSafeZoneBreach: false,
        nearestFocusNeighborGapPx: Infinity,
        focus: {
          enabled: false,
          index: -1,
          safeTopPx: 0,
          safeBottomPx: 0,
          rectTopPx: 0,
          rectBottomPx: 0,
          safeTopBreached: false,
          safeBottomBreached: false,
          nearestGapPx: Infinity,
          nearestOpacity: 0
        }
      };
      return;
    }

    const sorted = [...debugRects].sort((a, b) => a.leftPx - b.leftPx);
    let minGapPx = Infinity;
    let maxGapPx = -Infinity;
    let activeNeighborGapPx = Infinity;

    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const gap = curr.leftPx - prev.rightPx;
      minGapPx = Math.min(minGapPx, gap);
      maxGapPx = Math.max(maxGapPx, gap);

      if (prev.index === activeIndex || curr.index === activeIndex) {
        activeNeighborGapPx = Math.min(activeNeighborGapPx, gap);
      }
    }

    const activeRect = sorted.find((rect) => rect.index === activeIndex) || sorted[0];

    this.layoutDebugState = {
      activeIndex,
      activeCenterPx: activeRect?.centerPx ?? this.layout.viewportWidth * 0.5,
      visibleRects: sorted,
      minGapPx,
      maxGapPx: Number.isFinite(maxGapPx) ? maxGapPx : 0,
      activeNeighborGapPx,
      activeYawDeg,
      focusYawDeg: 0,
      inertialVelocity: this.inertialVelocity,
      scrollJerk: this.scrollJerk,
      focusSafeZoneBreach: false,
      nearestFocusNeighborGapPx: Infinity,
      focus: {
        enabled: false,
        index: -1,
        safeTopPx: 0,
        safeBottomPx: 0,
        rectTopPx: 0,
        rectBottomPx: 0,
        safeTopBreached: false,
        safeBottomBreached: false,
        nearestGapPx: Infinity,
        nearestOpacity: 0
      }
    };
  }

  update(time, dtMs) {
    const S = SCENE_TUNING;

    const easing = this.reducedMotion ? 1 : clamp(dtMs / S.easingDivisor, S.easingMin, S.easingMax);
    this.progress = lerp(this.progress, this.targetProgress, easing);

    this.visibleTargets.length = 0;

    let nextActiveIndex = this.activeIndex;
    let closestDelta = Infinity;

    const debugRects = [];
    let activeYawDeg = 0;

    for (let i = 0; i < this.items.length; i += 1) {
      const item = this.items[i];
      const entry = this.entries[i];
      const overview = entry?.overview || {};

      const delta = i - this.progress;
      const absDelta = Math.abs(delta);
      if (absDelta < closestDelta) {
        closestDelta = absDelta;
        nextActiveIndex = i;
      }

      const baseHeight = this.getBaseHeroHeightForAspect(item.aspect || 1.5);
      const scaleFalloff = this.isMobile ? S.scaleFalloffMobile : S.scaleFalloffDesktop;
      const opacityFalloff = this.isMobile ? S.opacityFalloffMobile : S.opacityFalloffDesktop;
      const shiftX = this.isMobile ? S.shiftXMobile : S.shiftXDesktop;
      const shiftY = this.isMobile ? S.shiftYMobile : S.shiftYDesktop;
      const shiftZ = this.isMobile ? S.shiftZMobile : S.shiftZDesktop;
      const yawDrift = this.isMobile ? S.yawDriftMobile : S.yawDriftDesktop;
      const rollDrift = this.isMobile ? S.rollDriftMobile : S.rollDriftDesktop;

      const entryScale = Number.isFinite(overview.scale) ? overview.scale : 1;
      const scale = Math.max(0.62, entryScale - absDelta * scaleFalloff);

      const x = (overview.x || 0) + delta * shiftX;
      const y = (overview.y || 0) + delta * shiftY;
      const z = (overview.z || 0) + delta * shiftZ;

      const rotX = toRadians(overview.rotX || 0);
      const rotY = toRadians((overview.rotY || 0) + delta * yawDrift);
      const rotZ = toRadians((overview.rotZ || 0) + delta * rollDrift);

      const baseAlpha = clamp(Number(overview.alpha ?? 0.96), 0.1, 1);
      let opacity = clamp(baseAlpha - absDelta * opacityFalloff, 0.05, 1);
      if (this.mode === 'index') {
        opacity = Math.min(opacity, S.indexModeOpacity);
      }

      const visibleRange = this.layout.visibleRange;
      const visible = absDelta <= visibleRange;

      const transform = {
        x,
        y,
        z,
        rotX,
        rotY,
        rotZ,
        height: baseHeight,
        scale,
        opacity,
        visible
      };

      item.setTransform(transform);

      const phase = clamp(1 - absDelta / Math.max(visibleRange, 0.0001), 0, 1);
      item.setDepthProfile({ depthPhase: phase });
      item.update(time);

      if (visible && opacity > 0.025) {
        item.loadHighResTexture();
        if (this.mode === 'overview') {
          this.visibleTargets.push(item.getRaycastTarget());
        }

        const pxPerWorld = this.getPixelScaleAtDepth(z);
        const widthWorld = transform.height * (item.aspect || 1.5) * scale;
        const widthPx = widthWorld * pxPerWorld;
        const heightPx = transform.height * scale * pxPerWorld;
        const centerPx = this.layout.viewportWidth * 0.5 + x * pxPerWorld;
        const centerYPx = this.layout.viewportHeight * 0.5 - y * pxPerWorld;

        debugRects.push({
          index: i,
          centerPx,
          centerYPx,
          yawDeg: THREE.MathUtils.radToDeg(rotY),
          leftPx: centerPx - widthPx * 0.5,
          rightPx: centerPx + widthPx * 0.5,
          topPx: centerYPx - heightPx * 0.5,
          bottomPx: centerYPx + heightPx * 0.5,
          widthPx,
          heightPx,
          opacity
        });
      }

      if (i === nextActiveIndex) {
        activeYawDeg = THREE.MathUtils.radToDeg(rotY);
      }
    }

    this.updateLayoutDebugState(debugRects, nextActiveIndex, activeYawDeg);

    if (nextActiveIndex !== this.activeIndex) {
      this.activeIndex = nextActiveIndex;
      this.onActiveIndexChange?.(this.activeIndex, this.entries[this.activeIndex]);
    }
  }

  dispose() {
    for (const item of this.items) {
      this.scene.remove(item.mesh);
      item.dispose();
    }
    this.items.length = 0;

    for (const light of this.lights) {
      this.scene.remove(light);
    }
    this.lights.length = 0;
  }
}
