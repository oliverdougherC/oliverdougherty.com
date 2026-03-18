import {
  Application,
  BlurFilter,
  ColorMatrixFilter,
  Container,
  Graphics,
  NoiseFilter,
  Sprite
} from 'pixi.js';
import { ENEMY_ARCHETYPES } from '../data/enemies';
import { GameWorld } from '../core/world';
import { createVisualTheme } from './visualTheme';
import { PainterlyBiomeComposer } from './painterlyBiomeComposer';
import { LightingPipeline } from './lightingPipeline';
import { createEnemySprite } from './enemySpriteFactory';
import { bakeTexturePack, type BakedTexturePack } from './textureBaker';
import { ReadabilityGovernor } from './readabilityGovernor';
import type {
  EdgeAntialiasingMode,
  LightingRuntimeSettings,
  EnemyRole,
  IRenderAdapter,
  ReadabilityGovernorState,
  QualityTier,
  RenderBudgetFlags,
  RenderBudgetTier,
  RenderPassMetrics,
  RenderPerformanceSnapshot,
  RendererKind,
  RendererPolicy,
  RendererPreference,
  TextureDetail,
  ViewportMetrics,
  VisualRuntimeSettings,
  VisualThemeTokens
} from '../types';

type RenderNode = Graphics | Sprite;

function createCircleGraphic(radius: number, fill: number, stroke: number, strokeWidth = 2): Graphics {
  const graphic = new Graphics();
  graphic.circle(0, 0, radius);
  graphic.fill(fill);
  if (strokeWidth > 0) {
    graphic.stroke({ width: strokeWidth, color: stroke });
  }
  return graphic;
}

function createXpGraphic(fill: number, stroke: number): Graphics {
  const graphic = new Graphics();
  graphic.circle(0, 0, 8.8);
  graphic.fill({ color: fill, alpha: 0.34 });
  graphic.circle(0, 0, 6.2);
  graphic.fill({ color: stroke, alpha: 0.2 });
  graphic.poly([
    { x: 0, y: -7.1 },
    { x: 7.1, y: 0 },
    { x: 0, y: 7.1 },
    { x: -7.1, y: 0 }
  ]);
  graphic.fill({ color: fill, alpha: 1 });
  graphic.stroke({ width: 1.3, color: stroke, alpha: 0.96 });
  graphic.poly([
    { x: 0, y: -3.3 },
    { x: 3.3, y: 0 },
    { x: 0, y: 3.3 },
    { x: -3.3, y: 0 }
  ]);
  graphic.fill({ color: stroke, alpha: 0.88 });
  graphic.circle(0, 0, 1.7);
  graphic.fill({ color: fill, alpha: 0.76 });
  return graphic;
}

function createHazardGraphic(radius: number, theme: VisualThemeTokens): Graphics {
  const graphic = new Graphics();
  graphic.circle(0, 0, radius);
  graphic.fill({ color: theme.hazards.fill, alpha: 0.28 });
  graphic.circle(0, 0, radius * 0.56);
  graphic.fill({ color: theme.hazards.inner, alpha: 0.45 });
  graphic.circle(0, 0, radius * 0.98);
  graphic.stroke({ width: 1.8, color: theme.hazards.stroke, alpha: 0.78 });
  graphic.circle(0, 0, radius * 0.74);
  graphic.stroke({ width: 1.2, color: theme.hazards.stroke, alpha: 0.42 });
  for (let i = 0; i < 8; i += 1) {
    const angle = (Math.PI * 2 * i) / 8;
    const inner = radius * 0.28;
    const outer = radius * 0.92;
    graphic.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    graphic.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    graphic.stroke({ width: 0.9, color: theme.hazards.stroke, alpha: 0.24 });
  }
  const runeCount = 6;
  for (let i = 0; i < runeCount; i += 1) {
    const angle = (Math.PI * 2 * i) / runeCount;
    const px = Math.cos(angle) * radius * 0.58;
    const py = Math.sin(angle) * radius * 0.58;
    graphic.poly([
      { x: px, y: py - radius * 0.06 },
      { x: px + radius * 0.06, y: py },
      { x: px, y: py + radius * 0.06 },
      { x: px - radius * 0.06, y: py }
    ]);
    graphic.fill({ color: theme.hazards.inner, alpha: 0.25 });
  }
  return graphic;
}

function createChestGraphic(theme: VisualThemeTokens): Graphics {
  const graphic = new Graphics();
  const radius = 19;
  graphic.roundRect(-radius, -radius * 0.68, radius * 2, radius * 1.42, 4);
  graphic.fill({ color: theme.pickups.chestFill, alpha: 1 });
  graphic.stroke({ width: 2.2, color: theme.pickups.chestStroke, alpha: 0.95 });
  graphic.rect(-radius * 0.28, -radius * 0.72, radius * 0.56, radius * 1.44);
  graphic.fill({ color: theme.pickups.chestStroke, alpha: 0.88 });
  graphic.poly([
    { x: 0, y: -radius * 1.06 },
    { x: radius * 0.22, y: -radius * 0.82 },
    { x: 0, y: -radius * 0.58 },
    { x: -radius * 0.22, y: -radius * 0.82 }
  ]);
  graphic.fill({ color: theme.pickups.chestStroke, alpha: 0.96 });
  graphic.circle(0, -radius * 0.36, 2.2);
  graphic.fill({ color: 0x1b2436, alpha: 0.95 });
  graphic.rect(-radius * 0.7, radius * 0.2, radius * 1.4, radius * 0.14);
  graphic.fill({ color: 0x2f2012, alpha: 0.62 });
  return graphic;
}

function drawCrystalProjectile(graphic: Graphics, radius: number, fill: number, stroke: number): void {
  const body = Math.max(4, radius * 1.6);
  const wing = Math.max(2.4, radius * 0.86);
  const tail = Math.max(4, radius * 1.8);
  graphic.poly([
    { x: body, y: 0 },
    { x: 0, y: wing },
    { x: -tail, y: 0 },
    { x: 0, y: -wing }
  ]);
  graphic.fill({ color: fill, alpha: 0.94 });
  graphic.stroke({ width: 1.2, color: stroke, alpha: 0.95 });
  graphic.rect(-tail * 0.98, -wing * 0.24, tail * 0.66, wing * 0.48);
  graphic.fill({ color: stroke, alpha: 0.5 });
  graphic.poly([
    { x: body * 0.32, y: 0 },
    { x: 0, y: wing * 0.42 },
    { x: -tail * 0.48, y: 0 },
    { x: 0, y: -wing * 0.42 }
  ]);
  graphic.stroke({ width: 0.9, color: stroke, alpha: 0.72 });
}

function drawHostileProjectile(graphic: Graphics, radius: number, fill: number, stroke: number): void {
  const body = Math.max(4.4, radius * 1.62);
  const wing = Math.max(3, radius * 1.02);
  const tail = Math.max(4.6, radius * 1.42);
  graphic.poly([
    { x: body, y: 0 },
    { x: -tail, y: wing },
    { x: -tail * 0.62, y: 0 },
    { x: -tail, y: -wing }
  ]);
  graphic.fill({ color: fill, alpha: 0.94 });
  graphic.stroke({ width: 1.3, color: stroke, alpha: 0.95 });
  graphic.circle(-tail * 0.44, 0, radius * 0.26);
  graphic.fill({ color: stroke, alpha: 0.7 });
  graphic.moveTo(-tail * 0.2, 0);
  graphic.lineTo(body * 0.66, 0);
  graphic.stroke({ width: 1, color: stroke, alpha: 0.62 });
}

function createEnemyGraphic(
  role: EnemyRole,
  radius: number,
  fill: number,
  stroke: number,
  isElite: boolean,
  crownColor: number,
  outlineStrength: number,
  texturePack: BakedTexturePack | null,
  textureDetail: TextureDetail
): RenderNode {
  return createEnemySprite({
    role,
    radius,
    fill,
    stroke,
    isElite,
    crownColor,
    outlineStrength,
    texturePack,
    textureDetail
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mixColor(base: number, overlay: number, t: number): number {
  const ratio = clamp(t, 0, 1);
  const br = (base >> 16) & 0xff;
  const bg = (base >> 8) & 0xff;
  const bb = base & 0xff;
  const or = (overlay >> 16) & 0xff;
  const og = (overlay >> 8) & 0xff;
  const ob = overlay & 0xff;
  const r = Math.round(br + (or - br) * ratio);
  const g = Math.round(bg + (og - bg) * ratio);
  const b = Math.round(bb + (ob - bb) * ratio);
  return (r << 16) | (g << 8) | b;
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(clamp(q, 0, 1) * (sorted.length - 1));
  return sorted[idx] ?? sorted[sorted.length - 1] ?? 0;
}

const EVENT_AURA_COLORS: Record<string, number> = {
  blood_monsoon: 0xffa370,
  iron_canopy: 0x89f3d7,
  void_howl: 0xe29bff
};

const BUDGET_FLAGS: Record<RenderBudgetTier, RenderBudgetFlags> = {
  ultra: {
    parallaxBackdrop: true,
    ambientMotes: true,
    secondaryGlows: true,
    trailFx: true,
    overlayNoise: true
  },
  high: {
    parallaxBackdrop: true,
    ambientMotes: true,
    secondaryGlows: true,
    trailFx: true,
    overlayNoise: false
  },
  medium: {
    parallaxBackdrop: true,
    ambientMotes: true,
    secondaryGlows: false,
    trailFx: false,
    overlayNoise: false
  },
  low: {
    parallaxBackdrop: true,
    ambientMotes: false,
    secondaryGlows: false,
    trailFx: false,
    overlayNoise: false
  },
  minimal: {
    parallaxBackdrop: false,
    ambientMotes: false,
    secondaryGlows: false,
    trailFx: false,
    overlayNoise: false
  }
};

export class PixiRenderAdapter implements IRenderAdapter<GameWorld> {
  private app: Application | null = null;
  private mountEl: HTMLElement | null = null;

  private backdropLayer = new Container();
  private shadowLayer = new Container();
  private worldLayer = new Container();
  private fxLayer = new Container();
  private combatLayer = new Container();
  private lightingLayer = new Container();
  private overlayLayer = new Container();

  private backdropGraphic: Graphics | null = null;
  private playerGraphic: RenderNode | null = null;
  private playerAuraGraphic: Graphics | null = null;
  private damageVignette: Graphics | null = null;
  private eventAuraGraphic: Graphics | null = null;
  private impactGlowGraphic: Graphics | null = null;
  private dashTelegraphGraphic: Graphics | null = null;
  private directionalIndicatorGraphic: Graphics | null = null;
  private lightFieldGraphic: Graphics | null = null;
  private shadowFieldGraphic: Graphics | null = null;
  private fogFieldGraphic: Graphics | null = null;

  private rendererKind: RendererKind = 'webgl';
  private rendererPolicy: RendererPolicy = 'auto';
  private safariSafeMode = true;
  private safariLikeBrowser = false;
  private quality: QualityTier = 'high';
  private reducedMotion = false;
  private motionScale = 1;
  private visualSettings: VisualRuntimeSettings = {
    visualPreset: 'bioluminescent',
    rendererPolicy: 'auto',
    safariSafeMode: true,
    sceneStyle: 'painterly_forest',
    combatReadabilityMode: 'auto',
    colorVisionMode: 'normal',
    motionScale: 1,
    uiScale: 1,
    screenShake: 1,
    hazardOpacity: 0.9,
    hitFlashStrength: 0.9,
    enemyOutlineStrength: 1,
    backgroundDensity: 0.72,
    atmosphereStrength: 0.42,
    showDamageNumbers: false,
    showDirectionalIndicators: true,
    lightingQuality: 'high',
    shadowQuality: 'soft',
    fogQuality: 'layered',
    bloomStrength: 0.4,
    gamma: 1,
    environmentContrast: 1,
    materialDetail: 'full',
    clarityPreset: 'balanced',
    textureDetail: 'ultra',
    edgeAntialiasing: 'fxaa',
    resolutionProfile: 'balanced',
    resolutionScale: 1,
    postFxSoftness: 0.15,
    desktopUltraLock: true
  };
  private lightingSettings: LightingRuntimeSettings = {
    lightingQuality: 'high',
    shadowQuality: 'soft',
    fogQuality: 'layered',
    bloomStrength: 0.4,
    gamma: 1,
    environmentContrast: 1,
    materialDetail: 'full',
    clarityPreset: 'balanced'
  };
  private texturePack: BakedTexturePack | null = null;
  private desktopUltraProfile = true;
  private currentResolution = 1;
  private theme: VisualThemeTokens = createVisualTheme('normal');
  private painterlyBiome = new PainterlyBiomeComposer();
  private lightingPipeline = new LightingPipeline();
  private readabilityGovernor = new ReadabilityGovernor();
  private readabilitySnapshot: ReadabilityGovernorState = {
    threatLevel: 0,
    activeSuppressionTier: 'none',
    appliedOverrides: {
      atmosphereMultiplier: 1,
      backgroundDensityMultiplier: 1,
      fogMultiplier: 1,
      nonEssentialGlowMultiplier: 1,
      ambientParticleMultiplier: 1
    }
  };

  private motes: Graphics[] = [];
  private webgpuNoiseFilter: NoiseFilter | null = null;
  private webgpuGradeFilter: ColorMatrixFilter | null = null;

  private enemyGraphics = new Map<number, RenderNode>();
  private enemyPrevHp = new Map<number, number>();
  private enemyHitPulse = new Map<number, number>();
  private projectileGraphics = new Map<number, RenderNode>();
  private enemyProjectileGraphics = new Map<number, RenderNode>();
  private hazardGraphics = new Map<number, RenderNode>();
  private chestGraphics = new Map<number, RenderNode>();
  private xpGraphics = new Map<number, RenderNode>();

  private budgetTier: RenderBudgetTier = 'ultra';
  private budgetFlags: RenderBudgetFlags = BUDGET_FLAGS.ultra;
  private lastTierChangeAt = 0;
  private lastBudgetEvalAt = 0;
  private lastBackdropDrawAt = 0;
  private lastBackdropCameraX = Number.NaN;
  private lastBackdropCameraY = Number.NaN;
  private lastBackdropEventId: string | null = null;
  private cameraVelocitySq = 0;
  private lastCameraX = Number.NaN;
  private lastCameraY = Number.NaN;

  private frameSamples: number[] = [];
  private frameUpdateMs = 0;
  private frameUpdateSteps = 0;
  private smoothedFrameMs = 0;
  private hudSyncMs = 0;
  private visibleEntities = 0;
  private culledEntities = 0;
  private renderPerf: RenderPerformanceSnapshot = {
    budgetTier: 'ultra',
    frameTimeMs: 0,
    smoothedFrameTimeMs: 0,
    updateMs: 0,
    updateSteps: 0,
    visibleEntities: 0,
    culledEntities: 0,
    drawCallsEstimate: 0,
    pixelCount: 0,
    targetResolution: 1,
    actualCanvasToCssRatio: 1,
    backdropChunkCount: 0,
    backdropCardsDrawn: 0,
    backdropDrawCommandsEstimate: 0,
    timings: {
      backdropMs: 0,
      entitiesMs: 0,
      overlaysMs: 0,
      hudSyncMs: 0,
      totalMs: 0
    },
    passes: {
      gbufferMs: 0,
      lightCullMs: 0,
      lightShadeMs: 0,
      fogMs: 0,
      compositeMs: 0
    },
    activeLights: 0,
    activeShadowCasters: 0,
    lightingSampleCount: 0,
    rolling: {
      p50FrameMs: 0,
      p95FrameMs: 0
    }
  };

  private isSafariLikeBrowser(): boolean {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent.toLowerCase();
    return ua.includes('safari') && !ua.includes('chrome') && !ua.includes('android');
  }

  private getDeviceCapabilityProfile(): { scalar: number; resolutionCap: number; ultraEligible: boolean } {
    if (typeof window === 'undefined') {
      return { scalar: 1, resolutionCap: 1.75, ultraEligible: true };
    }
    const nav = navigator as Navigator & { deviceMemory?: number };
    const cores = nav.hardwareConcurrency ?? 4;
    const memory = nav.deviceMemory ?? 4;
    const coarsePointer = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    const touchPoints = nav.maxTouchPoints ?? 0;
    const mobileLike = coarsePointer || touchPoints > 1;

    let scalar = 1;
    if (cores <= 4) scalar *= 0.84;
    else if (cores >= 8) scalar *= 1.06;
    if (memory <= 4) scalar *= 0.86;
    else if (memory >= 8) scalar *= 1.05;
    if (this.reducedMotion) scalar *= 0.92;
    if (this.safariSafeMode) scalar *= 0.9;

    const ultraEligible = !mobileLike && cores >= 8 && memory >= 8;
    return {
      scalar: clamp(scalar, 0.68, 1.25),
      resolutionCap: this.safariSafeMode ? (mobileLike ? 1.5 : 1.75) : mobileLike ? 2 : 2.5,
      ultraEligible
    };
  }

  private edgeAaScale(mode: EdgeAntialiasingMode): number {
    if (mode === 'supersample') return 1.18;
    return 1;
  }

  private computeTargetResolution(): number {
    if (typeof window === 'undefined') return 1;
    const dpr = window.devicePixelRatio || 1;
    const aaScale = this.edgeAaScale(this.visualSettings.edgeAntialiasing);
    const capability = this.getDeviceCapabilityProfile();
    const profileScalar =
      this.visualSettings.resolutionProfile === 'quality'
        ? 1.12
        : this.visualSettings.resolutionProfile === 'performance'
          ? 0.82
          : 1;
    const resolutionScale = clamp(this.visualSettings.resolutionScale, 0.7, 1.3);
    return clamp(dpr * resolutionScale * capability.scalar * profileScalar * aaScale, 1, capability.resolutionCap);
  }

  private syncRendererResolution(): void {
    if (!this.app || !this.mountEl) return;
    const target = this.computeTargetResolution();
    this.currentResolution = target;
    const renderer = this.app.renderer as unknown as {
      resolution?: number;
      resize: (w: number, h: number, resolution?: number) => void;
    };
    if (typeof renderer.resize === 'function') {
      renderer.resize(this.mountEl.clientWidth, this.mountEl.clientHeight, target);
    }
    if (typeof renderer.resolution === 'number') {
      renderer.resolution = target;
    }
  }

  async init(options: {
    mount: HTMLElement;
    requestedRenderer: RendererPreference;
    rendererPolicy: RendererPolicy;
    safariSafeMode: boolean;
    reducedMotion: boolean;
  }): Promise<RendererKind> {
    this.mountEl = options.mount;
    this.mountEl.innerHTML = '';
    this.reducedMotion = options.reducedMotion;
    this.rendererPolicy = options.rendererPolicy;
    this.safariSafeMode = options.safariSafeMode;
    this.safariLikeBrowser = this.isSafariLikeBrowser();
    this.desktopUltraProfile = this.visualSettings.desktopUltraLock && this.getDeviceCapabilityProfile().ultraEligible;
    this.readabilityGovernor.reset();

    const requested = options.requestedRenderer;
    const effectivePolicy =
      this.safariSafeMode && this.safariLikeBrowser && requested === 'auto' ? 'prefer_webgl' : this.rendererPolicy;
    const initOrder: RendererKind[] = [];
    if (requested === 'webgpu') {
      initOrder.push('webgpu', 'webgl');
    } else if (requested === 'webgl') {
      initOrder.push('webgl', 'webgpu');
    } else if (effectivePolicy === 'prefer_webgl') {
      initOrder.push('webgl', 'webgpu');
    } else {
      initOrder.push('webgpu', 'webgl');
    }

    for (const candidate of initOrder) {
      const ok = await this.tryInitRenderer(candidate, options.mount, options.reducedMotion);
      if (!ok) continue;
      this.rendererKind = candidate;
      return this.rendererKind;
    }

    throw new Error('Unable to initialize either WebGPU or WebGL renderer.');
  }

  private async tryInitRenderer(
    preference: RendererKind,
    mount: HTMLElement,
    reducedMotion: boolean
  ): Promise<boolean> {
    try {
      const resolution = this.computeTargetResolution();
      this.reducedMotion = reducedMotion;
      this.currentResolution = resolution;
      this.app = new Application();
      await this.app.init({
        preference,
        resizeTo: mount,
        antialias: this.visualSettings.edgeAntialiasing !== 'off',
        autoDensity: true,
        resolution,
        backgroundAlpha: 0,
        powerPreference: 'high-performance'
      });

      mount.appendChild(this.app.canvas);
      this.app.canvas.style.imageRendering = 'auto';
      this.app.canvas.style.width = '100%';
      this.app.canvas.style.height = '100%';
      this.app.stage.addChild(
        this.backdropLayer,
        this.shadowLayer,
        this.worldLayer,
        this.combatLayer,
        this.lightingLayer,
        this.fxLayer,
        this.overlayLayer
      );

      this.backdropGraphic = new Graphics();
      this.backdropLayer.addChild(this.backdropGraphic);

      this.playerGraphic = this.createPlayerVisual();
      this.worldLayer.addChild(this.playerGraphic);

      this.playerAuraGraphic = new Graphics();
      this.combatLayer.addChild(this.playerAuraGraphic);

      this.dashTelegraphGraphic = new Graphics();
      this.combatLayer.addChild(this.dashTelegraphGraphic);

      this.eventAuraGraphic = new Graphics();
      this.overlayLayer.addChild(this.eventAuraGraphic);

      this.damageVignette = new Graphics();
      this.overlayLayer.addChild(this.damageVignette);

      this.impactGlowGraphic = new Graphics();
      this.overlayLayer.addChild(this.impactGlowGraphic);

      this.directionalIndicatorGraphic = new Graphics();
      this.overlayLayer.addChild(this.directionalIndicatorGraphic);

      this.shadowFieldGraphic = new Graphics();
      this.shadowFieldGraphic.blendMode = 'multiply';
      this.shadowLayer.addChild(this.shadowFieldGraphic);

      this.lightFieldGraphic = new Graphics();
      this.lightFieldGraphic.blendMode = 'add';
      this.lightingLayer.addChild(this.lightFieldGraphic);

      this.fogFieldGraphic = new Graphics();
      this.fogFieldGraphic.blendMode = 'normal';
      this.overlayLayer.addChild(this.fogFieldGraphic);

      this.createAmbientMotes(preference, reducedMotion);
      this.refreshTexturePack();
      this.configureRendererSpecificFx(preference);
      return true;
    } catch {
      this.destroy();
      return false;
    }
  }

  private configureRendererSpecificFx(preference: RendererKind): void {
    const softness = clamp(this.visualSettings.postFxSoftness, 0, 1);
    const cinematicLook =
      this.visualSettings.clarityPreset === 'cinematic' || this.visualSettings.resolutionProfile === 'quality';
    if (preference !== 'webgpu') {
      const blurStrength = cinematicLook && this.visualSettings.edgeAntialiasing !== 'off' ? 0.08 * softness : 0;
      this.fxLayer.filters = blurStrength > 0 ? [new BlurFilter({ strength: blurStrength, quality: 2 })] : [];
      this.overlayLayer.filters = [];
      this.worldLayer.filters = [];
      this.webgpuNoiseFilter = null;
      this.webgpuGradeFilter = null;
      return;
    }

    const fogBlurStrength = cinematicLook ? 0.42 * softness : 0;
    this.fxLayer.filters = fogBlurStrength > 0 ? [new BlurFilter({ strength: fogBlurStrength, quality: 2 })] : [];

    this.webgpuNoiseFilter = new NoiseFilter({
      noise:
        this.safariSafeMode && !cinematicLook
          ? 0
          : cinematicLook
            ? clamp(0.006 + softness * 0.008, 0.004, 0.014)
            : clamp(0.001 + softness * 0.004, 0, 0.004),
      seed: 0.23
    });
    this.overlayLayer.filters = [this.webgpuNoiseFilter];

    this.webgpuGradeFilter = new ColorMatrixFilter();
    this.webgpuGradeFilter.brightness(this.lightingSettings.gamma, false);
    this.webgpuGradeFilter.contrast(this.lightingSettings.environmentContrast - 1, false);
    this.webgpuGradeFilter.saturate(
      this.lightingSettings.clarityPreset === 'competitive' ? 0.08 : 0.12,
      false
    );
    this.webgpuGradeFilter.contrast(0.05, false);
    this.worldLayer.filters = [this.webgpuGradeFilter];
  }

  private effectiveTextureDetail(): TextureDetail {
    if (!this.desktopUltraProfile && this.visualSettings.textureDetail === 'ultra') {
      return 'high';
    }
    return this.visualSettings.textureDetail;
  }

  private createPlayerVisual(): RenderNode {
    if (this.texturePack && this.effectiveTextureDetail() !== 'low') {
      const sprite = new Sprite(this.texturePack.player.base);
      sprite.anchor.set(0.5);
      const sourceDiameter = Math.max(1, this.texturePack.player.base.width);
      const targetDiameter = 30;
      const scale = targetDiameter / sourceDiameter;
      sprite.scale.set(scale);
      return sprite;
    }
    return createCircleGraphic(15, this.theme.player.fill, this.theme.player.stroke, 3.8);
  }

  private destroyTexturePack(pack: BakedTexturePack | null): void {
    if (!pack) return;
    pack.player.base.destroy(true);
    pack.player.aura.destroy(true);
    for (const role of Object.keys(pack.enemies) as EnemyRole[]) {
      pack.enemies[role].base.destroy(true);
      pack.enemies[role].glow.destroy(true);
      pack.enemies[role].elite.destroy(true);
    }
    pack.projectiles.allied.destroy(true);
    pack.projectiles.enemy.destroy(true);
    pack.hazards.ring.destroy(true);
    pack.hazards.core.destroy(true);
    pack.pickups.chest.destroy(true);
    pack.pickups.xp.destroy(true);
  }

  private refreshTexturePack(): void {
    const detail = this.effectiveTextureDetail();
    const nextPack = bakeTexturePack(this.theme, detail);
    if (!nextPack) {
      this.destroyTexturePack(this.texturePack);
      this.texturePack = null;
      return;
    }
    if (this.texturePack?.key === nextPack.key) {
      this.destroyTexturePack(nextPack);
      return;
    }
    this.destroyTexturePack(this.texturePack);
    this.texturePack = nextPack;
  }

  private createAmbientMotes(preference: RendererKind, reducedMotion: boolean): void {
    this.motes = [];
    if (!this.app || reducedMotion) return;

    const moteCount = preference === 'webgpu' ? 120 : 56;
    for (let i = 0; i < moteCount; i += 1) {
      const mote = createCircleGraphic(
        1 + Math.random() * 2.4,
        this.theme.backdrop.fog,
        this.theme.backdrop.grade,
        0
      );
      mote.alpha = 0.04 + Math.random() * 0.08;
      mote.x = (Math.random() - 0.5) * 4200;
      mote.y = (Math.random() - 0.5) * 4200;
      this.motes.push(mote);
      this.fxLayer.addChild(mote);
    }
  }

  private resetGraphicsForThemeSwap(): void {
    if (this.playerGraphic) {
      this.playerGraphic.destroy();
      this.playerGraphic = null;
    }
    this.refreshTexturePack();
    if (this.app) {
      this.playerGraphic = this.createPlayerVisual();
      this.worldLayer.addChild(this.playerGraphic);
    }

    for (const graphic of this.enemyGraphics.values()) graphic.destroy();
    for (const graphic of this.projectileGraphics.values()) graphic.destroy();
    for (const graphic of this.enemyProjectileGraphics.values()) graphic.destroy();
    for (const graphic of this.hazardGraphics.values()) graphic.destroy();
    for (const graphic of this.chestGraphics.values()) graphic.destroy();
    for (const graphic of this.xpGraphics.values()) graphic.destroy();

    this.enemyGraphics.clear();
    this.enemyPrevHp.clear();
    this.enemyHitPulse.clear();
    this.projectileGraphics.clear();
    this.enemyProjectileGraphics.clear();
    this.hazardGraphics.clear();
    this.chestGraphics.clear();
    this.xpGraphics.clear();
  }

  setQuality(quality: QualityTier): void {
    this.quality = quality;
  }

  setMotionScale(scale: number): void {
    this.motionScale = clamp(scale, 0, 1);
  }

  setUpdateTelemetry(updateMs: number, updateSteps: number): void {
    this.frameUpdateMs = Math.max(0, updateMs);
    this.frameUpdateSteps = Math.max(0, Math.floor(updateSteps));
  }

  setVisualSettings(settings: VisualRuntimeSettings): void {
    const previousColorMode = this.visualSettings.colorVisionMode;
    const previousOutlineStrength = this.visualSettings.enemyOutlineStrength;
    const previousTextureDetail = this.visualSettings.textureDetail;
    const previousEdgeAA = this.visualSettings.edgeAntialiasing;
    const previousResolutionProfile = this.visualSettings.resolutionProfile;
    const previousResolutionScale = this.visualSettings.resolutionScale;
    const previousPostFxSoftness = this.visualSettings.postFxSoftness;
    const previousDesktopUltraLock = this.visualSettings.desktopUltraLock;
    const previousRendererPolicy = this.visualSettings.rendererPolicy;
    const previousSafariSafeMode = this.visualSettings.safariSafeMode;
    this.visualSettings = settings;
    this.rendererPolicy = settings.rendererPolicy;
    this.safariSafeMode = settings.safariSafeMode;
    this.desktopUltraProfile = settings.desktopUltraLock && this.getDeviceCapabilityProfile().ultraEligible;
    this.lightingSettings = {
      lightingQuality: settings.lightingQuality,
      shadowQuality: settings.shadowQuality,
      fogQuality: settings.fogQuality,
      bloomStrength: settings.bloomStrength,
      gamma: settings.gamma,
      environmentContrast: settings.environmentContrast,
      materialDetail: settings.materialDetail,
      clarityPreset: settings.clarityPreset
    };
    this.motionScale = clamp(settings.motionScale, 0, 1);
    this.theme = createVisualTheme(settings.colorVisionMode);
    this.lightingPipeline.setSettings(this.lightingSettings);
    if (
      previousColorMode !== settings.colorVisionMode ||
      Math.abs(previousOutlineStrength - settings.enemyOutlineStrength) > 0.001 ||
      previousTextureDetail !== settings.textureDetail
    ) {
      this.resetGraphicsForThemeSwap();
    }
    if (
      previousEdgeAA !== settings.edgeAntialiasing ||
      previousResolutionProfile !== settings.resolutionProfile ||
      Math.abs(previousResolutionScale - settings.resolutionScale) > 0.001 ||
      Math.abs(previousPostFxSoftness - settings.postFxSoftness) > 0.001 ||
      previousDesktopUltraLock !== settings.desktopUltraLock ||
      previousRendererPolicy !== settings.rendererPolicy ||
      previousSafariSafeMode !== settings.safariSafeMode
    ) {
      this.syncRendererResolution();
      this.configureRendererSpecificFx(this.rendererKind);
    }
    if (this.webgpuGradeFilter) {
      this.webgpuGradeFilter.reset();
      this.webgpuGradeFilter.brightness(this.lightingSettings.gamma, false);
      this.webgpuGradeFilter.contrast(this.lightingSettings.environmentContrast - 1, false);
      this.webgpuGradeFilter.saturate(this.lightingSettings.clarityPreset === 'competitive' ? 0.08 : 0.12, false);
      this.webgpuGradeFilter.contrast(0.05, false);
    }
  }

  setLightingSettings(settings: LightingRuntimeSettings): void {
    this.lightingSettings = settings;
    this.lightingPipeline.setSettings(settings);
    if (this.webgpuGradeFilter) {
      this.webgpuGradeFilter.reset();
      this.webgpuGradeFilter.brightness(settings.gamma, false);
      this.webgpuGradeFilter.contrast(settings.environmentContrast - 1, false);
      this.webgpuGradeFilter.saturate(settings.clarityPreset === 'competitive' ? 0.08 : 0.12, false);
      this.webgpuGradeFilter.contrast(0.05, false);
    }
  }

  async prewarmVisualAssets(): Promise<void> {
    // Prime nearby backdrop chunks so startup doesn't visibly stream cards in.
    this.painterlyBiome.prewarm(0, 0);
    return Promise.resolve();
  }

  getRenderPassMetrics(): RenderPassMetrics {
    return { ...this.renderPerf.passes };
  }

  setHudSyncTime(hudSyncMs: number): void {
    this.hudSyncMs = hudSyncMs;
  }

  getPerformanceSnapshot(): RenderPerformanceSnapshot {
    return {
      ...this.renderPerf,
      timings: { ...this.renderPerf.timings },
      passes: { ...this.renderPerf.passes },
      rolling: { ...this.renderPerf.rolling }
    };
  }

  getReadabilitySnapshot(): ReadabilityGovernorState {
    return {
      threatLevel: this.readabilitySnapshot.threatLevel,
      activeSuppressionTier: this.readabilitySnapshot.activeSuppressionTier,
      appliedOverrides: { ...this.readabilitySnapshot.appliedOverrides }
    };
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.app?.canvas ?? null;
  }

  getViewportMetrics(): ViewportMetrics {
    const canvas = this.app?.canvas ?? null;
    const cssWidth = Math.max(1, canvas?.clientWidth || this.mountEl?.clientWidth || this.app?.screen.width || 1280);
    const cssHeight = Math.max(1, canvas?.clientHeight || this.mountEl?.clientHeight || this.app?.screen.height || 720);
    return {
      cssWidth,
      cssHeight,
      halfDiagonal: Math.hypot(cssWidth * 0.5, cssHeight * 0.5)
    };
  }

  render(world: GameWorld, _alpha: number, frameTimeMs: number): void {
    if (!this.app || !this.playerGraphic) return;
    const renderStart = performance.now();
    const nowMs = renderStart;
    const canvas = this.app.canvas;
    const cssWidth = Math.max(1, canvas.clientWidth || this.app.screen.width);
    const actualCanvasToCssRatio = canvas.width / cssWidth;

    this.updateBudget(frameTimeMs);
    this.applyClarityGuard(actualCanvasToCssRatio);
    this.smoothedFrameMs = this.smoothedFrameMs * 0.88 + frameTimeMs * 0.12;
    this.frameSamples.push(frameTimeMs);
    if (this.frameSamples.length > 180) {
      this.frameSamples.shift();
    }
    const p95 = percentile(this.frameSamples, 0.95);
    this.readabilitySnapshot = this.readabilityGovernor.update({
      enemyCount: world.enemies.size,
      hazardCount: world.hazards.size,
      hostileProjectileCount: world.enemyProjectiles.size,
      p95FrameMs: p95,
      mode: this.visualSettings.combatReadabilityMode
    });
    this.lightingPipeline.setReadabilityMultiplier(this.readabilitySnapshot.appliedOverrides.fogMultiplier);

    const playerPos = world.getPlayerPosition();
    if (Number.isFinite(this.lastCameraX) && Number.isFinite(this.lastCameraY)) {
      const dx = playerPos.x - this.lastCameraX;
      const dy = playerPos.y - this.lastCameraY;
      this.cameraVelocitySq = dx * dx + dy * dy;
    } else {
      this.cameraVelocitySq = 0;
    }
    this.lastCameraX = playerPos.x;
    this.lastCameraY = playerPos.y;

    const baseCenterX = this.app.screen.width / 2;
    const baseCenterY = this.app.screen.height / 2;
    const shake = this.getShakeOffset(world, frameTimeMs, nowMs);
    const centerX = baseCenterX + shake.x;
    const centerY = baseCenterY + shake.y;

    this.visibleEntities = 0;
    this.culledEntities = 0;
    this.lightingPipeline.clearDynamicData();
    this.collectLightingData(world, playerPos, frameTimeMs, nowMs);
    this.lightingPipeline.prepareSamplingGrid({
      width: this.app.screen.width,
      height: this.app.screen.height,
      cameraX: playerPos.x,
      cameraY: playerPos.y,
      centerX,
      centerY,
      budgetTier: this.budgetTier,
      safariSafeMode: this.safariSafeMode
    });

    const backdropStart = performance.now();
    this.drawBackdrop(world, playerPos, frameTimeMs, nowMs);
    const backdropMs = performance.now() - backdropStart;

    this.playerGraphic.position.set(centerX, centerY);

    const entitiesStart = performance.now();
    this.syncEnemyGraphics(world, playerPos, centerX, centerY);
    this.syncProjectileGraphics(world, playerPos, centerX, centerY, nowMs);
    this.syncEnemyProjectileGraphics(world, playerPos, centerX, centerY, nowMs);
    this.syncHazardGraphics(world, playerPos, centerX, centerY, frameTimeMs, nowMs);
    this.syncChestGraphics(world, playerPos, centerX, centerY, frameTimeMs, nowMs);
    this.syncXpGraphics(world, playerPos, centerX, centerY, frameTimeMs, nowMs);
    this.updateEnemyHitPulses(frameTimeMs);
    const entitiesMs = performance.now() - entitiesStart;

    const overlaysStart = performance.now();
    this.syncDashTelegraphs(world, playerPos, centerX, centerY, nowMs);
    this.syncDirectionalIndicators(world, playerPos, centerX, centerY);
    this.syncPlayerAura(world, centerX, centerY, frameTimeMs, nowMs);
    this.syncLighting(world, playerPos, centerX, centerY, frameTimeMs);
    this.syncScreenOverlay(world, frameTimeMs, nowMs);
    this.updateAmbientMotes(playerPos, frameTimeMs, nowMs);
    this.updateWebGpuFx(world, frameTimeMs, nowMs);
    const overlaysMs = performance.now() - overlaysStart;

    const totalMs = performance.now() - renderStart;
    const pixelCount = canvas.width * canvas.height;
    const backdropStats = this.painterlyBiome.getStats();
    const lightCounts = this.lightingPipeline.getCounts();
    this.renderPerf = {
      budgetTier: this.budgetTier,
      frameTimeMs,
      smoothedFrameTimeMs: this.smoothedFrameMs,
      updateMs: this.frameUpdateMs,
      updateSteps: this.frameUpdateSteps,
      visibleEntities: this.visibleEntities,
      culledEntities: this.culledEntities,
      drawCallsEstimate:
        this.visibleEntities +
        (this.budgetFlags.ambientMotes ? Math.ceil(this.motes.length * 0.5) : 0) +
        lightCounts.lights +
        10,
      pixelCount,
      targetResolution: this.currentResolution,
      actualCanvasToCssRatio,
      backdropChunkCount: backdropStats.chunkCount,
      backdropCardsDrawn: backdropStats.drawnCards,
      backdropDrawCommandsEstimate: backdropStats.drawCommandsEstimate,
      timings: {
        backdropMs,
        entitiesMs,
        overlaysMs,
        hudSyncMs: this.hudSyncMs,
        totalMs
      },
      passes: this.lightingPipeline.getMetrics(),
      activeLights: lightCounts.lights,
      activeShadowCasters: lightCounts.shadowCasters,
      lightingSampleCount: this.lightingPipeline.getSampleCount(),
      rolling: {
        p50FrameMs: percentile(this.frameSamples, 0.5),
        p95FrameMs: percentile(this.frameSamples, 0.95)
      }
    };
  }

  private applyClarityGuard(actualCanvasToCssRatio: number): void {
    const expectedMin = this.currentResolution * 0.95;
    const baseFlags = BUDGET_FLAGS[this.budgetTier];
    if (actualCanvasToCssRatio >= expectedMin) {
      this.budgetFlags = baseFlags;
      return;
    }
    this.budgetFlags = {
      ...baseFlags,
      parallaxBackdrop: false,
      secondaryGlows: false,
      trailFx: false,
      overlayNoise: false
    };
  }

  private updateBudget(frameTimeMs: number): void {
    const now = performance.now();
    if (now - this.lastBudgetEvalAt < 250) return;
    this.lastBudgetEvalAt = now;

    const p95 = percentile(this.frameSamples.length > 8 ? this.frameSamples : [frameTimeMs], 0.95);
    let target: RenderBudgetTier = 'ultra';
    if (p95 > 27) target = 'minimal';
    else if (p95 > 23) target = 'low';
    else if (p95 > 19) target = 'medium';
    else if (p95 > 16.8) target = 'high';

    if (this.quality === 'medium' && target === 'ultra') target = 'high';
    if (this.quality === 'low' && (target === 'ultra' || target === 'high')) target = 'medium';
    if (this.desktopUltraProfile && this.visualSettings.desktopUltraLock && this.quality === 'high' && target !== 'ultra') {
      target = 'high';
    }
    if (this.reducedMotion && (target === 'ultra' || target === 'high')) target = 'medium';

    if (target !== this.budgetTier && now - this.lastTierChangeAt >= 900) {
      this.budgetTier = target;
      this.budgetFlags = BUDGET_FLAGS[target];
      this.lastTierChangeAt = now;
    }
  }

  private drawBackdrop(world: GameWorld, camera: { x: number; y: number }, frameTimeMs: number, nowMs: number): void {
    if (!this.app || !this.backdropGraphic) return;
    const eventId = world.activeEventId;
    const dx = Number.isFinite(this.lastBackdropCameraX) ? camera.x - this.lastBackdropCameraX : Number.POSITIVE_INFINITY;
    const dy = Number.isFinite(this.lastBackdropCameraY) ? camera.y - this.lastBackdropCameraY : Number.POSITIVE_INFINITY;
    const stationary = dx * dx + dy * dy < 18;
    const stableCamera = this.cameraVelocitySq < 24;
    const refreshMs =
      this.budgetTier === 'ultra'
        ? 34
        : this.budgetTier === 'high'
          ? 46
          : this.budgetTier === 'medium'
            ? 66
            : this.budgetTier === 'low'
              ? 110
              : 150;
    if (
      this.lastBackdropEventId === eventId &&
      stationary &&
      stableCamera &&
      nowMs - this.lastBackdropDrawAt < refreshMs &&
      frameTimeMs < 28
    ) {
      return;
    }
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const eventColor = EVENT_AURA_COLORS[world.activeEventId ?? ''] ?? this.theme.backdrop.eventTint;
    if (!this.budgetFlags.parallaxBackdrop) {
      this.backdropGraphic.clear();
      this.backdropGraphic.rect(0, 0, w, h);
      this.backdropGraphic.fill({ color: 0x03070d, alpha: 1 });
      this.backdropGraphic.roundRect(-20, h * 0.08, w + 40, h * 0.22, 32);
      this.backdropGraphic.fill({ color: this.theme.backdrop.fog, alpha: 0.06 });
      this.backdropGraphic.roundRect(-20, h * 0.68, w + 40, h * 0.26, 30);
      this.backdropGraphic.fill({ color: this.theme.backdrop.vines, alpha: 0.05 });
      if (eventColor !== 0) {
        this.backdropGraphic.roundRect(-20, -10, w + 40, 78, 28);
        this.backdropGraphic.fill({ color: eventColor, alpha: 0.04 });
      }
      this.painterlyBiome.setStaticStats();
      this.lastBackdropDrawAt = nowMs;
      this.lastBackdropCameraX = camera.x;
      this.lastBackdropCameraY = camera.y;
      this.lastBackdropEventId = eventId;
      return;
    }
    const maxCards =
      this.budgetTier === 'low' ? 220 : this.budgetTier === 'medium' ? 380 : this.budgetTier === 'high' ? 620 : 860;
    const chunkBuildBudget =
      this.budgetTier === 'low' ? 2 : this.budgetTier === 'medium' ? 3 : this.budgetTier === 'high' ? 4 : 6;
    this.painterlyBiome.draw(this.backdropGraphic, {
      width: w,
      height: h,
      cameraX: camera.x,
      cameraY: camera.y,
      timeMs: nowMs,
      theme: this.theme,
      budgetTier: this.budgetTier,
      suppressionTier: this.readabilitySnapshot.activeSuppressionTier,
      reducedMotion: this.reducedMotion || frameTimeMs > 32,
      motionScale: this.motionScale,
      backgroundDensity: this.visualSettings.backgroundDensity * this.readabilitySnapshot.appliedOverrides.backgroundDensityMultiplier,
      atmosphereStrength: this.visualSettings.atmosphereStrength * this.readabilitySnapshot.appliedOverrides.atmosphereMultiplier,
      eventTint: eventColor,
      maxCards,
      chunkBuildBudget
    });
    this.lastBackdropDrawAt = nowMs;
    this.lastBackdropCameraX = camera.x;
    this.lastBackdropCameraY = camera.y;
    this.lastBackdropEventId = eventId;
  }

  private getShakeOffset(world: GameWorld, frameTimeMs: number, nowMs: number): { x: number; y: number } {
    if (this.reducedMotion || this.motionScale <= 0 || this.visualSettings.screenShake <= 0) {
      return { x: 0, y: 0 };
    }
    if (this.budgetTier === 'minimal' || this.budgetTier === 'low') {
      return { x: 0, y: 0 };
    }
    if (world.damageFlashTimer <= 0) return { x: 0, y: 0 };

    const intensity = Math.min(1, world.damageFlashTimer / 0.2) * 6 * this.motionScale * this.visualSettings.screenShake;
    const t = nowMs * (0.018 + frameTimeMs * 0.00001);
    return {
      x: Math.sin(t * 3.4) * intensity,
      y: Math.cos(t * 2.8) * intensity
    };
  }

  private collectLightingData(world: GameWorld, playerPos: { x: number; y: number }, frameTimeMs: number, _nowMs: number): void {
    const eventColor = EVENT_AURA_COLORS[world.activeEventId ?? ''] ?? this.theme.player.aura;
    const fxMultiplier = this.readabilitySnapshot.appliedOverrides.nonEssentialGlowMultiplier;
    this.lightingPipeline.addLight({
      id: world.playerId,
      x: playerPos.x,
      y: playerPos.y,
      radius: 104,
      color: this.theme.player.aura,
      intensity: 0.66 + (world.damageFlashTimer > 0 ? 0.18 : 0),
      falloff: 0.78,
      flicker: this.reducedMotion ? 0 : 0.08 * this.motionScale,
      castsShadow: false,
      layerMask: 0b111,
      priority: 3
    });

    let projected = 0;
    for (const projectileId of world.enemyProjectiles) {
      if (projected >= 12) break;
      const pos = world.positions.get(projectileId);
      if (!pos) continue;
      this.lightingPipeline.addLight({
        id: projectileId,
        x: pos.x,
        y: pos.y,
        radius: 56,
        color: this.theme.projectiles.enemy,
        intensity: 0.28,
        falloff: 0.68,
        flicker: this.reducedMotion ? 0 : 0.14,
        castsShadow: false,
        layerMask: 0b010,
        priority: 1.1
      });
      projected += 1;
    }

    let hazardCount = 0;
    for (const hazardId of world.hazards) {
      if (hazardCount >= 10) break;
      const pos = world.positions.get(hazardId);
      const radius = world.radii.get(hazardId) ?? 40;
      if (!pos) continue;
      this.lightingPipeline.addLight({
        id: hazardId,
        x: pos.x,
        y: pos.y,
        radius: Math.max(56, radius * 1.2),
        color: this.theme.hazards.inner,
        intensity: 0.25 * fxMultiplier,
        falloff: 0.78,
        flicker: this.reducedMotion ? 0 : 0.2,
        castsShadow: this.readabilitySnapshot.activeSuppressionTier !== 'hard',
        layerMask: 0b010,
        priority: 1.2
      });
      this.lightingPipeline.addShadowCaster({
        id: hazardId,
        shape: 'circle',
        x: pos.x,
        y: pos.y,
        radius: Math.max(12, radius * 0.4),
        height: 0.32,
        softness: 0.84
      });
      hazardCount += 1;
    }

    for (const chestId of world.chests) {
      const pos = world.positions.get(chestId);
      if (!pos) continue;
      this.lightingPipeline.addLight({
        id: chestId,
        x: pos.x,
        y: pos.y,
        radius: 88,
        color: this.theme.pickups.chestStroke,
        intensity: 0.34,
        falloff: 0.72,
        flicker: this.reducedMotion ? 0 : 0.12,
        castsShadow: true,
        layerMask: 0b010,
        priority: 1.8
      });
      this.lightingPipeline.addShadowCaster({
        id: chestId,
        shape: 'circle',
        x: pos.x,
        y: pos.y,
        radius: 18,
        height: 0.45,
        softness: 0.64
      });
    }

    let elitesAdded = 0;
    for (const enemyId of world.enemies) {
      const comp = world.enemyComponents.get(enemyId);
      const pos = world.positions.get(enemyId);
      const r = world.radii.get(enemyId) ?? 12;
      if (!comp || !pos) continue;
      const archetype = ENEMY_ARCHETYPES[comp.archetypeId];
      if (archetype?.isElite && elitesAdded < 10) {
        this.lightingPipeline.addLight({
          id: enemyId,
          x: pos.x,
          y: pos.y,
          radius: 78 + r * 1.2,
          color: eventColor,
          intensity: (0.26 + (comp.dashWindup > 0 ? 0.18 : 0)) * fxMultiplier,
          falloff: 0.74,
          flicker: this.reducedMotion ? 0 : 0.08,
          castsShadow: true,
          layerMask: 0b010,
          priority: 1.65
        });
        this.lightingPipeline.addShadowCaster({
          id: enemyId,
          shape: 'circle',
          x: pos.x,
          y: pos.y,
          radius: r * 0.92,
          height: 0.56,
          softness: 0.78
        });
        elitesAdded += 1;
      }
    }

    if (frameTimeMs > 31 && this.budgetTier !== 'minimal' && this.readabilitySnapshot.activeSuppressionTier === 'none') {
      this.lightingPipeline.addLight({
        x: playerPos.x,
        y: playerPos.y,
        radius: 140,
        color: this.theme.backdrop.fog,
        intensity: 0.04,
        falloff: 0.9,
        flicker: 0,
        castsShadow: false,
        layerMask: 0b001
      });
    }
  }

  private syncLighting(
    world: GameWorld,
    camera: { x: number; y: number },
    centerX: number,
    centerY: number,
    _frameTimeMs: number
  ): void {
    if (!this.app || !this.lightFieldGraphic || !this.shadowFieldGraphic || !this.fogFieldGraphic) return;
    this.lightingPipeline.render(this.lightFieldGraphic, this.shadowFieldGraphic, this.fogFieldGraphic, {
      width: this.app.screen.width,
      height: this.app.screen.height,
      cameraX: camera.x,
      cameraY: camera.y,
      centerX,
      centerY,
      worldTime: world.runTime * 1000,
      motionScale: this.motionScale,
      reducedMotion: this.reducedMotion || this.budgetTier === 'minimal',
      rendererKind: this.rendererKind,
      budgetTier: this.budgetTier,
      safariSafeMode: this.safariSafeMode,
      cameraVelocitySq: this.cameraVelocitySq,
      theme: this.theme
    });
  }

  private isVisible(x: number, y: number, radius: number): boolean {
    if (!this.app) return true;
    const padding = 140;
    return (
      x >= -padding - radius &&
      x <= this.app.screen.width + padding + radius &&
      y >= -padding - radius &&
      y <= this.app.screen.height + padding + radius
    );
  }

  private setNodeScale(node: RenderNode, targetDiameter: number, multiplier: number): void {
    if (node instanceof Sprite) {
      const baseScale = targetDiameter / Math.max(1, node.texture.width);
      node.scale.set(baseScale * multiplier);
      return;
    }
    node.scale.set(multiplier);
  }

  private syncEnemyGraphics(world: GameWorld, camera: { x: number; y: number }, centerX: number, centerY: number): void {
    for (const enemyId of world.enemies) {
      let graphic = this.enemyGraphics.get(enemyId);
      const pos = world.positions.get(enemyId);
      const enemyComp = world.enemyComponents.get(enemyId);
      const radius = world.radii.get(enemyId) ?? 12;
      const hp = world.health.get(enemyId)?.hp;
      if (!pos || !enemyComp) continue;

      const archetype = ENEMY_ARCHETYPES[enemyComp.archetypeId];
      const role = archetype?.role ?? 'swarmer';
      const isElite = Boolean(archetype?.isElite);
      const palette = this.theme.enemies[role];

      if (!graphic) {
        graphic = createEnemyGraphic(
          role,
          radius,
          palette.fill,
          isElite ? this.theme.elite.stroke : palette.stroke,
          isElite,
          this.theme.elite.crown,
          this.visualSettings.enemyOutlineStrength,
          this.texturePack,
          this.effectiveTextureDetail()
        );
        this.enemyGraphics.set(enemyId, graphic);
        this.worldLayer.addChild(graphic);
      }

      const sx = pos.x - camera.x + centerX;
      const sy = pos.y - camera.y + centerY;
      if (!this.isVisible(sx, sy, radius)) {
        graphic.visible = false;
        this.culledEntities += 1;
        continue;
      }

      const previousHp = this.enemyPrevHp.get(enemyId);
      if (previousHp !== undefined && hp !== undefined && hp < previousHp) {
        this.enemyHitPulse.set(enemyId, 0.14);
      }
      if (hp !== undefined) {
        this.enemyPrevHp.set(enemyId, hp);
      }

      const dx = pos.x - camera.x;
      const dy = pos.y - camera.y;
      const distSq = dx * dx + dy * dy;
      const far = distSq > 1150 * 1150;
      const closeThreat = distSq < 260 * 260;
      const hitPulse = far ? 0 : this.enemyHitPulse.get(enemyId) ?? 0;
      const windupPulse = far ? 0 : enemyComp.dashWindup > 0 ? (enemyComp.dashWindup / 0.6) * 0.2 : 0;
      const velocity = world.velocities.get(enemyId);
      const lightAmount = this.lightingPipeline.sampleIlluminance(pos.x, pos.y);
      const proximityBoost = closeThreat ? 0.1 : 0;
      if (graphic instanceof Sprite && this.texturePack && this.effectiveTextureDetail() !== 'low') {
        const textureSet = this.texturePack.enemies[role];
        if (isElite) {
          graphic.texture = textureSet.elite;
        } else if (closeThreat || hitPulse > 0.05 || enemyComp.dashWindup > 0) {
          graphic.texture = textureSet.glow;
        } else {
          graphic.texture = textureSet.base;
        }
      }

      graphic.visible = true;
      graphic.position.set(sx, sy);
      graphic.alpha = far ? 0.9 : Math.min(1, 0.9 + proximityBoost + hitPulse * 0.22 + lightAmount * 0.06);
      this.setNodeScale(
        graphic,
        radius * 2.2,
        1.06 + proximityBoost * 0.7 + hitPulse * 0.72 + windupPulse + (isElite && !far ? 0.08 : 0)
      );
      const litTint = mixColor(0xffffff, this.theme.player.aura, clamp((lightAmount - 0.32) * 0.45, 0, 0.42));
      const threatTint = closeThreat && !isElite ? mixColor(litTint, 0xfff0d2, 0.28) : litTint;
      graphic.tint = isElite ? mixColor(threatTint, this.theme.elite.crown, 0.2) : threatTint;
      if (velocity && (velocity.x !== 0 || velocity.y !== 0) && role !== 'tank' && role !== 'disruptor') {
        graphic.rotation = Math.atan2(velocity.y, velocity.x) + Math.PI / 2;
      }
      this.visibleEntities += 1;
    }

    for (const [enemyId, graphic] of this.enemyGraphics.entries()) {
      if (world.enemies.has(enemyId)) continue;
      graphic.destroy();
      this.enemyGraphics.delete(enemyId);
      this.enemyPrevHp.delete(enemyId);
      this.enemyHitPulse.delete(enemyId);
    }
  }

  private syncProjectileGraphics(
    world: GameWorld,
    camera: { x: number; y: number },
    centerX: number,
    centerY: number,
    nowMs: number
  ): void {
    for (const projectileId of world.projectiles) {
      let graphic = this.projectileGraphics.get(projectileId);
      const pos = world.positions.get(projectileId);
      const radius = world.radii.get(projectileId) ?? 5;
      const projectile = world.projectileComponents.get(projectileId);
      const velocity = world.velocities.get(projectileId);
      if (!pos || !projectile) continue;

      if (!graphic) {
        if (this.texturePack && this.effectiveTextureDetail() !== 'low') {
          graphic = new Sprite(this.texturePack.projectiles.allied);
          graphic.anchor.set(0.5);
          graphic.tint = projectile.colorHex || this.theme.projectiles.allied;
        } else {
          graphic = new Graphics();
          drawCrystalProjectile(
            graphic,
            radius,
            projectile.colorHex || this.theme.projectiles.allied,
            this.theme.projectiles.alliedStroke
          );
        }
        this.projectileGraphics.set(projectileId, graphic);
        this.combatLayer.addChild(graphic);
      }

      const sx = pos.x - camera.x + centerX;
      const sy = pos.y - camera.y + centerY;
      if (!this.isVisible(sx, sy, radius)) {
        graphic.visible = false;
        this.culledEntities += 1;
        continue;
      }

      const lifeRatio = Math.max(0, 1 - projectile.age / projectile.lifetime);
      const wobble = this.budgetFlags.trailFx && !this.reducedMotion
        ? 1 + Math.sin((projectileId + nowMs * 0.012) * 0.7) * 0.1 * this.motionScale
        : 1;
      const lightAmount = this.lightingPipeline.sampleIlluminance(pos.x, pos.y);

      graphic.visible = true;
      graphic.position.set(sx, sy);
      if (velocity && (velocity.x !== 0 || velocity.y !== 0)) {
        graphic.rotation = Math.atan2(velocity.y, velocity.x);
      }
      graphic.alpha = 0.78 + lifeRatio * 0.2 + lightAmount * 0.05;
      this.setNodeScale(graphic, radius * 2.6, (0.84 + lifeRatio * 0.32) * wobble);
      this.visibleEntities += 1;
    }

    for (const [projectileId, graphic] of this.projectileGraphics.entries()) {
      if (world.projectiles.has(projectileId)) continue;
      graphic.destroy();
      this.projectileGraphics.delete(projectileId);
    }
  }

  private syncEnemyProjectileGraphics(
    world: GameWorld,
    camera: { x: number; y: number },
    centerX: number,
    centerY: number,
    nowMs: number
  ): void {
    for (const projectileId of world.enemyProjectiles) {
      let graphic = this.enemyProjectileGraphics.get(projectileId);
      const pos = world.positions.get(projectileId);
      const radius = world.radii.get(projectileId) ?? 6;
      const projectile = world.enemyProjectileComponents.get(projectileId);
      const velocity = world.velocities.get(projectileId);
      if (!pos || !projectile) continue;

      if (!graphic) {
        if (this.texturePack && this.effectiveTextureDetail() !== 'low') {
          graphic = new Sprite(this.texturePack.projectiles.enemy);
          graphic.anchor.set(0.5);
        } else {
          graphic = new Graphics();
          drawHostileProjectile(graphic, radius, this.theme.projectiles.enemy, this.theme.projectiles.enemyStroke);
        }
        this.enemyProjectileGraphics.set(projectileId, graphic);
        this.combatLayer.addChild(graphic);
      }

      const sx = pos.x - camera.x + centerX;
      const sy = pos.y - camera.y + centerY;
      if (!this.isVisible(sx, sy, radius)) {
        graphic.visible = false;
        this.culledEntities += 1;
        continue;
      }

      const lifeRatio = Math.max(0, 1 - projectile.age / projectile.lifetime);
      const pulse = this.budgetFlags.trailFx && !this.reducedMotion
        ? 0.95 + Math.sin(nowMs * 0.015 + projectileId) * 0.09
        : 1;
      const lightAmount = this.lightingPipeline.sampleIlluminance(pos.x, pos.y);
      graphic.visible = true;
      graphic.position.set(sx, sy);
      if (velocity && (velocity.x !== 0 || velocity.y !== 0)) {
        graphic.rotation = Math.atan2(velocity.y, velocity.x);
      }
      graphic.alpha = 0.72 + lifeRatio * 0.24 + lightAmount * 0.05;
      this.setNodeScale(graphic, radius * 2.7, (0.84 + lifeRatio * 0.25) * pulse);
      this.visibleEntities += 1;
    }

    for (const [projectileId, graphic] of this.enemyProjectileGraphics.entries()) {
      if (world.enemyProjectiles.has(projectileId)) continue;
      graphic.destroy();
      this.enemyProjectileGraphics.delete(projectileId);
    }
  }

  private syncHazardGraphics(
    world: GameWorld,
    camera: { x: number; y: number },
    centerX: number,
    centerY: number,
    frameTimeMs: number,
    nowMs: number
  ): void {
    for (const hazardId of world.hazards) {
      let graphic = this.hazardGraphics.get(hazardId);
      const pos = world.positions.get(hazardId);
      const radius = world.radii.get(hazardId) ?? 42;
      const hazard = world.hazardComponents.get(hazardId);
      if (!pos || !hazard) continue;

      if (!graphic) {
        if (this.texturePack && this.effectiveTextureDetail() !== 'low') {
          graphic = new Sprite(this.texturePack.hazards.ring);
          graphic.anchor.set(0.5);
          graphic.tint = this.theme.hazards.stroke;
        } else {
          graphic = createHazardGraphic(radius, this.theme);
        }
        this.hazardGraphics.set(hazardId, graphic);
        this.combatLayer.addChild(graphic);
      }

      const sx = pos.x - camera.x + centerX;
      const sy = pos.y - camera.y + centerY;
      if (!this.isVisible(sx, sy, radius)) {
        graphic.visible = false;
        this.culledEntities += 1;
        continue;
      }

      const lifeRatio = Math.max(0, 1 - hazard.age / hazard.lifetime);
      const pulse = this.reducedMotion || !this.budgetFlags.secondaryGlows
        ? 0
        : Math.sin((nowMs + hazardId) * 0.006) * 0.08 * this.motionScale;
      const flicker = frameTimeMs < 30 && this.budgetFlags.trailFx ? 0.06 : 0;
      const lightAmount = this.lightingPipeline.sampleIlluminance(pos.x, pos.y);
      graphic.visible = true;
      graphic.position.set(sx, sy);
      graphic.rotation = (nowMs * 0.0005 + hazardId * 0.13) % (Math.PI * 2);
      graphic.alpha = (0.6 + lifeRatio * 0.28 + flicker + lightAmount * 0.04) * this.visualSettings.hazardOpacity;
      this.setNodeScale(graphic, radius * 2.2, 0.93 + pulse);
      this.visibleEntities += 1;
    }

    for (const [hazardId, graphic] of this.hazardGraphics.entries()) {
      if (world.hazards.has(hazardId)) continue;
      graphic.destroy();
      this.hazardGraphics.delete(hazardId);
    }
  }

  private syncChestGraphics(
    world: GameWorld,
    camera: { x: number; y: number },
    centerX: number,
    centerY: number,
    frameTimeMs: number,
    nowMs: number
  ): void {
    for (const chestId of world.chests) {
      let graphic = this.chestGraphics.get(chestId);
      const pos = world.positions.get(chestId);
      if (!pos) continue;

      if (!graphic) {
        if (this.texturePack && this.effectiveTextureDetail() !== 'low') {
          graphic = new Sprite(this.texturePack.pickups.chest);
          graphic.anchor.set(0.5);
        } else {
          graphic = createChestGraphic(this.theme);
        }
        this.chestGraphics.set(chestId, graphic);
        this.worldLayer.addChild(graphic);
      }

      const sx = pos.x - camera.x + centerX;
      const sy = pos.y - camera.y + centerY;
      if (!this.isVisible(sx, sy, 24)) {
        graphic.visible = false;
        this.culledEntities += 1;
        continue;
      }

      const pulse = this.reducedMotion || !this.budgetFlags.secondaryGlows
        ? 1
        : 1 + Math.sin((nowMs + chestId) * 0.005) * 0.09;
      const lightAmount = this.lightingPipeline.sampleIlluminance(pos.x, pos.y);
      graphic.visible = true;
      graphic.position.set(sx, sy);
      graphic.rotation = Math.sin((nowMs + chestId * 13) * 0.0012) * 0.03;
      graphic.alpha = frameTimeMs < 30 ? 0.94 + lightAmount * 0.06 : 0.88 + lightAmount * 0.08;
      this.setNodeScale(graphic, 42, pulse);
      this.visibleEntities += 1;
    }

    for (const [chestId, graphic] of this.chestGraphics.entries()) {
      if (world.chests.has(chestId)) continue;
      graphic.destroy();
      this.chestGraphics.delete(chestId);
    }
  }

  private syncXpGraphics(
    world: GameWorld,
    camera: { x: number; y: number },
    centerX: number,
    centerY: number,
    frameTimeMs: number,
    nowMs: number
  ): void {
    for (const xpId of world.xpOrbs) {
      let graphic = this.xpGraphics.get(xpId);
      const pos = world.positions.get(xpId);
      if (!pos) continue;

      if (!graphic) {
        if (this.texturePack && this.effectiveTextureDetail() !== 'low') {
          graphic = new Sprite(this.texturePack.pickups.xp);
          graphic.anchor.set(0.5);
        } else {
          graphic = createXpGraphic(this.theme.pickups.xpFill, this.theme.pickups.xpStroke);
        }
        this.xpGraphics.set(xpId, graphic);
        this.worldLayer.addChild(graphic);
      }

      const sx = pos.x - camera.x + centerX;
      const sy = pos.y - camera.y + centerY;
      if (!this.isVisible(sx, sy, 8)) {
        graphic.visible = false;
        this.culledEntities += 1;
        continue;
      }

      const wobble = this.budgetFlags.trailFx && !this.reducedMotion
        ? 1 + Math.sin((xpId + nowMs * 0.007) * 0.8) * 0.08 * this.motionScale
        : 1;
      const glint = frameTimeMs < 22 && this.budgetFlags.secondaryGlows ? 0.08 : 0;
      const lightAmount = this.lightingPipeline.sampleIlluminance(pos.x, pos.y);
      graphic.visible = true;
      graphic.position.set(sx, sy);
      graphic.rotation = (nowMs * 0.0011 + xpId * 0.21) % (Math.PI * 2);
      graphic.alpha = 0.9 + glint + lightAmount * 0.08;
      this.setNodeScale(graphic, 18, wobble);
      this.visibleEntities += 1;
    }

    for (const [xpId, graphic] of this.xpGraphics.entries()) {
      if (world.xpOrbs.has(xpId)) continue;
      graphic.destroy();
      this.xpGraphics.delete(xpId);
    }
  }

  private syncDashTelegraphs(
    world: GameWorld,
    camera: { x: number; y: number },
    centerX: number,
    centerY: number,
    nowMs: number
  ): void {
    if (!this.dashTelegraphGraphic) return;
    this.dashTelegraphGraphic.clear();

    for (const enemyId of world.enemies) {
      const component = world.enemyComponents.get(enemyId);
      const pos = world.positions.get(enemyId);
      if (!component || !pos || component.dashWindup <= 0) continue;

      const archetype = ENEMY_ARCHETYPES[component.archetypeId];
      const dash = archetype?.dash;
      if (!dash) continue;

      const sx = pos.x - camera.x + centerX;
      const sy = pos.y - camera.y + centerY;
      if (!this.isVisible(sx, sy, 24)) continue;

      const progress = 1 - component.dashWindup / dash.windup;
      const lineLength = 140 + progress * 230;
      const ex = sx + component.dashDirection.x * lineLength;
      const ey = sy + component.dashDirection.y * lineLength;
      const pulse = this.reducedMotion ? 0 : Math.sin(nowMs * 0.018 + enemyId) * 0.08;
      const alpha = 0.22 + progress * 0.48;
      const perpX = -component.dashDirection.y;
      const perpY = component.dashDirection.x;
      const coneWidth = 18 + progress * 34;
      const baseLeftX = sx + perpX * coneWidth;
      const baseLeftY = sy + perpY * coneWidth;
      const baseRightX = sx - perpX * coneWidth;
      const baseRightY = sy - perpY * coneWidth;

      this.dashTelegraphGraphic.poly([
        { x: baseLeftX, y: baseLeftY },
        { x: ex, y: ey },
        { x: baseRightX, y: baseRightY }
      ]);
      this.dashTelegraphGraphic.fill({ color: this.theme.telegraph.line, alpha: alpha * 0.14 });
      this.dashTelegraphGraphic.moveTo(sx, sy);
      this.dashTelegraphGraphic.lineTo(ex, ey);
      this.dashTelegraphGraphic.stroke({ width: 2.2 + progress * 2.6, color: this.theme.telegraph.line, alpha });
      this.dashTelegraphGraphic.circle(sx, sy, (world.radii.get(enemyId) ?? 14) * (1 + pulse) + progress * 18);
      this.dashTelegraphGraphic.stroke({ width: 1.4, color: this.theme.telegraph.ring, alpha: alpha * 0.9 });
    }
  }

  private syncDirectionalIndicators(
    world: GameWorld,
    camera: { x: number; y: number },
    centerX: number,
    centerY: number
  ): void {
    if (!this.directionalIndicatorGraphic || !this.app) return;
    const indicatorGraphic = this.directionalIndicatorGraphic;
    indicatorGraphic.clear();

    if (!this.visualSettings.showDirectionalIndicators || this.budgetTier === 'minimal') {
      return;
    }

    const width = this.app.screen.width;
    const height = this.app.screen.height;
    const margin = 28;
    let emitted = 0;

    const drawIndicator = (wx: number, wy: number, color: number, isChest = false): void => {
      const sx = wx - camera.x + centerX;
      const sy = wy - camera.y + centerY;
      if (sx >= 0 && sx <= width && sy >= 0 && sy <= height) return;

      const dx = sx - centerX;
      const dy = sy - centerY;
      const len = Math.max(1, Math.hypot(dx, dy));
      const nx = dx / len;
      const ny = dy / len;
      const ix = clamp(centerX + nx * (Math.min(centerX, centerY) - margin), margin, width - margin);
      const iy = clamp(centerY + ny * (Math.min(centerX, centerY) - margin), margin, height - margin);

      if (isChest) {
        indicatorGraphic.rect(ix - 6, iy - 6, 12, 12);
        indicatorGraphic.fill({ color, alpha: 0.88 });
        indicatorGraphic.stroke({ width: 1.2, color: this.theme.pickups.chestStroke, alpha: 0.9 });
      } else {
        const px = ix - nx * 10;
        const py = iy - ny * 10;
        indicatorGraphic.poly([
          { x: ix + nx * 8, y: iy + ny * 8 },
          { x: px + ny * 5, y: py - nx * 5 },
          { x: px - ny * 5, y: py + nx * 5 }
        ]);
        indicatorGraphic.fill({ color, alpha: 0.86 });
        indicatorGraphic.stroke({ width: 1, color: this.theme.telegraph.ring, alpha: 0.9 });
      }
      emitted += 1;
    };

    for (const enemyId of world.enemies) {
      if (emitted >= 8) break;
      const component = world.enemyComponents.get(enemyId);
      if (!component) continue;
      const archetype = ENEMY_ARCHETYPES[component.archetypeId];
      if (!archetype?.isElite) continue;
      const pos = world.positions.get(enemyId);
      if (!pos) continue;
      drawIndicator(pos.x, pos.y, this.theme.elite.crown, false);
    }

    if (Math.max(width, height) >= 1700) {
      const pressureCandidates: Array<{ x: number; y: number; score: number }> = [];
      for (const enemyId of world.enemies) {
        const component = world.enemyComponents.get(enemyId);
        if (!component) continue;
        const archetype = ENEMY_ARCHETYPES[component.archetypeId];
        if (!archetype || archetype.isElite) continue;
        const pos = world.positions.get(enemyId);
        if (!pos) continue;
        const sx = pos.x - camera.x + centerX;
        const sy = pos.y - camera.y + centerY;
        if (sx >= 0 && sx <= width && sy >= 0 && sy <= height) continue;
        const distance = Math.hypot(pos.x - camera.x, pos.y - camera.y);
        const score = archetype.threat / Math.max(1, distance);
        pressureCandidates.push({ x: pos.x, y: pos.y, score });
      }
      pressureCandidates.sort((a, b) => b.score - a.score);
      for (const candidate of pressureCandidates.slice(0, 4)) {
        if (emitted >= 12) break;
        drawIndicator(candidate.x, candidate.y, this.theme.projectiles.enemy, false);
      }
    }

    for (const chestId of world.chests) {
      if (emitted >= 12) break;
      const pos = world.positions.get(chestId);
      if (!pos) continue;
      drawIndicator(pos.x, pos.y, this.theme.pickups.chestStroke, true);
    }
  }

  private syncPlayerAura(world: GameWorld, centerX: number, centerY: number, frameTimeMs: number, nowMs: number): void {
    if (!this.playerAuraGraphic) return;
    const aura = this.playerAuraGraphic;
    const highMotion = !this.reducedMotion && this.budgetFlags.secondaryGlows && this.motionScale > 0;
    const eventColor = world.activeEventId ? EVENT_AURA_COLORS[world.activeEventId] || this.theme.player.aura : this.theme.player.aura;
    const damagePulse = Math.max(0, Math.min(1, world.damageFlashTimer / 0.2));
    const baseRadius = 14 + (highMotion ? Math.sin(nowMs * 0.006) * 1.5 * this.motionScale : 0);
    const auraRadius = baseRadius + damagePulse * (1.2 + 1.2 * this.motionScale);

    aura.clear();
    aura.circle(centerX, centerY, auraRadius);
    aura.stroke({ width: 1.3, color: eventColor, alpha: 0.09 + damagePulse * 0.1 });

    if (
      highMotion &&
      frameTimeMs < 35 &&
      this.budgetTier !== 'minimal' &&
      this.readabilitySnapshot.activeSuppressionTier === 'none'
    ) {
      aura.circle(centerX, centerY, auraRadius + 5);
      aura.stroke({ width: 1, color: eventColor, alpha: 0.03 + damagePulse * 0.06 });
    }
  }

  private syncScreenOverlay(world: GameWorld, frameTimeMs: number, nowMs: number): void {
    if (!this.app || !this.damageVignette || !this.eventAuraGraphic || !this.impactGlowGraphic) return;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const centerX = w / 2;
    const centerY = h / 2;

    const auraColor = world.activeEventId ? EVENT_AURA_COLORS[world.activeEventId] || this.theme.backdrop.eventTint : this.theme.backdrop.eventTint;
    const eventStrength = world.activeEventId ? 1 : 0;
    const auraAlphaBase = this.budgetFlags.secondaryGlows ? 0.06 : 0.04;
    const pulse = this.reducedMotion ? 0 : Math.sin(nowMs * 0.0014) * 0.03 * this.motionScale;
    const auraAlpha = eventStrength > 0 ? Math.max(0, auraAlphaBase + pulse) : 0;

    this.eventAuraGraphic.clear();
    if (auraAlpha > 0.001) {
      // Keep center combat space clear; grade only top/bottom edges.
      this.eventAuraGraphic.roundRect(-24, -12, w + 48, h * 0.15, 28);
      this.eventAuraGraphic.fill({ color: auraColor, alpha: auraAlpha * 0.16 });
      this.eventAuraGraphic.roundRect(-24, h * 0.84, w + 48, h * 0.18, 28);
      this.eventAuraGraphic.fill({ color: auraColor, alpha: auraAlpha * 0.12 });
      if (this.budgetFlags.secondaryGlows && this.readabilitySnapshot.activeSuppressionTier === 'none') {
        this.eventAuraGraphic.circle(centerX, centerY, Math.max(w, h) * 0.22);
        this.eventAuraGraphic.fill({ color: auraColor, alpha: auraAlpha * 0.2 });
      }
    }

    const damageRatio = Math.max(0, Math.min(1, world.damageFlashTimer / 0.2));
    const vignetteAlpha = damageRatio * 0.28 * this.visualSettings.hitFlashStrength;
    this.damageVignette.clear();
    if (vignetteAlpha > 0.001) {
      const edge = Math.max(36, Math.round(Math.min(w, h) * 0.08));
      this.damageVignette.rect(0, 0, w, edge);
      this.damageVignette.rect(0, h - edge, w, edge);
      this.damageVignette.rect(0, edge, edge, h - edge * 2);
      this.damageVignette.rect(w - edge, edge, edge, h - edge * 2);
      this.damageVignette.fill({ color: 0xff7f74, alpha: vignetteAlpha * 0.32 });
    }

    const impactRatio = Math.max(0, Math.min(1, world.impactFlashTimer / 0.16));
    this.impactGlowGraphic.clear();
    if (
      impactRatio > 0.001 &&
      this.budgetFlags.secondaryGlows &&
      frameTimeMs < 36 &&
      this.readabilitySnapshot.activeSuppressionTier !== 'hard'
    ) {
      const alpha = impactRatio * 0.14 * this.visualSettings.hitFlashStrength;
      this.impactGlowGraphic.rect(0, 0, w, h);
      this.impactGlowGraphic.fill({ color: this.theme.player.aura, alpha });
    }
  }

  private updateEnemyHitPulses(frameTimeMs: number): void {
    if (this.enemyHitPulse.size === 0) return;
    const decay = Math.max(0.01, frameTimeMs / 1000);
    for (const [enemyId, timer] of this.enemyHitPulse.entries()) {
      const next = timer - decay;
      if (next <= 0) {
        this.enemyHitPulse.delete(enemyId);
      } else {
        this.enemyHitPulse.set(enemyId, next);
      }
    }
  }

  private updateAmbientMotes(playerPos: { x: number; y: number }, frameTimeMs: number, nowMs: number): void {
    if (this.motes.length === 0) return;
    if (!this.budgetFlags.ambientMotes || this.quality === 'low' || this.readabilitySnapshot.activeSuppressionTier === 'hard') {
      for (const mote of this.motes) mote.visible = false;
      return;
    }

    const activeRatio = this.budgetTier === 'ultra' ? 1 : this.budgetTier === 'high' ? 0.82 : 0.58;
    const activeMotes = Math.floor(
      this.motes.length * activeRatio * this.readabilitySnapshot.appliedOverrides.ambientParticleMultiplier
    );
    for (let i = 0; i < this.motes.length; i += 1) {
      const mote = this.motes[i];
      mote.visible = i < activeMotes;
      if (!mote.visible) continue;

      const drift = frameTimeMs * 0.005 * this.motionScale;
      mote.x += Math.sin((i + nowMs * 0.0003) * 0.8) * drift;
      mote.y += Math.cos((i + nowMs * 0.00025) * 0.9) * drift;

      if (mote.x > playerPos.x + 1900) mote.x -= 3800;
      if (mote.x < playerPos.x - 1900) mote.x += 3800;
      if (mote.y > playerPos.y + 1900) mote.y -= 3800;
      if (mote.y < playerPos.y - 1900) mote.y += 3800;

      mote.position.set(mote.x - playerPos.x * 0.85, mote.y - playerPos.y * 0.85);
    }
  }

  private updateWebGpuFx(world: GameWorld, frameTimeMs: number, nowMs: number): void {
    if (!this.webgpuNoiseFilter || this.rendererKind !== 'webgpu') return;
    const cinematicLook =
      this.visualSettings.clarityPreset === 'cinematic' || this.visualSettings.resolutionProfile === 'quality';
    if (this.safariSafeMode && !cinematicLook) {
      this.webgpuNoiseFilter.noise = 0;
      return;
    }
    if (!this.budgetFlags.overlayNoise || this.reducedMotion || this.motionScale <= 0) {
      this.webgpuNoiseFilter.noise = cinematicLook ? 0.006 : 0.002;
      return;
    }

    const qualityScalar =
      this.lightingSettings.lightingQuality === 'cinematic'
        ? 0.94
        : this.lightingSettings.lightingQuality === 'high'
          ? 0.88
          : this.lightingSettings.lightingQuality === 'medium'
            ? 0.72
            : 0.56;
    const targetNoise =
      (this.budgetTier === 'ultra' ? 0.011 : this.budgetTier === 'high' ? 0.0086 : 0.0062) *
      qualityScalar *
      (0.34 + this.lightingSettings.bloomStrength * 0.22) *
      this.readabilitySnapshot.appliedOverrides.nonEssentialGlowMultiplier;
    const eventBoost = world.activeEventId ? 0.0018 : 0;
    this.webgpuNoiseFilter.noise = clamp(
      (targetNoise + eventBoost) * Math.max(0.24, this.motionScale),
      0.0018,
      cinematicLook ? 0.012 : 0.004
    );
    this.webgpuNoiseFilter.seed = (nowMs * 0.00002 + frameTimeMs * 0.0005) % 1;
  }

  destroy(): void {
    for (const graphic of this.enemyGraphics.values()) graphic.destroy();
    for (const graphic of this.projectileGraphics.values()) graphic.destroy();
    for (const graphic of this.enemyProjectileGraphics.values()) graphic.destroy();
    for (const graphic of this.hazardGraphics.values()) graphic.destroy();
    for (const graphic of this.chestGraphics.values()) graphic.destroy();
    for (const graphic of this.xpGraphics.values()) graphic.destroy();

    this.enemyGraphics.clear();
    this.enemyPrevHp.clear();
    this.enemyHitPulse.clear();
    this.projectileGraphics.clear();
    this.enemyProjectileGraphics.clear();
    this.hazardGraphics.clear();
    this.chestGraphics.clear();
    this.xpGraphics.clear();

    this.backdropLayer.removeChildren();
    this.shadowLayer.removeChildren();
    this.worldLayer.removeChildren();
    this.fxLayer.removeChildren();
    this.combatLayer.removeChildren();
    this.lightingLayer.removeChildren();
    this.overlayLayer.removeChildren();

    if (this.app) {
      this.app.destroy(true, { children: true });
      this.app = null;
    }
    this.destroyTexturePack(this.texturePack);
    this.texturePack = null;

    if (this.mountEl) {
      this.mountEl.innerHTML = '';
    }

    this.backdropGraphic = null;
    this.playerGraphic = null;
    this.playerAuraGraphic = null;
    this.damageVignette = null;
    this.eventAuraGraphic = null;
    this.impactGlowGraphic = null;
    this.dashTelegraphGraphic = null;
    this.directionalIndicatorGraphic = null;
    this.lightFieldGraphic = null;
    this.shadowFieldGraphic = null;
    this.fogFieldGraphic = null;
    this.motes = [];
    this.webgpuNoiseFilter = null;
    this.webgpuGradeFilter = null;
    this.lastBudgetEvalAt = 0;
    this.lastTierChangeAt = 0;
    this.lastBackdropDrawAt = 0;
    this.lastBackdropCameraX = Number.NaN;
    this.lastBackdropCameraY = Number.NaN;
    this.lastBackdropEventId = null;
    this.cameraVelocitySq = 0;
    this.lastCameraX = Number.NaN;
    this.lastCameraY = Number.NaN;
    this.readabilityGovernor.reset();
  }
}
