import { FixedStepLoop, type LoopStats } from './core/loop';
import { AudioManager } from './audio/audioManager';
import { GameWorld } from './core/world';
import { CATALYST_DEFINITIONS } from './data/catalysts';
import { getRunEventDescription, getRunEventLabel } from './data/events';
import { buildHandbookSections } from './data/handbook';
import { WEAPON_ARCHETYPES } from './data/weapons';
import { PixiRenderAdapter } from './render/pixiRenderAdapter';
import {
  clamp,
  parseCombatReadabilityMode,
  parseClarityPreset,
  parseSceneStyle,
  parseColorVisionMode,
  parseFogQuality,
  parseEdgeAntialiasingMode,
  parseLightingQuality,
  parseMaterialDetail,
  parseOptions,
  parseRendererPreference,
  parseShadowQuality,
  parseTextureDetail,
  saveSettings,
  type RuntimeSettingsPayload
} from './runtime/settings';
import { resolveRestartAction } from './runtime/restartPolicy';
import {
  shouldHandleOverlayCloseShortcut,
  shouldSuppressOverlayGameplayKey
} from './runtime/overlayInput';
import type { HandbookSection, ISystem, LevelUpChoice, QualityTier } from './types';
import { AutoAttackSystem } from './systems/autoAttackSystem';
import { CleanupSystem } from './systems/cleanupSystem';
import { CollisionSystem } from './systems/collisionSystem';
import { EnemyAISystem } from './systems/enemyAISystem';
import { LevelSystem } from './systems/levelSystem';
import { MovementSystem } from './systems/movementSystem';
import { PlayerInputSystem } from './systems/playerInputSystem';
import { ProjectileSystem } from './systems/projectileSystem';
import { RuntimeSystem } from './systems/runtimeSystem';
import { SpawnSystem } from './systems/spawnSystem';
import { XpSystem } from './systems/xpSystem';

interface InventoryTileRefs {
  root: HTMLDivElement;
  title: HTMLElement;
  subtitle: HTMLElement;
}

const DEFAULT_PAUSE_MESSAGE = 'Paused - Press Esc to Resume';

function formatRunTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function chooseQuality(smoothedMs: number, current: QualityTier): QualityTier {
  // Keep quality user-driven; avoid automatic runtime downgrades that can make visuals look muddy.
  void smoothedMs;
  return current;
}

function keyToMovementFlag(key: string): 'up' | 'down' | 'left' | 'right' | null {
  if (key === 'w' || key === 'arrowup') return 'up';
  if (key === 's' || key === 'arrowdown') return 'down';
  if (key === 'a' || key === 'arrowleft') return 'left';
  if (key === 'd' || key === 'arrowright') return 'right';
  return null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON';
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }
  return element as T;
}

function choiceRarity(choice: LevelUpChoice): 'common' | 'rare' | 'epic' | 'legendary' {
  return choice.rarity ?? 'common';
}

function createBuildSlotTile(): InventoryTileRefs {
  const root = document.createElement('div');
  root.className = 'build-slot empty';
  const title = document.createElement('strong');
  const subtitle = document.createElement('em');
  root.append(title, subtitle);
  return { root, title, subtitle };
}

// Module-level abort controller so HMR re-runs can clean up prior event listeners.
let _mainTeardown: AbortController | null = null;

async function main(): Promise<void> {
  _mainTeardown?.abort();
  _mainTeardown = new AbortController();
  const { signal } = _mainTeardown;
  const options = parseOptions(window.location.href, localStorage);
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const world = new GameWorld(options.seed, prefersReducedMotion);
  const renderer = new PixiRenderAdapter();
  const audio = new AudioManager(options.audioEnabled);

  const gameShell = requireElement<HTMLElement>('gameShell');
  const gameRoot = requireElement<HTMLElement>('gameRoot');
  const bootScreen = requireElement<HTMLElement>('bootScreen');
  const startGameBtn = requireElement<HTMLButtonElement>('startGameBtn');
  const unsupportedPanel = requireElement<HTMLElement>('unsupportedPanel');
  const hud = requireElement<HTMLElement>('hud');
  const pauseBanner = requireElement<HTMLElement>('pauseBanner');
  const levelUpModal = requireElement<HTMLElement>('levelUpModal');
  const upgradeGrid = requireElement<HTMLElement>('upgradeGrid');
  const chestModal = requireElement<HTMLElement>('chestModal');
  const chestGrid = requireElement<HTMLElement>('chestGrid');
  const inventoryBar = requireElement<HTMLElement>('inventoryBar');
  const catalystBar = requireElement<HTMLElement>('catalystBar');
  const gameOverModal = requireElement<HTMLElement>('gameOverModal');
  const settingsPanel = requireElement<HTMLElement>('settingsPanel');
  const settingsToggleBtn = requireElement<HTMLButtonElement>('settingsToggleBtn');
  const helpToggleBtn = requireElement<HTMLButtonElement>('helpToggleBtn');
  const helpPanel = requireElement<HTMLElement>('helpPanel');
  const helpCloseBtn = requireElement<HTMLButtonElement>('helpCloseBtn');
  const helpSearch = requireElement<HTMLInputElement>('helpSearch');
  const helpTabs = requireElement<HTMLElement>('helpTabs');
  const helpContent = requireElement<HTMLElement>('helpContent');
  const settingsCloseBtn = requireElement<HTMLButtonElement>('settingsCloseBtn');
  const settingsApplyRendererBtn = requireElement<HTMLButtonElement>('settingsApplyRendererBtn');
  const settingsAudioEnabled = requireElement<HTMLInputElement>('settingsAudioEnabled');
  const settingsAudioVolume = requireElement<HTMLInputElement>('settingsAudioVolume');
  const settingsAudioVolumeValue = requireElement<HTMLElement>('settingsAudioVolumeValue');
  const settingsMotionIntensity = requireElement<HTMLInputElement>('settingsMotionIntensity');
  const settingsMotionIntensityValue = requireElement<HTMLElement>('settingsMotionIntensityValue');
  const settingsRendererPreference = requireElement<HTMLSelectElement>('settingsRendererPreference');
  const settingsTextureDetail = requireElement<HTMLSelectElement>('settingsTextureDetail');
  const settingsEdgeAntialiasing = requireElement<HTMLSelectElement>('settingsEdgeAntialiasing');
  const settingsDesktopUltraLock = requireElement<HTMLInputElement>('settingsDesktopUltraLock');
  const settingsColorVision = requireElement<HTMLSelectElement>('settingsColorVision');
  const settingsCombatReadabilityMode = requireElement<HTMLSelectElement>('settingsCombatReadabilityMode');
  const settingsUiScale = requireElement<HTMLInputElement>('settingsUiScale');
  const settingsUiScaleValue = requireElement<HTMLElement>('settingsUiScaleValue');
  const settingsScreenShake = requireElement<HTMLInputElement>('settingsScreenShake');
  const settingsScreenShakeValue = requireElement<HTMLElement>('settingsScreenShakeValue');
  const settingsHazardOpacity = requireElement<HTMLInputElement>('settingsHazardOpacity');
  const settingsHazardOpacityValue = requireElement<HTMLElement>('settingsHazardOpacityValue');
  const settingsHitFlashStrength = requireElement<HTMLInputElement>('settingsHitFlashStrength');
  const settingsHitFlashStrengthValue = requireElement<HTMLElement>('settingsHitFlashStrengthValue');
  const settingsEnemyOutlineStrength = requireElement<HTMLInputElement>('settingsEnemyOutlineStrength');
  const settingsEnemyOutlineStrengthValue = requireElement<HTMLElement>('settingsEnemyOutlineStrengthValue');
  const settingsBackgroundDensity = requireElement<HTMLInputElement>('settingsBackgroundDensity');
  const settingsBackgroundDensityValue = requireElement<HTMLElement>('settingsBackgroundDensityValue');
  const settingsAtmosphereStrength = requireElement<HTMLInputElement>('settingsAtmosphereStrength');
  const settingsAtmosphereStrengthValue = requireElement<HTMLElement>('settingsAtmosphereStrengthValue');
  const settingsPresetPainterlyBalanced = requireElement<HTMLButtonElement>('settingsPresetPainterlyBalanced');
  const settingsPresetPainterlyCombat = requireElement<HTMLButtonElement>('settingsPresetPainterlyCombat');
  const settingsLightingQuality = requireElement<HTMLSelectElement>('settingsLightingQuality');
  const settingsShadowQuality = requireElement<HTMLSelectElement>('settingsShadowQuality');
  const settingsFogQuality = requireElement<HTMLSelectElement>('settingsFogQuality');
  const settingsBloomStrength = requireElement<HTMLInputElement>('settingsBloomStrength');
  const settingsBloomStrengthValue = requireElement<HTMLElement>('settingsBloomStrengthValue');
  const settingsGamma = requireElement<HTMLInputElement>('settingsGamma');
  const settingsGammaValue = requireElement<HTMLElement>('settingsGammaValue');
  const settingsEnvironmentContrast = requireElement<HTMLInputElement>('settingsEnvironmentContrast');
  const settingsEnvironmentContrastValue = requireElement<HTMLElement>('settingsEnvironmentContrastValue');
  const settingsMaterialDetail = requireElement<HTMLSelectElement>('settingsMaterialDetail');
  const settingsClarityPreset = requireElement<HTMLSelectElement>('settingsClarityPreset');
  const settingsDamageNumbers = requireElement<HTMLInputElement>('settingsDamageNumbers');
  const settingsDirectionalIndicators = requireElement<HTMLInputElement>('settingsDirectionalIndicators');
  const settingsDebugOverlay = requireElement<HTMLInputElement>('settingsDebugOverlay');
  const restartRunBtn = requireElement<HTMLButtonElement>('restartRunBtn');
  const copySeedBtn = requireElement<HTMLButtonElement>('copySeedBtn');
  const runSummary = requireElement<HTMLElement>('runSummary');
  const debugPanel = requireElement<HTMLElement>('debugPanel');

  const hudHpChip = requireElement<HTMLElement>('hudHpChip');
  const hudHp = requireElement<HTMLElement>('hudHp');
  const hudLevel = requireElement<HTMLElement>('hudLevel');
  const hudEnemies = requireElement<HTMLElement>('hudEnemies');
  const hudTime = requireElement<HTMLElement>('hudTime');
  const hudEventChip = requireElement<HTMLElement>('hudEventChip');
  const hudEvent = requireElement<HTMLElement>('hudEvent');
  const hudAudio = requireElement<HTMLElement>('hudAudio');
  const hudRenderer = requireElement<HTMLElement>('hudRenderer');
  const hudEvolutionReady = requireElement<HTMLElement>('hudEvolutionReady');
  const xpFill = requireElement<HTMLElement>('xpFill');

  const inventoryTiles: InventoryTileRefs[] = [];
  for (let i = 0; i < 4; i += 1) {
    const tile = createBuildSlotTile();
    inventoryBar.appendChild(tile.root);
    inventoryTiles.push(tile);
  }

  const hudCache = {
    hp: '',
    level: '',
    enemies: '',
    time: '',
    event: '',
    audio: '',
    xpWidth: '',
    eventDescription: '',
    evolutionReady: '',
    inventory: Array.from({ length: 4 }, () => ''),
    catalysts: ''
  };
  type HudStringCacheKey = 'hp' | 'level' | 'enemies' | 'time' | 'event' | 'audio';

  let pausedByVisibility = false;
  let pausedBySettings = false;
  let pausedByHelp = false;
  let settingsOpen = false;
  let helpOpen = false;
  let savedMovementInput: { up: boolean; down: boolean; left: boolean; right: boolean } | null = null;
  let lastLevelSignature = '';
  let lastChestSignature = '';
  let preferredRenderer = options.rendererPreference;
  let rendererPolicy = options.rendererPolicy;
  let safariSafeMode = options.safariSafeMode;
  let audioEnabled = options.audioEnabled;
  let audioVolume = options.audioVolume;
  let motionScale = options.motionScale;
  let colorVisionMode = options.colorVisionMode;
  let sceneStyle = options.sceneStyle;
  let combatReadabilityMode = options.combatReadabilityMode;
  let uiScale = options.uiScale;
  let screenShake = options.screenShake;
  let hazardOpacity = options.hazardOpacity;
  let hitFlashStrength = options.hitFlashStrength;
  let enemyOutlineStrength = options.enemyOutlineStrength;
  let backgroundDensity = options.backgroundDensity;
  let atmosphereStrength = options.atmosphereStrength;
  let lightingQuality = options.lightingQuality;
  let shadowQuality = options.shadowQuality;
  let fogQuality = options.fogQuality;
  let bloomStrength = options.bloomStrength;
  let gamma = options.gamma;
  let environmentContrast = options.environmentContrast;
  let materialDetail = options.materialDetail;
  let clarityPreset = options.clarityPreset;
  let textureDetail = options.textureDetail;
  let edgeAntialiasing = options.edgeAntialiasing;
  let resolutionProfile = options.resolutionProfile;
  let resolutionScale = options.resolutionScale;
  let postFxSoftness = options.postFxSoftness;
  let desktopUltraLock = options.desktopUltraLock;
  let showDamageNumbers = options.showDamageNumbers;
  let showDirectionalIndicators = options.showDirectionalIndicators;
  let debugOverlayEnabled = options.debugMode;
  let previousShotsFired = 0;
  let previousPlayerHitCount = 0;
  let previousLevelUpOfferedCount = 0;
  let previousEliteKills = 0;
  let previousEventId: string | null = null;
  let previousUiState = world.uiState;
  let lastHeavyHudSyncAt = 0;
  let hudSyncMs = 0;
  let hudResizeObserver: ResizeObserver | null = null;
  const handbookSections = buildHandbookSections();
  let activeHelpSectionId = handbookSections[0]?.id ?? 'controls';

  world.setQuality('high');

  function persistSettings(quality: QualityTier): void {
    const next: RuntimeSettingsPayload = {
      rendererPreference: preferredRenderer,
      rendererPolicy,
      safariSafeMode,
      quality,
      audioEnabled,
      audioVolume,
      motionScale,
      visualPreset: 'bioluminescent',
      sceneStyle,
      combatReadabilityMode,
      colorVisionMode,
      uiScale,
      screenShake,
      hazardOpacity,
      hitFlashStrength,
      enemyOutlineStrength,
      backgroundDensity,
      atmosphereStrength,
      lightingQuality,
      shadowQuality,
      fogQuality,
      bloomStrength,
      gamma,
      environmentContrast,
      materialDetail,
      clarityPreset,
      textureDetail,
      edgeAntialiasing,
      resolutionProfile,
      resolutionScale,
      postFxSoftness,
      desktopUltraLock,
      showDamageNumbers,
      showDirectionalIndicators,
      debugOverlayEnabled
    };
    saveSettings(localStorage, next);
  }

  function syncDebugVisibility(): void {
    debugPanel.classList.toggle('hidden', !debugOverlayEnabled);
  }

  function createRandomSeed(): number {
    if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
      const value = new Uint32Array(1);
      window.crypto.getRandomValues(value);
      return value[0] || 1337;
    }
    const mixed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    return mixed || 1337;
  }

  function applyVisualSettings(): void {
    const effectiveMotionScale = prefersReducedMotion ? Math.min(motionScale, 0.35) : motionScale;
    const effectiveScreenShake = prefersReducedMotion ? Math.min(screenShake, 0.2) : screenShake;
    const effectiveFogQuality = prefersReducedMotion && fogQuality === 'volumetric' ? 'layered' : fogQuality;

    renderer.setMotionScale(effectiveMotionScale);
    renderer.setVisualSettings({
      visualPreset: 'bioluminescent',
      rendererPolicy,
      safariSafeMode,
      sceneStyle,
      combatReadabilityMode,
      colorVisionMode,
      motionScale: effectiveMotionScale,
      uiScale,
      screenShake: effectiveScreenShake,
      hazardOpacity,
      hitFlashStrength,
      enemyOutlineStrength,
      backgroundDensity,
      atmosphereStrength,
      showDamageNumbers,
      showDirectionalIndicators,
      lightingQuality,
      shadowQuality,
      fogQuality: effectiveFogQuality,
      bloomStrength,
      gamma,
      environmentContrast,
      materialDetail,
      clarityPreset,
      textureDetail,
      edgeAntialiasing,
      resolutionProfile,
      resolutionScale,
      postFxSoftness,
      desktopUltraLock
    });

    renderer.setLightingSettings({
      lightingQuality,
      shadowQuality,
      fogQuality: effectiveFogQuality,
      bloomStrength,
      gamma,
      environmentContrast,
      materialDetail,
      clarityPreset
    });

    gameShell.style.setProperty('--hud-scale', uiScale.toFixed(2));
    gameShell.dataset.colorVisionMode = colorVisionMode;
    gameShell.dataset.sceneStyle = sceneStyle;
  }

  function syncTopChromeOffsets(): void {
    const shellRect = gameShell.getBoundingClientRect();
    const hudBottom = hud.classList.contains('hidden')
      ? 0
      : Math.max(0, hud.getBoundingClientRect().bottom - shellRect.top);
    const topAnchor = Math.max(88, Math.round(hudBottom + 8));
    gameShell.style.setProperty('--hud-stack-bottom', `${topAnchor}px`);
  }

  function syncViewportMetrics(): void {
    world.setViewport(renderer.getViewportMetrics());
  }

  function syncSettingsControls(): void {
    const setPercentControl = (input: HTMLInputElement, label: HTMLElement, value: number): void => {
      const percent = Math.round(value * 100);
      input.value = String(percent);
      label.textContent = `${percent}%`;
    };

    settingsAudioEnabled.checked = audioEnabled;
    setPercentControl(settingsAudioVolume, settingsAudioVolumeValue, audioVolume);
    settingsAudioVolume.disabled = !audioEnabled;

    setPercentControl(settingsMotionIntensity, settingsMotionIntensityValue, motionScale);

    settingsRendererPreference.value = preferredRenderer;
    settingsTextureDetail.value = textureDetail === 'low' ? 'medium' : textureDetail;
    settingsEdgeAntialiasing.value = edgeAntialiasing;
    settingsDesktopUltraLock.checked = desktopUltraLock;
    settingsColorVision.value = colorVisionMode;
    settingsCombatReadabilityMode.value = combatReadabilityMode;
    setPercentControl(settingsUiScale, settingsUiScaleValue, uiScale);
    setPercentControl(settingsScreenShake, settingsScreenShakeValue, screenShake);
    setPercentControl(settingsHazardOpacity, settingsHazardOpacityValue, hazardOpacity);
    setPercentControl(settingsHitFlashStrength, settingsHitFlashStrengthValue, hitFlashStrength);
    setPercentControl(settingsEnemyOutlineStrength, settingsEnemyOutlineStrengthValue, enemyOutlineStrength);
    setPercentControl(settingsBackgroundDensity, settingsBackgroundDensityValue, backgroundDensity);
    setPercentControl(settingsAtmosphereStrength, settingsAtmosphereStrengthValue, atmosphereStrength);
    settingsLightingQuality.value = lightingQuality;
    settingsShadowQuality.value = shadowQuality;
    settingsFogQuality.value = fogQuality;
    setPercentControl(settingsBloomStrength, settingsBloomStrengthValue, bloomStrength);
    setPercentControl(settingsGamma, settingsGammaValue, gamma);
    setPercentControl(settingsEnvironmentContrast, settingsEnvironmentContrastValue, environmentContrast);
    settingsMaterialDetail.value = materialDetail;
    settingsClarityPreset.value = clarityPreset;
    settingsDamageNumbers.checked = showDamageNumbers;
    settingsDirectionalIndicators.checked = showDirectionalIndicators;
    settingsDebugOverlay.checked = debugOverlayEnabled;
  }

  function commitSettingsUi(options: {
    applyVisual?: boolean;
    syncDebugVisibility?: boolean;
    syncTopChrome?: boolean;
  } = {}): void {
    const {
      applyVisual = false,
      syncDebugVisibility: shouldSyncDebugVisibility = false,
      syncTopChrome = false
    } = options;

    if (applyVisual) {
      applyVisualSettings();
    }
    if (shouldSyncDebugVisibility) {
      syncDebugVisibility();
    }

    syncSettingsControls();
    persistSettings(world.quality);

    if (syncTopChrome) {
      syncTopChromeOffsets();
    }
  }

  try {
    const rendererKind = await renderer.init({
      mount: gameRoot,
      requestedRenderer: options.rendererPreference,
      rendererPolicy,
      safariSafeMode,
      reducedMotion: prefersReducedMotion
    });

    world.setRendererKind(rendererKind);
    renderer.setQuality(world.quality);
    await renderer.prewarmVisualAssets();
    applyVisualSettings();
    persistSettings(world.quality);

    audio.setEnabled(audioEnabled);
    audio.setVolume(audioVolume);
    hudRenderer.textContent = rendererKind;
  } catch (error) {
    console.error(error);
    unsupportedPanel.classList.remove('hidden');
    bootScreen.classList.add('hidden');
    hud.classList.add('hidden');
    return;
  }

  syncDebugVisibility();

  syncTopChromeOffsets();
  if (typeof ResizeObserver !== 'undefined') {
    hudResizeObserver = new ResizeObserver(() => {
      syncTopChromeOffsets();
    });
    hudResizeObserver.observe(hud);
  }
  signal.addEventListener('abort', () => {
    hudResizeObserver?.disconnect();
    hudResizeObserver = null;
  }, { once: true });
  window.addEventListener('resize', syncTopChromeOffsets, { signal });

  const systems: ISystem<GameWorld>[] = [
    new RuntimeSystem(),
    new PlayerInputSystem(),
    new EnemyAISystem(),
    new AutoAttackSystem(),
    new SpawnSystem(),
    new XpSystem(),
    new MovementSystem(),
    new ProjectileSystem(),
    new CollisionSystem(),
    new LevelSystem(),
    new CleanupSystem()
  ];

  function renderChoiceButtons<T extends { id: string; title: string; description: string }>(
    grid: HTMLElement,
    choices: readonly T[],
    rarityForChoice: (choice: T) => string,
    onChoose: (choiceId: string) => void
  ): void {
    grid.innerHTML = '';

    choices.forEach((choice, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'upgrade-btn';
      button.dataset.rarity = rarityForChoice(choice);
      const title = document.createElement('strong');
      title.textContent = `${index + 1}. ${choice.title}`;
      const description = document.createElement('span');
      description.textContent = choice.description;
      button.append(title, description);
      button.addEventListener('click', () => {
        onChoose(choice.id);
      });
      grid.appendChild(button);
    });
  }

  function renderLevelChoices(): void {
    const signature = world.pendingLevelChoices.map((choice) => choice.id).join('|');
    if (signature === lastLevelSignature) return;

    lastLevelSignature = signature;
    renderChoiceButtons(
      upgradeGrid,
      world.pendingLevelChoices,
      (choice) => choiceRarity(choice),
      (choiceId) => {
        world.applyLevelChoice(choiceId);
        levelUpModal.classList.add('hidden');
      }
    );
  }

  function renderChestChoices(): void {
    const signature = world.pendingChestChoices.map((choice) => choice.id).join('|');
    if (signature === lastChestSignature) return;

    lastChestSignature = signature;
    renderChoiceButtons(
      chestGrid,
      world.pendingChestChoices,
      (choice) => choice.choiceType === 'evolve' ? 'legendary' : 'epic',
      (choiceId) => {
        world.applyChestChoice(choiceId);
        chestModal.classList.add('hidden');
      }
    );
  }

  function chooseLevelChoiceByIndex(index: number): void {
    if (world.uiState !== 'levelup') return;
    const choice = world.pendingLevelChoices[index];
    if (!choice) return;
    world.applyLevelChoice(choice.id);
    levelUpModal.classList.add('hidden');
  }

  function chooseChestChoiceByIndex(index: number): void {
    if (world.uiState !== 'chest') return;
    const choice = world.pendingChestChoices[index];
    if (!choice) return;
    world.applyChestChoice(choice.id);
    chestModal.classList.add('hidden');
  }

  function clearMovementInput(): void {
    world.input.up = false;
    world.input.down = false;
    world.input.left = false;
    world.input.right = false;
  }

  function getActiveHandbookSection(): HandbookSection {
    return handbookSections.find((section) => section.id === activeHelpSectionId) ?? handbookSections[0]!;
  }

  function renderHandbookTabs(): void {
    helpTabs.replaceChildren();
    for (const section of handbookSections) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `help-tab ${section.id === activeHelpSectionId ? 'active' : ''}`;
      button.textContent = section.title;
      button.addEventListener('click', () => {
        activeHelpSectionId = section.id;
        renderHandbookTabs();
        renderHandbookContent();
      });
      helpTabs.appendChild(button);
    }
  }

  function renderHandbookContent(): void {
    helpContent.replaceChildren();
    const query = helpSearch.value.trim().toLowerCase();
    const sectionFilter = query ? handbookSections : [getActiveHandbookSection()];
    const matches: Array<{ sectionTitle: string; title: string; description: string; tags: string[] }> = [];

    for (const section of sectionFilter) {
      for (const entry of section.entries) {
        const haystack = `${section.title} ${entry.title} ${entry.description} ${entry.tags.join(' ')}`.toLowerCase();
        if (query && !haystack.includes(query)) continue;
        matches.push({
          sectionTitle: section.title,
          title: entry.title,
          description: entry.description,
          tags: entry.tags
        });
      }
    }

    if (matches.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = query ? `No handbook entries found for "${helpSearch.value.trim()}".` : 'No handbook entries.';
      helpContent.appendChild(empty);
      return;
    }

    for (const entry of matches) {
      const card = document.createElement('article');
      card.className = 'help-entry';
      const title = document.createElement('strong');
      title.textContent = query ? `${entry.sectionTitle} · ${entry.title}` : entry.title;
      const description = document.createElement('p');
      description.textContent = entry.description;
      const tags = document.createElement('div');
      tags.className = 'help-entry-tags';
      tags.textContent = entry.tags.join(' • ');
      card.append(title, description, tags);
      helpContent.appendChild(card);
    }
  }

  function openHelp(): void {
    if (helpOpen) return;
    if (settingsOpen) closeSettings();
    helpOpen = true;
    helpPanel.classList.remove('hidden');
    renderHandbookTabs();
    renderHandbookContent();
    savedMovementInput = { ...world.input };
    clearMovementInput();
    if (world.uiState === 'playing') {
      pausedByHelp = true;
      pauseRun('Paused - Handbook Open');
    } else {
      pausedByHelp = false;
    }
    helpSearch.focus();
  }

  function closeHelp(): void {
    if (!helpOpen) return;
    helpOpen = false;
    helpPanel.classList.add('hidden');

    if (savedMovementInput) {
      Object.assign(world.input, savedMovementInput);
      savedMovementInput = null;
    }

    if (pausedByHelp && world.uiState === 'paused' && !document.hidden) {
      pausedByHelp = false;
      world.applyPostModalGrace(0.4, false);
      resumeRun();
    } else {
      pausedByHelp = false;
    }
  }

  function openSettings(): void {
    if (settingsOpen) return;
    if (helpOpen) closeHelp();
    settingsOpen = true;
    syncSettingsControls();
    settingsPanel.classList.remove('hidden');
    savedMovementInput = { ...world.input };
    clearMovementInput();

    if (world.uiState === 'playing') {
      pausedBySettings = true;
      pauseRun('Paused - Settings Open');
    } else {
      pausedBySettings = false;
    }
  }

  function closeSettings(): void {
    if (!settingsOpen) return;
    settingsOpen = false;
    settingsPanel.classList.add('hidden');

    if (savedMovementInput) {
      Object.assign(world.input, savedMovementInput);
      savedMovementInput = null;
    }

    if (pausedBySettings && world.uiState === 'paused' && !document.hidden) {
      pausedBySettings = false;
      world.applyPostModalGrace(0.5, false);
      resumeRun();
    } else {
      pausedBySettings = false;
    }
  }

  function setIfChanged(element: HTMLElement, next: string, key: HudStringCacheKey): void {
    if (hudCache[key] === next) return;
    hudCache[key] = next;
    element.textContent = next;
  }

  function syncHud(forceHeavy = false): void {
    const hudStart = performance.now();

    setIfChanged(
      hudHp,
      `${Math.ceil(world.playerStats.hp)} / ${Math.ceil(world.playerStats.maxHp)}`,
      'hp'
    );
    setIfChanged(hudLevel, String(world.level), 'level');
    setIfChanged(hudEnemies, String(world.getEnemyCount()), 'enemies');
    setIfChanged(hudTime, formatRunTime(world.runTime), 'time');
    setIfChanged(hudEvent, getRunEventLabel(world.activeEventId), 'event');
    setIfChanged(hudAudio, audioEnabled ? 'On' : 'Off', 'audio');
    hudEventChip.classList.toggle('event-active', world.activeEventId !== null);

    const nextEventDescription = getRunEventDescription(world.activeEventId);
    if (hudCache.eventDescription !== nextEventDescription) {
      hudCache.eventDescription = nextEventDescription;
      hudEventChip.title = nextEventDescription;
    }

    const hpRatio = world.playerStats.maxHp > 0 ? world.playerStats.hp / world.playerStats.maxHp : 1;
    hudHpChip.classList.toggle('danger', hpRatio <= 0.3);
    gameShell.classList.toggle('low-hp', hpRatio <= 0.3);
    const ratio = world.xpToNext > 0 ? Math.min(1, world.xp / world.xpToNext) : 0;
    const nextXpWidth = `${ratio * 100}%`;
    if (hudCache.xpWidth !== nextXpWidth) {
      hudCache.xpWidth = nextXpWidth;
      xpFill.style.width = nextXpWidth;
    }

    const now = performance.now();
    const shouldSyncHeavy = forceHeavy || now - lastHeavyHudSyncAt >= 100;
    if (shouldSyncHeavy) {
      lastHeavyHudSyncAt = now;

      for (const slot of world.inventorySlots) {
        const weapon = slot.itemId ? WEAPON_ARCHETYPES[slot.itemId] : null;
        const rarityClass = weapon?.rarity ?? 'common';
        const signature = `${slot.itemId ?? '-'}|${slot.rank}|${slot.isEvolved ? 1 : 0}|${rarityClass}`;
        if (hudCache.inventory[slot.slotIndex] === signature) continue;
        hudCache.inventory[slot.slotIndex] = signature;

        const tile = inventoryTiles[slot.slotIndex];
        const empty = !slot.itemId;
        tile.root.className = `build-slot ${empty ? 'empty' : ''} rarity-${rarityClass}`;
        tile.title.textContent = empty ? `Slot ${slot.slotIndex + 1}` : `S${slot.slotIndex + 1}: ${weapon?.name ?? slot.itemId}`;
        tile.subtitle.textContent = empty ? 'Empty' : `Rank ${slot.rank}${slot.isEvolved ? ' • Evolved' : ''}`;
      }

      const catalystEntries = Array.from(world.catalystRanks.entries()).sort(([a], [b]) => a.localeCompare(b));
      const catalystSignature = catalystEntries.map(([id, rank]) => `${id}:${rank}`).join('|');
      if (hudCache.catalysts !== catalystSignature) {
        hudCache.catalysts = catalystSignature;
        catalystBar.replaceChildren();
        if (catalystEntries.length === 0) {
          const tile = createBuildSlotTile();
          tile.root.className = 'build-slot empty';
          tile.title.textContent = 'Catalysts';
          tile.subtitle.textContent = 'None yet';
          catalystBar.appendChild(tile.root);
        } else {
          for (const [id, rank] of catalystEntries) {
            const catalyst = CATALYST_DEFINITIONS[id];
            const tile = createBuildSlotTile();
            const rarityClass = catalyst?.rarity === 'epic' ? 'legendary' : catalyst?.rarity ?? 'common';
            tile.root.className = `build-slot rarity-${rarityClass}`;
            tile.title.textContent = catalyst?.name ?? id;
            tile.subtitle.textContent = `Rank ${rank}`;
            catalystBar.appendChild(tile.root);
          }
        }
      }

      const readyCount = world.getEvolutionCandidates().length;
      const evolutionLabel = readyCount > 0 ? `${readyCount} Ready` : 'None';
      if (hudCache.evolutionReady !== evolutionLabel) {
        hudCache.evolutionReady = evolutionLabel;
        hudEvolutionReady.textContent = evolutionLabel;
      }
      hudEvolutionReady.classList.toggle('active', readyCount > 0);
    }

    hudSyncMs = performance.now() - hudStart;
    renderer.setHudSyncTime(hudSyncMs);
  }

  function syncAudioCues(): void {
    if (world.shotsFired > previousShotsFired) {
      const delta = Math.min(4, world.shotsFired - previousShotsFired);
      for (let i = 0; i < delta; i += 1) {
        audio.playShot();
      }
    }

    if (world.playerHitCount > previousPlayerHitCount) {
      audio.playPlayerHit();
    }

    if (world.levelUpOfferedCount > previousLevelUpOfferedCount) {
      audio.playLevelUp();
    }

    if (world.eliteKills > previousEliteKills) {
      audio.playEventStart();
    }

    if (world.activeEventId !== previousEventId && world.activeEventId) {
      audio.playEventStart();
    }

    if (previousUiState !== 'gameover' && world.uiState === 'gameover') {
      audio.playGameOver();
    }

    previousShotsFired = world.shotsFired;
    previousPlayerHitCount = world.playerHitCount;
    previousLevelUpOfferedCount = world.levelUpOfferedCount;
    previousEliteKills = world.eliteKills;
    previousEventId = world.activeEventId;
    previousUiState = world.uiState;
  }

  function syncUiState(): void {
    pauseBanner.classList.toggle('hidden', world.uiState !== 'paused');
    settingsToggleBtn.classList.toggle('hidden', world.uiState === 'boot' || world.uiState === 'gameover');
    helpToggleBtn.classList.toggle('hidden', world.uiState === 'boot' || world.uiState === 'gameover');

    if (world.uiState === 'levelup') {
      renderLevelChoices();
      levelUpModal.classList.remove('hidden');
    } else {
      levelUpModal.classList.add('hidden');
      lastLevelSignature = '';
    }

    if (world.uiState === 'chest') {
      renderChestChoices();
      chestModal.classList.remove('hidden');
    } else {
      chestModal.classList.add('hidden');
      lastChestSignature = '';
    }

    if (world.uiState === 'gameover') {
      gameOverModal.classList.remove('hidden');
      runSummary.textContent = world.toRunSummaryText();
    } else {
      gameOverModal.classList.add('hidden');
    }
  }

  function syncDebug(stats: LoopStats): void {
    if (!debugOverlayEnabled) return;

    const enemyPoolStats = world.enemyPool.getStats();
    const projectilePoolStats = world.projectilePool.getStats();
    const enemyProjectilePoolStats = world.enemyProjectilePool.getStats();
    const hazardPoolStats = world.hazardPool.getStats();
    const chestPoolStats = world.chestPool.getStats();
    const xpPoolStats = world.xpPool.getStats();
    const evolutionsReady = world.getEvolutionCandidates();
    const perf = renderer.getPerformanceSnapshot();
    const readability = renderer.getReadabilitySnapshot();

    debugPanel.textContent = [
      `seed: ${world.seed}`,
      `ui: ${world.uiState}`,
      `renderer: ${world.rendererKind}`,
      `audio: ${audioEnabled ? 'on' : 'off'}`,
      `volume: ${Math.round(audioVolume * 100)}%`,
      `motion: ${Math.round(motionScale * 100)}%`,
      `fps: ${stats.fps.toFixed(1)}`,
      `frame: ${stats.smoothedFrameTimeMs.toFixed(2)}ms`,
      `update: ${stats.updateMs.toFixed(2)}ms / steps ${stats.updateSteps}`,
      `quality: ${world.quality}`,
      `budget tier: ${perf.budgetTier}`,
      `render p50/p95: ${perf.rolling.p50FrameMs.toFixed(2)} / ${perf.rolling.p95FrameMs.toFixed(2)}ms`,
      `render timings: b${perf.timings.backdropMs.toFixed(2)} e${perf.timings.entitiesMs.toFixed(2)} o${perf.timings.overlaysMs.toFixed(2)} h${perf.timings.hudSyncMs.toFixed(2)} t${perf.timings.totalMs.toFixed(2)}`,
      `passes: g${perf.passes.gbufferMs.toFixed(2)} c${perf.passes.lightCullMs.toFixed(2)} l${perf.passes.lightShadeMs.toFixed(2)} f${perf.passes.fogMs.toFixed(2)} x${perf.passes.compositeMs.toFixed(2)}`,
      `visible/culled: ${perf.visibleEntities}/${perf.culledEntities}`,
      `lights/casters: ${perf.activeLights}/${perf.activeShadowCasters}`,
      `draw calls est: ${perf.drawCallsEstimate}`,
      `hud sync: ${hudSyncMs.toFixed(2)}ms`,
      `visual: ${colorVisionMode}, ui ${Math.round(uiScale * 100)}%, shake ${Math.round(screenShake * 100)}%, hazard ${Math.round(hazardOpacity * 100)}%, bloom ${Math.round(bloomStrength * 100)}%`,
      `scene: ${sceneStyle} / readability ${combatReadabilityMode} / outline ${enemyOutlineStrength.toFixed(2)} / bg ${backgroundDensity.toFixed(2)} / atmosphere ${atmosphereStrength.toFixed(2)}`,
      `suppression: ${readability.activeSuppressionTier} (${readability.threatLevel.toFixed(2)})`,
      `lighting: ${lightingQuality} / shadows ${shadowQuality} / fog ${fogQuality} / gamma ${gamma.toFixed(2)} / contrast ${environmentContrast.toFixed(2)} / material ${materialDetail}`,
      `textures: ${textureDetail} / aa ${edgeAntialiasing} / profile ${resolutionProfile} / scale ${resolutionScale.toFixed(2)} / softness ${postFxSoftness.toFixed(2)} / ultra lock ${desktopUltraLock ? 'on' : 'off'}`,
      `resolution: target ${perf.targetResolution.toFixed(2)} / pixels ${(perf.pixelCount / 1_000_000).toFixed(2)}MP`,
      `canvas ratio: ${perf.actualCanvasToCssRatio.toFixed(2)} / lighting samples ${perf.lightingSampleCount}`,
      `backdrop cache/cards: ${perf.backdropChunkCount}/${perf.backdropCardsDrawn}`,
      `backdrop cmd est: ${perf.backdropDrawCommandsEstimate} / update ms ${perf.updateMs.toFixed(2)} / steps ${perf.updateSteps}`,
      `event: ${world.activeEventId ?? 'none'}`,
      `phase: ${world.director.phaseId}`,
      `intensity: ${world.director.intensity.toFixed(2)}`,
      `heat: ${world.director.heat.toFixed(2)}`,
      `target enemies: ${world.director.targetEnemies}`,
      `target threat: ${world.director.targetThreat.toFixed(1)}`,
      `entities: ${world.entities.size}`,
      `threat: ${world.threatLevel.toFixed(1)}`,
      `enemy shots: ${world.enemyShotsFired}`,
      `hazards: ${world.hazards.size}`,
      `chests: ${world.chests.size}`,
      `evolutions ready: ${evolutionsReady.length}`,
      `inventory: ${world.inventorySlots.map((slot) => `${slot.slotIndex + 1}:${slot.itemId ?? '-'}:${slot.rank}${slot.isEvolved ? '*' : ''}`).join(' | ')}`,
      `catalysts: ${Array.from(world.catalystRanks.entries()).map(([id, rank]) => `${id}:${rank}`).join(', ') || 'none'}`,
      `enemy pool: ${enemyPoolStats.available}/${enemyPoolStats.total}`,
      `proj pool: ${projectilePoolStats.available}/${projectilePoolStats.total}`,
      `enemy proj pool: ${enemyProjectilePoolStats.available}/${enemyProjectilePoolStats.total}`,
      `hazard pool: ${hazardPoolStats.available}/${hazardPoolStats.total}`,
      `chest pool: ${chestPoolStats.available}/${chestPoolStats.total}`,
      `xp pool: ${xpPoolStats.available}/${xpPoolStats.total}`
    ].join('\n');
  }

  function showCopySeedFeedback(): void {
    copySeedBtn.textContent = 'Seed Copied';
    window.setTimeout(() => {
      copySeedBtn.textContent = 'Copy Seed';
    }, 1200);
  }

  function startRun(seed = world.seed): void {
    void audio.unlock();
    world.resetRun(seed);
    settingsOpen = false;
    helpOpen = false;
    pausedBySettings = false;
    pausedByHelp = false;
    settingsPanel.classList.add('hidden');
    helpPanel.classList.add('hidden');
    helpSearch.value = '';
    copySeedBtn.textContent = 'Copy Seed';
    previousShotsFired = world.shotsFired;
    previousPlayerHitCount = world.playerHitCount;
    previousLevelUpOfferedCount = world.levelUpOfferedCount;
    previousEliteKills = world.eliteKills;
    previousEventId = world.activeEventId;
    previousUiState = world.uiState;
    lastHeavyHudSyncAt = 0;
    bootScreen.classList.add('hidden');
    gameOverModal.classList.add('hidden');
    levelUpModal.classList.add('hidden');
    chestModal.classList.add('hidden');
    pauseBanner.classList.add('hidden');
    hud.classList.remove('hidden');
    syncHud(true);
    syncTopChromeOffsets();
    loop.resetAccumulator();
  }

  function pauseRun(message = 'Paused - Press Esc to Resume'): void {
    if (world.uiState !== 'playing') return;
    world.uiState = 'paused';
    pauseBanner.textContent = message;
    pauseBanner.classList.remove('hidden');
  }

  function resumeRun(): void {
    if (world.uiState !== 'paused') return;
    world.uiState = 'playing';
    pauseBanner.textContent = DEFAULT_PAUSE_MESSAGE;
    pauseBanner.classList.add('hidden');
    loop.resetAccumulator();
  }

  function stepSimulation(dt: number): void {
    if (world.uiState !== 'playing') return;
    syncViewportMetrics();
    for (const system of systems) {
      system.update(dt, world);
      if (world.uiState !== 'playing') break;
    }
  }

  function renderFrame(stats: LoopStats): void {
    syncViewportMetrics();
    const nextQuality = chooseQuality(stats.smoothedFrameTimeMs, world.quality);
    if (nextQuality !== world.quality) {
      world.setQuality(nextQuality);
      renderer.setQuality(nextQuality);
      persistSettings(nextQuality);
    }

    renderer.setUpdateTelemetry(stats.updateMs, stats.updateSteps);
    renderer.render(world, 0, stats.smoothedFrameTimeMs);
    syncAudioCues();
    syncHud();
    syncUiState();
    syncDebug(stats);
  }

  const loop = new FixedStepLoop({
    fixedDelta: world.config.fixedDelta,
    maxDelta: world.config.maxDelta,
    maxSubSteps: 3,
    onUpdate: (dt) => stepSimulation(dt),
    onRender: (_alpha, stats) => renderFrame(stats)
  });

  function buildTextState(): string {
    const playerPos = world.getPlayerPosition();
    const playerVel = world.velocities.get(world.playerId) || { x: 0, y: 0 };

    const sortByDistanceToPlayer = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const da = (a.x - playerPos.x) ** 2 + (a.y - playerPos.y) ** 2;
      const db = (b.x - playerPos.x) ** 2 + (b.y - playerPos.y) ** 2;
      return da - db;
    };

    const enemies = Array.from(world.enemies)
      .map((enemyId) => {
        const pos = world.positions.get(enemyId);
        const comp = world.enemyComponents.get(enemyId);
        const health = world.health.get(enemyId);
        if (!pos || !comp || !health) return null;
        return {
          id: enemyId,
          x: Number(pos.x.toFixed(1)),
          y: Number(pos.y.toFixed(1)),
          archetype: comp.archetypeId,
          behavior: comp.behavior,
          hp: Number(health.hp.toFixed(1)),
          spitCooldown: Number(comp.spitCooldown.toFixed(2)),
          dashWindup: Number(comp.dashWindup.toFixed(2)),
          dashDuration: Number(comp.dashDuration.toFixed(2))
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort(sortByDistanceToPlayer)
      .slice(0, 28);

    const enemyProjectiles = Array.from(world.enemyProjectiles)
      .map((projectileId) => {
        const pos = world.positions.get(projectileId);
        const data = world.enemyProjectileComponents.get(projectileId);
        if (!pos || !data) return null;
        return {
          id: projectileId,
          x: Number(pos.x.toFixed(1)),
          y: Number(pos.y.toFixed(1)),
          ttl: Number(Math.max(0, data.lifetime - data.age).toFixed(2))
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort(sortByDistanceToPlayer)
      .slice(0, 28);

    const hazards = Array.from(world.hazards)
      .map((hazardId) => {
        const pos = world.positions.get(hazardId);
        const data = world.hazardComponents.get(hazardId);
        const radius = world.radii.get(hazardId);
        if (!pos || !data || radius === undefined) return null;
        return {
          id: hazardId,
          x: Number(pos.x.toFixed(1)),
          y: Number(pos.y.toFixed(1)),
          r: Number(radius.toFixed(1)),
          ttl: Number(Math.max(0, data.lifetime - data.age).toFixed(2))
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort(sortByDistanceToPlayer)
      .slice(0, 28);

    const chests = Array.from(world.chests)
      .map((chestId) => {
        const pos = world.positions.get(chestId);
        if (!pos) return null;
        return {
          id: chestId,
          x: Number(pos.x.toFixed(1)),
          y: Number(pos.y.toFixed(1))
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort(sortByDistanceToPlayer)
      .slice(0, 12);

    const inventory = world.inventorySlots.map((slot) => ({
      slot: slot.slotIndex + 1,
      itemId: slot.itemId,
      rank: slot.rank,
      evolved: slot.isEvolved
    }));

    const catalysts = Array.from(world.catalystRanks.entries()).map(([id, rank]) => ({ id, rank }));
    const renderPerf = renderer.getPerformanceSnapshot();

    return JSON.stringify({
      coordinateSystem: 'World space with origin at player spawn (0,0), +x right, +y down.',
      uiState: world.uiState,
      overlays: {
        settingsOpen,
        helpOpen
      },
      timerSeconds: Number(world.runTime.toFixed(2)),
      player: {
        x: Number(playerPos.x.toFixed(1)),
        y: Number(playerPos.y.toFixed(1)),
        vx: Number(playerVel.x.toFixed(1)),
        vy: Number(playerVel.y.toFixed(1)),
        hp: Number(world.playerStats.hp.toFixed(1)),
        maxHp: Number(world.playerStats.maxHp.toFixed(1)),
        level: world.level,
        xp: Number(world.xp.toFixed(1)),
        xpToNext: Number(world.xpToNext.toFixed(1))
      },
      director: {
        phase: world.director.phaseId,
        intensity: Number(world.director.intensity.toFixed(2)),
        heat: Number(world.director.heat.toFixed(2)),
        targetEnemies: world.director.targetEnemies,
        targetThreat: Number(world.director.targetThreat.toFixed(1))
      },
      visualSettings: {
        rendererPolicy,
        safariSafeMode,
        colorVisionMode,
        sceneStyle,
        combatReadabilityMode,
        uiScale: Number(uiScale.toFixed(2)),
        screenShake: Number(screenShake.toFixed(2)),
        hazardOpacity: Number(hazardOpacity.toFixed(2)),
        hitFlashStrength: Number(hitFlashStrength.toFixed(2)),
        enemyOutlineStrength: Number(enemyOutlineStrength.toFixed(2)),
        backgroundDensity: Number(backgroundDensity.toFixed(2)),
        atmosphereStrength: Number(atmosphereStrength.toFixed(2)),
        showDirectionalIndicators,
        lightingQuality,
        shadowQuality,
        fogQuality,
        bloomStrength: Number(bloomStrength.toFixed(2)),
        gamma: Number(gamma.toFixed(2)),
        environmentContrast: Number(environmentContrast.toFixed(2)),
        materialDetail,
        clarityPreset,
        textureDetail,
        edgeAntialiasing,
        resolutionProfile,
        resolutionScale: Number(resolutionScale.toFixed(2)),
        postFxSoftness: Number(postFxSoftness.toFixed(2)),
        desktopUltraLock
      },
      renderPerf,
      readability: renderer.getReadabilitySnapshot(),
      viewport: world.viewport,
      inventory,
      catalysts,
      evolutionCandidates: world.getEvolutionCandidates(),
      counts: {
        enemies: world.enemies.size,
        enemyProjectiles: world.enemyProjectiles.size,
        hazards: world.hazards.size,
        chests: world.chests.size,
        xpOrbs: world.xpOrbs.size
      },
      event: world.activeEventId,
      renderer: world.rendererKind,
      quality: world.quality,
      enemies,
      enemyProjectiles,
      hazards,
      chests
    });
  }

  function installTestingHooks(): void {
    const testWindow = window as Window & {
      render_game_to_text?: () => string;
      advanceTime?: (ms: number) => void;
    };

    testWindow.render_game_to_text = () => buildTextState();
    testWindow.advanceTime = (ms: number) => {
      const boundedMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
      const stepMs = world.config.fixedDelta * 1000;
      const steps = Math.max(1, Math.round(boundedMs / stepMs));
      for (let i = 0; i < steps; i += 1) {
        stepSimulation(world.config.fixedDelta);
      }

      const frameMs = steps > 0 ? Math.max(1, boundedMs / steps) : stepMs;
      renderFrame({
        frameTimeMs: frameMs,
        smoothedFrameTimeMs: frameMs,
        fps: 1000 / frameMs,
        updateMs: frameMs,
        updateSteps: steps
      });
    };
  }

  installTestingHooks();
  loop.start();

  startGameBtn.addEventListener('click', () => {
    startRun(world.seed);
  });

  restartRunBtn.addEventListener('click', () => {
    startRun(world.seed);
  });

  settingsToggleBtn.addEventListener('click', () => {
    if (settingsOpen) {
      closeSettings();
    } else {
      openSettings();
    }
  });

  helpToggleBtn.addEventListener('click', () => {
    if (helpOpen) {
      closeHelp();
    } else {
      openHelp();
    }
  });

  helpCloseBtn.addEventListener('click', () => {
    closeHelp();
  });

  helpPanel.addEventListener('click', (event) => {
    if (event.target === helpPanel) {
      closeHelp();
    }
  });

  helpSearch.addEventListener('input', () => {
    renderHandbookContent();
  });

  settingsCloseBtn.addEventListener('click', () => {
    closeSettings();
  });

  settingsPanel.addEventListener('click', (event) => {
    if (event.target === settingsPanel) {
      closeSettings();
    }
  });

  copySeedBtn.addEventListener('click', async () => {
    const seedText = String(world.seed);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(seedText);
        showCopySeedFeedback();
        return;
      }
    } catch {
      // fallback below
    }

    const temp = document.createElement('textarea');
    temp.value = seedText;
    temp.setAttribute('readonly', 'true');
    temp.style.position = 'absolute';
    temp.style.left = '-9999px';
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    temp.remove();
    showCopySeedFeedback();
  });

  settingsAudioEnabled.addEventListener('change', () => {
    audioEnabled = settingsAudioEnabled.checked;
    audio.setEnabled(audioEnabled);
    if (audioEnabled) {
      void audio.unlock();
    }
    commitSettingsUi();
  });

  settingsAudioVolume.addEventListener('input', () => {
    audioVolume = clamp(Number(settingsAudioVolume.value) / 100, 0, 1);
    audio.setVolume(audioVolume);
    commitSettingsUi();
  });

  settingsMotionIntensity.addEventListener('input', () => {
    motionScale = clamp(Number(settingsMotionIntensity.value) / 100, 0, 1);
    commitSettingsUi({ applyVisual: true });
  });

  settingsTextureDetail.addEventListener('change', () => {
    textureDetail = parseTextureDetail(settingsTextureDetail.value);
    commitSettingsUi({ applyVisual: true });
  });

  settingsEdgeAntialiasing.addEventListener('change', () => {
    edgeAntialiasing = parseEdgeAntialiasingMode(settingsEdgeAntialiasing.value);
    commitSettingsUi({ applyVisual: true });
  });

  settingsDesktopUltraLock.addEventListener('change', () => {
    desktopUltraLock = settingsDesktopUltraLock.checked;
    commitSettingsUi({ applyVisual: true });
  });

  settingsColorVision.addEventListener('change', () => {
    colorVisionMode = parseColorVisionMode(settingsColorVision.value);
    commitSettingsUi({ applyVisual: true });
  });

  settingsCombatReadabilityMode.addEventListener('change', () => {
    combatReadabilityMode = parseCombatReadabilityMode(settingsCombatReadabilityMode.value);
    commitSettingsUi({ applyVisual: true });
  });

  settingsUiScale.addEventListener('input', () => {
    uiScale = clamp(Number(settingsUiScale.value) / 100, 0.9, 1.25);
    commitSettingsUi({ applyVisual: true, syncTopChrome: true });
  });

  settingsScreenShake.addEventListener('input', () => {
    screenShake = clamp(Number(settingsScreenShake.value) / 100, 0, 1);
    commitSettingsUi({ applyVisual: true });
  });

  settingsHazardOpacity.addEventListener('input', () => {
    hazardOpacity = clamp(Number(settingsHazardOpacity.value) / 100, 0.45, 1);
    commitSettingsUi({ applyVisual: true });
  });

  settingsHitFlashStrength.addEventListener('input', () => {
    hitFlashStrength = clamp(Number(settingsHitFlashStrength.value) / 100, 0, 1);
    commitSettingsUi({ applyVisual: true });
  });

  settingsEnemyOutlineStrength.addEventListener('input', () => {
    enemyOutlineStrength = clamp(Number(settingsEnemyOutlineStrength.value) / 100, 0.5, 1.5);
    commitSettingsUi({ applyVisual: true });
  });

  settingsBackgroundDensity.addEventListener('input', () => {
    backgroundDensity = clamp(Number(settingsBackgroundDensity.value) / 100, 0.25, 1);
    commitSettingsUi({ applyVisual: true });
  });

  settingsAtmosphereStrength.addEventListener('input', () => {
    atmosphereStrength = clamp(Number(settingsAtmosphereStrength.value) / 100, 0, 1);
    commitSettingsUi({ applyVisual: true });
  });

  settingsLightingQuality.addEventListener('change', () => {
    lightingQuality = parseLightingQuality(settingsLightingQuality.value);
    commitSettingsUi({ applyVisual: true });
  });

  settingsShadowQuality.addEventListener('change', () => {
    shadowQuality = parseShadowQuality(settingsShadowQuality.value);
    commitSettingsUi({ applyVisual: true });
  });

  settingsFogQuality.addEventListener('change', () => {
    fogQuality = parseFogQuality(settingsFogQuality.value);
    commitSettingsUi({ applyVisual: true });
  });

  settingsBloomStrength.addEventListener('input', () => {
    bloomStrength = clamp(Number(settingsBloomStrength.value) / 100, 0, 1);
    commitSettingsUi({ applyVisual: true });
  });

  settingsGamma.addEventListener('input', () => {
    gamma = clamp(Number(settingsGamma.value) / 100, 0.85, 1.2);
    commitSettingsUi({ applyVisual: true });
  });

  settingsEnvironmentContrast.addEventListener('input', () => {
    environmentContrast = clamp(Number(settingsEnvironmentContrast.value) / 100, 0.8, 1.25);
    commitSettingsUi({ applyVisual: true });
  });

  settingsMaterialDetail.addEventListener('change', () => {
    materialDetail = parseMaterialDetail(settingsMaterialDetail.value);
    commitSettingsUi({ applyVisual: true });
  });

  settingsClarityPreset.addEventListener('change', () => {
    clarityPreset = parseClarityPreset(settingsClarityPreset.value);
    if (clarityPreset === 'cinematic') {
      lightingQuality = 'cinematic';
      shadowQuality = 'soft';
      fogQuality = 'volumetric';
      bloomStrength = Math.max(0.68, bloomStrength);
      postFxSoftness = Math.max(0.45, postFxSoftness);
      resolutionProfile = 'quality';
      environmentContrast = Math.max(1, environmentContrast);
      combatReadabilityMode = 'off';
      backgroundDensity = Math.max(backgroundDensity, 0.88);
      atmosphereStrength = Math.max(atmosphereStrength, 0.8);
    } else if (clarityPreset === 'competitive') {
      lightingQuality = 'medium';
      shadowQuality = 'hard';
      fogQuality = 'layered';
      bloomStrength = Math.min(0.35, bloomStrength);
      postFxSoftness = Math.min(0.08, postFxSoftness);
      resolutionProfile = 'performance';
      environmentContrast = Math.max(1.12, environmentContrast);
      hitFlashStrength = Math.min(hitFlashStrength, 0.65);
      combatReadabilityMode = 'always_on';
      backgroundDensity = Math.min(backgroundDensity, 0.46);
      atmosphereStrength = Math.min(atmosphereStrength, 0.34);
      enemyOutlineStrength = Math.max(enemyOutlineStrength, 1.2);
    } else {
      lightingQuality = 'high';
      shadowQuality = 'soft';
      fogQuality = 'volumetric';
      bloomStrength = clamp(bloomStrength, 0.45, 0.75);
      postFxSoftness = clamp(postFxSoftness, 0.1, 0.25);
      resolutionProfile = 'balanced';
      environmentContrast = clamp(environmentContrast, 0.95, 1.15);
      combatReadabilityMode = 'auto';
      backgroundDensity = clamp(backgroundDensity, 0.6, 0.84);
      atmosphereStrength = clamp(atmosphereStrength, 0.45, 0.72);
    }
    commitSettingsUi({ applyVisual: true });
  });

  settingsDamageNumbers.addEventListener('change', () => {
    showDamageNumbers = settingsDamageNumbers.checked;
    commitSettingsUi({ applyVisual: true });
  });

  settingsDirectionalIndicators.addEventListener('change', () => {
    showDirectionalIndicators = settingsDirectionalIndicators.checked;
    commitSettingsUi({ applyVisual: true });
  });

  settingsDebugOverlay.addEventListener('change', () => {
    debugOverlayEnabled = settingsDebugOverlay.checked;
    commitSettingsUi({ syncDebugVisibility: true });
  });

  settingsPresetPainterlyBalanced.addEventListener('click', () => {
    sceneStyle = parseSceneStyle('painterly_forest');
    combatReadabilityMode = 'auto';
    enemyOutlineStrength = 1.05;
    backgroundDensity = 0.72;
    atmosphereStrength = 0.58;
    lightingQuality = 'high';
    shadowQuality = 'soft';
    fogQuality = 'layered';
    bloomStrength = clamp(bloomStrength, 0.38, 0.6);
    resolutionProfile = 'balanced';
    resolutionScale = 1;
    postFxSoftness = clamp(postFxSoftness, 0.12, 0.2);
    clarityPreset = 'balanced';
    commitSettingsUi({ applyVisual: true });
  });

  settingsPresetPainterlyCombat.addEventListener('click', () => {
    sceneStyle = parseSceneStyle('painterly_forest');
    combatReadabilityMode = 'always_on';
    enemyOutlineStrength = 1.32;
    backgroundDensity = 0.42;
    atmosphereStrength = 0.26;
    lightingQuality = 'medium';
    shadowQuality = 'hard';
    fogQuality = 'off';
    bloomStrength = Math.min(0.3, bloomStrength);
    resolutionProfile = 'performance';
    resolutionScale = Math.min(resolutionScale, 0.92);
    postFxSoftness = Math.min(0.08, postFxSoftness);
    clarityPreset = 'competitive';
    commitSettingsUi({ applyVisual: true });
  });

  settingsRendererPreference.addEventListener('change', () => {
    preferredRenderer = parseRendererPreference(settingsRendererPreference.value);
    persistSettings(world.quality);
  });

  settingsApplyRendererBtn.addEventListener('click', () => {
    persistSettings(world.quality);
    const url = new URL(window.location.href);
    url.searchParams.set('renderer', preferredRenderer);
    window.location.assign(url.toString());
  });

  syncSettingsControls();
  applyVisualSettings();
  syncHud(true);

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const movementFlag = keyToMovementFlag(key);
    const restartShortcutAllowed =
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !isEditableTarget(event.target);

    if (settingsOpen) {
      const targetAllowsNativeHandling = isEditableTarget(event.target);
      if (key === 'escape' || shouldHandleOverlayCloseShortcut(key, 'o', targetAllowsNativeHandling)) {
        closeSettings();
        event.preventDefault();
      } else if (
        shouldSuppressOverlayGameplayKey({
          key,
          movementKeyActive: movementFlag !== null,
          targetAllowsNativeHandling
        })
      ) {
        event.preventDefault();
      }
      return;
    }

    if (helpOpen) {
      const targetAllowsNativeHandling = isEditableTarget(event.target);
      if (key === 'escape' || shouldHandleOverlayCloseShortcut(key, 'h', targetAllowsNativeHandling)) {
        closeHelp();
        event.preventDefault();
      } else if (
        shouldSuppressOverlayGameplayKey({
          key,
          movementKeyActive: movementFlag !== null,
          targetAllowsNativeHandling
        })
      ) {
        event.preventDefault();
      }
      return;
    }

    if (key === 'o') {
      openSettings();
      event.preventDefault();
      return;
    }

    if (key === 'h') {
      openHelp();
      event.preventDefault();
      return;
    }

    if (movementFlag) {
      world.input[movementFlag] = true;
      event.preventDefault();
      return;
    }

    if (key === 'escape') {
      if (world.uiState === 'playing') {
        pauseRun();
      } else if (world.uiState === 'paused') {
        resumeRun();
      }
      event.preventDefault();
      return;
    }

    if (key === 'm') {
      audioEnabled = !audioEnabled;
      audio.setEnabled(audioEnabled);
      if (audioEnabled) {
        void audio.unlock();
      }
      commitSettingsUi();
      event.preventDefault();
      return;
    }

    const restartAction = resolveRestartAction({
      key,
      shiftKey: event.shiftKey,
      isRepeat: event.repeat,
      shortcutAllowed: restartShortcutAllowed,
      context: world.uiState
    });
    if (restartAction === 'restart_same_seed') {
      startRun(world.seed);
      event.preventDefault();
      return;
    }
    if (restartAction === 'restart_new_seed') {
      startRun(createRandomSeed());
      event.preventDefault();
      return;
    }

    if (world.uiState === 'levelup') {
      if (key === '1') chooseLevelChoiceByIndex(0);
      if (key === '2') chooseLevelChoiceByIndex(1);
      if (key === '3') chooseLevelChoiceByIndex(2);
      if (key === ' ') chooseLevelChoiceByIndex(0);
      event.preventDefault();
      return;
    }

    if (world.uiState === 'chest') {
      if (key === '1') chooseChestChoiceByIndex(0);
      if (key === '2') chooseChestChoiceByIndex(1);
      if (key === '3') chooseChestChoiceByIndex(2);
      if (key === ' ') chooseChestChoiceByIndex(0);
      event.preventDefault();
      return;
    }

    if (world.uiState === 'boot' && (key === 'enter' || key === ' ')) {
      startRun(world.seed);
      event.preventDefault();
      return;
    }

  }, { signal });

  window.addEventListener('keyup', (event) => {
    const movementFlag = keyToMovementFlag(event.key.toLowerCase());
    if (!movementFlag) return;
    world.input[movementFlag] = false;
  }, { signal });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (world.uiState === 'playing') {
        pausedByVisibility = true;
        pauseRun('Paused - Tab hidden');
      }
      return;
    }

    if (!document.hidden && pausedByVisibility && world.uiState === 'paused') {
      pausedByVisibility = false;
      resumeRun();
    }
  }, { signal });

  const canvas = renderer.getCanvas();
  if (canvas) {
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      pauseRun('Context lost - waiting for restore');
    }, { signal });

    canvas.addEventListener('webglcontextrestored', () => {
      resumeRun();
    }, { signal });
  }
}

main().catch((error) => {
  console.error('Fatal error while booting Forest Arcana:', error);
});

// Abort global listeners when Vite HMR disposes this module to prevent accumulation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(import.meta as any).hot?.dispose?.(() => _mainTeardown?.abort());
