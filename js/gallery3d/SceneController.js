import * as THREE from 'three';
import { GalleryItem } from './GalleryItem.js';
import { clamp, lerp } from './utils.js';

const SCENE_TUNING = {
  easingDivisor: 72,
  easingMin: 0.14,
  easingMax: 0.3,

  laneDesktop: {
    originX: -28,
    originY: -34,
    originZ: -120,
    xStep: 150,
    yStep: 36,
    zStep: -34,
    baseYawDeg: -6.8,
    yawDeltaDeg: 0.92,
    rollAltDeg: 0.18,
    visibleRange: 3.85,
    scaleMin: 0.58,
    scaleCurve: 0.94,
    opacityMin: 0.008,
    opacityCurve: 2.7
  },
  laneMobile: {
    originX: -14,
    originY: -24,
    originZ: -92,
    xStep: 94,
    yStep: 20,
    zStep: -26,
    baseYawDeg: -6.2,
    yawDeltaDeg: 0.86,
    rollAltDeg: 0.14,
    visibleRange: 3.15,
    scaleMin: 0.54,
    scaleCurve: 0.98,
    opacityMin: 0.006,
    opacityCurve: 2.8
  },
  activeScaleMax: 1.02,
  activeOpacityMax: 0.99,

  positionClampXDesktop: 920,
  positionClampXMobile: 480,
  positionClampYDesktop: 208,
  positionClampYMobile: 156,
  positionClampZFront: 42,
  positionClampZBack: -320,

  overlapTargetMinPx: -28,
  overlapTargetMaxPx: 26,
  spacingCorrectionPasses: 3,
  spacingCorrectionYMix: 0.3,
  activeCenterRatioDesktop: 0.44,
  activeCenterRatioMobile: 0.5,
  overviewCenterStartDesktop: 0.29,
  overviewCenterEndDesktop: 0.62,
  overviewCenterStartMobile: 0.28,
  overviewCenterEndMobile: 0.58,
  fanSpreadXDesktop: 64,
  fanSpreadYDesktop: 28,
  fanSpreadXMobile: 32,
  fanSpreadYMobile: 14,

  heroMaxVwDesktop: 0.35,
  heroMaxVhDesktop: 0.56,
  heroMaxVwMobile: 0.78,
  heroMaxVhMobile: 0.48,
  heroMinHeightDesktop: 150,
  heroMinHeightMobile: 104,

  focusEnterMix: 0.24,
  focusExitMix: 0.22,
  focusThresholdActive: 0.984,
  focusThresholdIdle: 0.02,
  focusNonActiveScale: 0.78,
  focusNonActiveOpacity: 0.024,
  focusNonActivePushZ: -210,
  focusNonActiveYOffset: -14,
  focusNonActiveSideShiftDesktop: 72,
  focusNonActiveSideShiftMobile: 36,
  focusTargetDesktop: {
    x: 44,
    y: 0,
    z: 126,
    rotXDeg: 0,
    rotYDeg: -0.12,
    rotZDeg: 0,
    scale: 1.34,
    opacity: 1
  },
  focusTargetMobile: {
    x: 0,
    y: 4,
    z: 108,
    rotXDeg: 0,
    rotYDeg: -0.1,
    rotZDeg: 0,
    scale: 1.24,
    opacity: 1
  },

  selectionLiftScale: 0.02,
  selectionLiftZ: 12,
  selectionLiftOpacity: 0.06,

  indexModeOpacity: 0.006
};

function toRadians(value) {
  return (Number(value) || 0) * (Math.PI / 180);
}

function median(values) {
  if (!Array.isArray(values) || !values.length) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length * 0.5);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) * 0.5;
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
    this.focusState = 'idle';
    this.focusBlend = 0;
    this.focusIndex = -1;
    this.selectionLiftIndex = -1;
    this.selectionLiftDurationMs = 0;
    this.selectionLiftRemainingMs = 0;

    this.visibleTargets = [];
    this.hoveredItem = null;
    this.inertialVelocity = 0;
    this.scrollJerk = 0;
    this.lights = [];

    this.layoutDebugState = {
      activeIndex: 0,
      visibleCount: 0,
      activeCenterPx: 0,
      visibleRects: [],
      minGapPx: Infinity,
      maxGapPx: 0,
      activeNeighborGapPx: Infinity,
      activeYawDeg: 0,
      activeWidthPx: 0,
      maxVisibleWidthPx: 0,
      frontToActiveWidthRatio: 1,
      adjacentGapPx: Infinity,
      focusYawDeg: 0,
      inertialVelocity: 0,
      scrollJerk: 0,
      maxNonActiveOpacity: 0,
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
      visibleRange: this.isMobile ? SCENE_TUNING.laneMobile.visibleRange : SCENE_TUNING.laneDesktop.visibleRange
    };
  }

  setupLighting() {
    if (this.lights.length) return;

    const ambient = new THREE.AmbientLight(0x9b98d6, 0.34);
    const key = new THREE.DirectionalLight(0xffffff, 0.36);
    key.position.set(-340, 220, 620);

    const rim = new THREE.DirectionalLight(0xcac6ff, 0.28);
    rim.position.set(520, 40, 520);

    const fill = new THREE.DirectionalLight(0x6d6b92, 0.14);
    fill.position.set(80, -220, 440);

    this.lights = [ambient, key, rim, fill];
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
    if (this.mode !== 'overview') {
      this.clearSelectionLift();
      this.exitFocus({ immediate: true });
    }
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
      focused: this.isFocused(),
      activeIndex: this.activeIndex,
      focusIndex: this.focusIndex,
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
    if (this.isFocused()) {
      this.focusIndex = bounded;
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
    this.layout.visibleRange = this.isMobile ? SCENE_TUNING.laneMobile.visibleRange : SCENE_TUNING.laneDesktop.visibleRange;
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
    return this.mode === 'overview' && !this.isFocused() ? this.visibleTargets : [];
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

  clearSelectionLift() {
    this.selectionLiftIndex = -1;
    this.selectionLiftDurationMs = 0;
    this.selectionLiftRemainingMs = 0;
  }

  setSelectionLift(index, durationMs = 380) {
    if (!Number.isFinite(index)) {
      this.clearSelectionLift();
      return;
    }

    const bounded = clamp(index, 0, this.items.length - 1);
    this.selectionLiftIndex = bounded;
    this.selectionLiftDurationMs = Math.max(80, Number(durationMs) || 380);
    this.selectionLiftRemainingMs = this.selectionLiftDurationMs;
  }

  applyHoverHit(hit) {
    if (this.mode !== 'overview' || this.isFocused() || !hit || !hit.item || this.isMobile) {
      this.clearHover();
      return;
    }

    if (this.hoveredItem && this.hoveredItem !== hit.item) {
      this.hoveredItem.setHoverState(false);
    }

    hit.item.setHoverState(true, hit.uv);
    this.hoveredItem = hit.item;
  }

  enterFocus(index = this.activeIndex) {
    if (!this.items.length) return;
    this.clearSelectionLift();
    const bounded = clamp(index, 0, this.items.length - 1);
    this.focusIndex = bounded;
    this.targetProgress = bounded;
    if (this.reducedMotion) {
      this.progress = bounded;
      this.focusBlend = 1;
      this.focusState = 'active';
      return;
    }

    this.focusState = 'entering';
  }

  exitFocus({ immediate = false } = {}) {
    if (this.focusState === 'idle' && this.focusBlend <= 0.001) return;
    if (immediate || this.reducedMotion) {
      this.focusState = 'idle';
      this.focusBlend = 0;
      this.focusIndex = -1;
      return;
    }
    this.focusState = 'exiting';
  }

  isFocused() {
    return this.focusState === 'entering' || this.focusState === 'active';
  }

  getLaneBasis() {
    return this.isMobile ? SCENE_TUNING.laneMobile : SCENE_TUNING.laneDesktop;
  }

  getFocusTarget() {
    return this.isMobile ? SCENE_TUNING.focusTargetMobile : SCENE_TUNING.focusTargetDesktop;
  }

  updateFocusState(dtMs) {
    if (this.focusState === 'idle' && this.focusBlend <= 0.001) {
      this.focusBlend = 0;
      return;
    }

    if (this.focusState === 'active') {
      this.focusBlend = 1;
      return;
    }

    const dtScale = clamp((Number(dtMs) || 16.67) / 16.67, 0.6, 2.6);

    if (this.focusState === 'entering') {
      const mix = clamp(SCENE_TUNING.focusEnterMix * dtScale, 0, 1);
      this.focusBlend = lerp(this.focusBlend, 1, mix);
      if (this.focusBlend >= SCENE_TUNING.focusThresholdActive) {
        this.focusBlend = 1;
        this.focusState = 'active';
      }
      return;
    }

    if (this.focusState === 'exiting') {
      const mix = clamp(SCENE_TUNING.focusExitMix * dtScale, 0, 1);
      this.focusBlend = lerp(this.focusBlend, 0, mix);
      if (this.focusBlend <= SCENE_TUNING.focusThresholdIdle) {
        this.focusBlend = 0;
        this.focusState = 'idle';
        this.focusIndex = -1;
      }
      return;
    }

    this.focusState = 'idle';
    this.focusBlend = 0;
    this.focusIndex = -1;
  }

  projectStateRect(state) {
    const pxPerWorld = this.getPixelScaleAtDepth(state.z);
    const widthWorld = state.height * (state.item.aspect || 1.5) * state.scale;
    const widthPx = widthWorld * pxPerWorld;
    const heightPx = state.height * state.scale * pxPerWorld;

    if (
      !Number.isFinite(widthPx)
      || !Number.isFinite(heightPx)
      || widthPx <= 0
      || heightPx <= 0
    ) {
      return null;
    }

    const centerPx = this.layout.viewportWidth * 0.5 + state.x * pxPerWorld;
    const centerYPx = this.layout.viewportHeight * 0.5 - state.y * pxPerWorld;
    return {
      centerPx,
      centerYPx,
      leftPx: centerPx - widthPx * 0.5,
      rightPx: centerPx + widthPx * 0.5,
      topPx: centerYPx - heightPx * 0.5,
      bottomPx: centerYPx + heightPx * 0.5,
      widthPx,
      heightPx,
      pxPerWorld
    };
  }

  applyLaneSpacingCorrection(states, lane, clampBounds) {
    if (this.mode !== 'overview' || this.focusBlend > 0.001) return;

    const candidates = states
      .filter((state) => state.visible && state.opacity > 0.025)
      .sort((a, b) => a.index - b.index);

    if (candidates.length < 2) return;

    for (let pass = 0; pass < SCENE_TUNING.spacingCorrectionPasses; pass += 1) {
      for (const state of candidates) {
        state.projectedRect = this.projectStateRect(state);
      }

      for (let i = 1; i < candidates.length; i += 1) {
        const prev = candidates[i - 1];
        const curr = candidates[i];
        const prevRect = prev.projectedRect;
        const currRect = curr.projectedRect;
        if (!prevRect || !currRect) continue;

        const gap = currRect.leftPx - prevRect.rightPx;
        const targetGap = clamp(gap, SCENE_TUNING.overlapTargetMinPx, SCENE_TUNING.overlapTargetMaxPx);
        const gapDelta = targetGap - gap;
        if (Math.abs(gapDelta) <= 0.5) continue;

        const worldShift = gapDelta / Math.max(currRect.pxPerWorld, 1e-3);
        curr.x = clamp(curr.x + worldShift, clampBounds.xMin, clampBounds.xMax);
        const yShift = worldShift * (lane.yStep / Math.max(Math.abs(lane.xStep), 1e-3)) * SCENE_TUNING.spacingCorrectionYMix;
        curr.y = clamp(curr.y + yShift, clampBounds.yMin, clampBounds.yMax);
      }
    }
  }

  recenterLane(states, activeIndex, clampBounds) {
    if (this.mode !== 'overview' || this.focusBlend > 0.001) return;

    const activeState = states.find((state) => state.index === activeIndex && state.visible);
    if (!activeState) return;

    const projected = this.projectStateRect(activeState);
    if (!projected) return;

    const targetRatio = this.getOverviewCenterRatio();
    const targetCenterPx = this.layout.viewportWidth * targetRatio;
    const deltaPx = targetCenterPx - projected.centerPx;
    if (Math.abs(deltaPx) <= 1) return;

    const worldShift = deltaPx / Math.max(projected.pxPerWorld, 1e-3);
    for (const state of states) {
      state.x = clamp(state.x + worldShift, clampBounds.xMin, clampBounds.xMax);
    }
  }

  getOverviewCenterRatio() {
    if (this.focusBlend > 0.001 || this.mode !== 'overview' || this.items.length <= 1) {
      return this.isMobile
        ? SCENE_TUNING.activeCenterRatioMobile
        : SCENE_TUNING.activeCenterRatioDesktop;
    }

    const rawProgress = clamp(this.progress / Math.max(this.items.length - 1, 1), 0, 1);
    const easedProgress = rawProgress * rawProgress * (3 - (2 * rawProgress));

    if (this.isMobile) {
      return lerp(
        SCENE_TUNING.overviewCenterStartMobile,
        SCENE_TUNING.overviewCenterEndMobile,
        easedProgress
      );
    }

    return lerp(
      SCENE_TUNING.overviewCenterStartDesktop,
      SCENE_TUNING.overviewCenterEndDesktop,
      easedProgress
    );
  }

  updateLayoutDebugState(debugRects, activeIndex, activeYawDeg, focusYawDeg = 0) {
    if (!debugRects.length) {
      this.layoutDebugState = {
        activeIndex,
        visibleCount: 0,
        activeCenterPx: this.layout.viewportWidth * 0.5,
        visibleRects: [],
        minGapPx: Infinity,
        maxGapPx: 0,
        activeNeighborGapPx: Infinity,
        activeYawDeg,
        activeWidthPx: 0,
        maxVisibleWidthPx: 0,
        frontToActiveWidthRatio: 1,
        adjacentGapPx: Infinity,
        focusYawDeg,
        inertialVelocity: this.inertialVelocity,
        scrollJerk: this.scrollJerk,
        maxNonActiveOpacity: 0,
        focusSafeZoneBreach: false,
        nearestFocusNeighborGapPx: Infinity,
        focus: {
          enabled: this.isFocused(),
          index: this.focusIndex,
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
    const gapSamples = [];

    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const gap = curr.leftPx - prev.rightPx;
      minGapPx = Math.min(minGapPx, gap);
      maxGapPx = Math.max(maxGapPx, gap);
      gapSamples.push(gap);

      if (prev.index === activeIndex || curr.index === activeIndex) {
        activeNeighborGapPx = Math.min(activeNeighborGapPx, gap);
      }
    }

    const activeRect = sorted.find((rect) => rect.index === activeIndex) || sorted[0];
    const focusRect = sorted.find((rect) => rect.index === this.focusIndex) || null;
    const maxNonActiveOpacity = sorted.reduce((maxOpacity, rect) => {
      if (rect.index === this.focusIndex) return maxOpacity;
      return Math.max(maxOpacity, Number(rect.opacity) || 0);
    }, 0);

    let nearestFocusNeighborGapPx = Infinity;
    let nearestFocusNeighborOpacity = 0;
    if (focusRect) {
      for (const rect of sorted) {
        if (rect.index === focusRect.index) continue;
        const gap = rect.leftPx > focusRect.rightPx
          ? rect.leftPx - focusRect.rightPx
          : focusRect.leftPx - rect.rightPx;
        if (gap < nearestFocusNeighborGapPx) {
          nearestFocusNeighborGapPx = gap;
          nearestFocusNeighborOpacity = rect.opacity;
        }
      }
    }

    const safeTopPx = this.layout.viewportHeight * 0.16;
    const safeBottomPx = this.layout.viewportHeight * 0.84;
    const focusTopPx = focusRect?.topPx ?? 0;
    const focusBottomPx = focusRect?.bottomPx ?? 0;
    const safeTopBreached = Boolean(focusRect) && focusTopPx < safeTopPx;
    const safeBottomBreached = Boolean(focusRect) && focusBottomPx > safeBottomPx;
    const activeWidthPx = activeRect?.widthPx ?? 0;
    const maxVisibleWidthPx = sorted.reduce((maxWidth, rect) => Math.max(maxWidth, rect.widthPx || 0), 0);
    const frontToActiveWidthRatio = activeWidthPx > 0
      ? maxVisibleWidthPx / activeWidthPx
      : 1;
    const adjacentGapPx = median(gapSamples);

    this.layoutDebugState = {
      activeIndex,
      visibleCount: sorted.length,
      activeCenterPx: activeRect?.centerPx ?? this.layout.viewportWidth * 0.5,
      visibleRects: sorted,
      minGapPx,
      maxGapPx: Number.isFinite(maxGapPx) ? maxGapPx : 0,
      activeNeighborGapPx,
      activeYawDeg,
      activeWidthPx,
      maxVisibleWidthPx,
      frontToActiveWidthRatio,
      adjacentGapPx,
      focusYawDeg,
      inertialVelocity: this.inertialVelocity,
      scrollJerk: this.scrollJerk,
      maxNonActiveOpacity,
      focusSafeZoneBreach: safeTopBreached || safeBottomBreached,
      nearestFocusNeighborGapPx,
      focus: {
        enabled: this.isFocused(),
        index: this.focusIndex,
        safeTopPx,
        safeBottomPx,
        rectTopPx: focusTopPx,
        rectBottomPx: focusBottomPx,
        safeTopBreached,
        safeBottomBreached,
        nearestGapPx: nearestFocusNeighborGapPx,
        nearestOpacity: nearestFocusNeighborOpacity
      }
    };
  }

  update(time, dtMs) {
    const S = SCENE_TUNING;
    const lane = this.getLaneBasis();
    const focusTarget = this.getFocusTarget();
    const clampBounds = {
      xMin: lane.originX - (this.isMobile ? S.positionClampXMobile : S.positionClampXDesktop),
      xMax: lane.originX + (this.isMobile ? S.positionClampXMobile : S.positionClampXDesktop),
      yMin: lane.originY - (this.isMobile ? S.positionClampYMobile : S.positionClampYDesktop),
      yMax: lane.originY + (this.isMobile ? S.positionClampYMobile : S.positionClampYDesktop)
    };

    const easing = this.reducedMotion ? 1 : clamp(dtMs / S.easingDivisor, S.easingMin, S.easingMax);
    if (this.focusState === 'active' && this.focusIndex >= 0) {
      this.targetProgress = this.focusIndex;
      this.progress = this.focusIndex;
    }
    this.progress = lerp(this.progress, this.targetProgress, easing);
    this.updateFocusState(dtMs);
    if (this.selectionLiftRemainingMs > 0) {
      this.selectionLiftRemainingMs = Math.max(0, this.selectionLiftRemainingMs - dtMs);
      if (this.selectionLiftRemainingMs <= 0) {
        this.clearSelectionLift();
      }
    }

    this.visibleTargets.length = 0;

    let nextActiveIndex = this.activeIndex;
    let closestDelta = Infinity;
    const itemStates = [];
    let activeYawDeg = 0;
    let focusYawDeg = 0;

    for (let i = 0; i < this.items.length; i += 1) {
      const item = this.items[i];

      const delta = i - this.progress;
      const absDelta = Math.abs(delta);
      if (absDelta < closestDelta) {
        closestDelta = absDelta;
        nextActiveIndex = i;
      }

      const baseHeight = this.getBaseHeroHeightForAspect(item.aspect || 1.5);
      const depthBlend = clamp(1 - absDelta / Math.max(lane.visibleRange, 0.0001), 0, 1);
      const scaleBlend = Math.pow(depthBlend, lane.scaleCurve);
      const opacityBlend = Math.pow(depthBlend, lane.opacityCurve);
      const spreadDelta = delta === 0 ? 0 : Math.sign(delta) * Math.pow(absDelta, 1.12);
      const depthDelta = delta === 0 ? 0 : Math.sign(delta) * Math.pow(absDelta, 0.84);
      const fanDelta = absDelta <= 0.8
        ? 0
        : Math.pow(absDelta - 0.8, 1.22);
      const fanDirection = delta === 0 ? 0 : Math.sign(delta);
      const fanSpreadX = this.isMobile ? S.fanSpreadXMobile : S.fanSpreadXDesktop;
      const fanSpreadY = this.isMobile ? S.fanSpreadYMobile : S.fanSpreadYDesktop;

      let x = clamp(
        lane.originX + spreadDelta * lane.xStep + fanDirection * fanDelta * fanSpreadX,
        clampBounds.xMin,
        clampBounds.xMax
      );
      let y = clamp(
        lane.originY + spreadDelta * lane.yStep + fanDirection * fanDelta * fanSpreadY,
        clampBounds.yMin,
        clampBounds.yMax
      );
      let z = clamp(lane.originZ + depthDelta * lane.zStep, S.positionClampZBack, S.positionClampZFront);

      let rotXDeg = 0;
      let rotYDeg = lane.baseYawDeg + spreadDelta * lane.yawDeltaDeg;
      let rotZDeg = i % 2 === 0 ? -lane.rollAltDeg : lane.rollAltDeg;

      let scale = lerp(lane.scaleMin, S.activeScaleMax, scaleBlend);
      let opacity = lerp(lane.opacityMin, S.activeOpacityMax, opacityBlend);
      let visible = absDelta <= lane.visibleRange;

      if (i === this.selectionLiftIndex && this.selectionLiftDurationMs > 0 && this.focusBlend <= 0.001) {
        const liftBlend = Math.pow(
          clamp(this.selectionLiftRemainingMs / Math.max(this.selectionLiftDurationMs, 1), 0, 1),
          0.7
        );
        scale = clamp(scale + S.selectionLiftScale * liftBlend, lane.scaleMin, S.activeScaleMax + 0.04);
        z = clamp(z + S.selectionLiftZ * liftBlend, S.positionClampZBack, S.positionClampZFront + 32);
        opacity = clamp(opacity + S.selectionLiftOpacity * liftBlend, lane.opacityMin, 1);
      }

      const isFocusItem = this.focusIndex === i;
      if (this.focusBlend > 0 && this.focusIndex >= 0) {
        if (isFocusItem) {
          x = lerp(x, focusTarget.x, this.focusBlend);
          y = lerp(y, focusTarget.y, this.focusBlend);
          z = lerp(z, focusTarget.z, this.focusBlend);
          rotXDeg = lerp(rotXDeg, focusTarget.rotXDeg, this.focusBlend);
          rotYDeg = lerp(rotYDeg, focusTarget.rotYDeg, this.focusBlend);
          rotZDeg = lerp(rotZDeg, focusTarget.rotZDeg, this.focusBlend);
          scale = lerp(scale, focusTarget.scale, this.focusBlend);
          opacity = lerp(opacity, focusTarget.opacity, this.focusBlend);
          visible = true;
        } else {
          const sideShift = this.isMobile ? S.focusNonActiveSideShiftMobile : S.focusNonActiveSideShiftDesktop;
          const direction = delta === 0 ? 1 : Math.sign(delta);
          x = lerp(x, x + direction * sideShift, this.focusBlend);
          y = lerp(y, y + S.focusNonActiveYOffset, this.focusBlend);
          z = lerp(z, z + S.focusNonActivePushZ, this.focusBlend);
          rotYDeg = lerp(rotYDeg, rotYDeg + direction * 0.8, this.focusBlend);
          scale = lerp(scale, scale * S.focusNonActiveScale, this.focusBlend);
          opacity = lerp(opacity, S.focusNonActiveOpacity, this.focusBlend);
          visible = opacity > 0.009;
        }
      }

      const rotX = toRadians(rotXDeg);
      const rotY = toRadians(rotYDeg);
      const rotZ = toRadians(rotZDeg);

      if (this.mode === 'index') {
        opacity = Math.min(opacity, S.indexModeOpacity);
      }

      itemStates.push({
        index: i,
        item,
        delta,
        absDelta,
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
      });

      if (i === nextActiveIndex) {
        activeYawDeg = rotYDeg;
      }
      if (i === this.focusIndex) {
        focusYawDeg = rotYDeg;
      }
    }

    this.applyLaneSpacingCorrection(itemStates, lane, clampBounds);
    this.recenterLane(itemStates, nextActiveIndex, clampBounds);

    const debugRects = [];
    for (const state of itemStates) {
      const transform = {
        x: state.x,
        y: state.y,
        z: state.z,
        rotX: state.rotX,
        rotY: state.rotY,
        rotZ: state.rotZ,
        height: state.height,
        scale: state.scale,
        opacity: state.opacity,
        visible: state.visible,
        focused: state.index === this.focusIndex && this.focusBlend > 0.001
      };

      state.item.setTransform(transform);

      const phase = clamp(1 - state.absDelta / Math.max(lane.visibleRange, 0.0001), 0, 1);
      state.item.setDepthProfile({ depthPhase: phase });
      state.item.update(time);

      if (state.visible && state.opacity > 0.032) {
        state.item.loadHighResTexture();
        if (this.mode === 'overview') {
          this.visibleTargets.push(state.item.getRaycastTarget());
        }

        const projected = this.projectStateRect(state);
        if (!projected) continue;
        debugRects.push({
          index: state.index,
          centerPx: projected.centerPx,
          centerYPx: projected.centerYPx,
          yawDeg: THREE.MathUtils.radToDeg(state.rotY),
          leftPx: projected.leftPx,
          rightPx: projected.rightPx,
          topPx: projected.topPx,
          bottomPx: projected.bottomPx,
          widthPx: projected.widthPx,
          heightPx: projected.heightPx,
          opacity: state.opacity
        });
      }
    }

    if (this.focusState === 'active' && this.focusIndex >= 0) {
      nextActiveIndex = this.focusIndex;
    }

    this.updateLayoutDebugState(debugRects, nextActiveIndex, activeYawDeg, focusYawDeg);

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
