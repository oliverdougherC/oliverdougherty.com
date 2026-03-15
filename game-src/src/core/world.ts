import { CATALYST_DEFINITIONS } from '../data/catalysts';
import { EVOLUTION_RECIPES } from '../data/evolutions';
import { ENEMY_ARCHETYPES } from '../data/enemies';
import { STARTING_WEAPON_ID, WEAPON_ARCHETYPES } from '../data/weapons';
import type {
  CatalystDefinition,
  ChestChoice,
  EnemyArchetype,
  EnemyBehavior,
  EntityKind,
  GameConfig,
  HazardTeam,
  InventorySlot,
  LevelUpChoice,
  PlayerStats,
  QualityTier,
  RendererKind,
  RunDirectorState,
  UIState,
  Vec2,
  ViewportMetrics
} from '../types';
import { NumericIdPool } from './objectPool';
import { xpThresholdForLevel } from './progression';
import { SeededRng, normalizeSeed } from './rng';
import { SpatialHash } from './spatialHash';

interface EnemyComponent {
  archetypeId: string;
  behavior: EnemyBehavior;
  speed: number;
  touchDamage: number;
  xpDrop: number;
  dashCooldown: number;
  dashWindup: number;
  dashDuration: number;
  dashDirection: Vec2;
  spitCooldown: number;
}

interface ProjectileComponent {
  damage: number;
  age: number;
  lifetime: number;
  pierce: number;
  hitEnemyIds: Set<number>;
  weaponId: string;
  colorHex: number;
  hazardRadius: number;
  hazardDuration: number;
  hazardDamagePerSecond: number;
}

interface EnemyProjectileComponent {
  damage: number;
  age: number;
  lifetime: number;
  hazardRadius: number;
  hazardDuration: number;
  hazardDamagePerSecond: number;
}

interface HazardComponent {
  damagePerSecond: number;
  age: number;
  lifetime: number;
  team: HazardTeam;
  armDelay: number;
}

interface ChestComponent {
  age: number;
  lifetime: number;
  guaranteedEvolution: boolean;
}

interface XpComponent {
  value: number;
}

interface HealthComponent {
  hp: number;
  maxHp: number;
}

interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export interface EnemyProjectileSpawnConfig {
  speed: number;
  lifetime: number;
  radius: number;
  damage: number;
  hazardRadius: number;
  hazardDuration: number;
  hazardDamagePerSecond: number;
}

export interface HazardSpawnConfig {
  radius: number;
  duration: number;
  damagePerSecond: number;
  team: HazardTeam;
  armDelay?: number;
}

export interface PlayerProjectileSpawnConfig {
  direction: Vec2;
  weaponId: string;
  speed: number;
  lifetime: number;
  radius: number;
  damage: number;
  pierce: number;
  colorHex: number;
  hazardRadius?: number;
  hazardDuration?: number;
  hazardDamagePerSecond?: number;
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  fieldWidth: 5800,
  fieldHeight: 5800,
  fixedDelta: 1 / 60,
  maxDelta: 0.2,
  enemyDespawnRadius: 1700,
  collisionCellSize: 96,
  maxNarrowPhaseChecks: 14000
};

function createDefaultPlayerStats(): PlayerStats {
  return {
    maxHp: 210,
    hp: 210,
    moveSpeed: 274,
    pickupRadius: 88,
    regenPerSecond: 0.35,
    contactInvuln: 0.48,
    damageMultiplier: 1,
    cooldownMultiplier: 0,
    projectileSpeedMultiplier: 1,
    critChance: 0,
    critMultiplier: 1.6,
    armor: 0
  };
}

function createDefaultInventory(): InventorySlot[] {
  return [0, 1, 2, 3].map((slotIndex) => ({
    slotIndex,
    itemId: null,
    rank: 0,
    isEvolved: false
  }));
}

function randomCooldown(rng: SeededRng, base: number): number {
  return rng.float(base * 0.45, base * 1.15);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rarityScore(rarity: 'common' | 'rare' | 'epic' | 'legendary'): number {
  if (rarity === 'legendary') return 4;
  if (rarity === 'epic') return 3;
  if (rarity === 'rare') return 2;
  return 1;
}

export class GameWorld {
  readonly config: GameConfig;
  readonly enemyHash: SpatialHash;
  readonly xpHash: SpatialHash;
  readonly hazardHash: SpatialHash;
  readonly chestHash: SpatialHash;

  readonly entities = new Set<number>();
  readonly entityKind = new Map<number, EntityKind>();
  readonly positions = new Map<number, Vec2>();
  readonly velocities = new Map<number, Vec2>();
  readonly radii = new Map<number, number>();
  readonly health = new Map<number, HealthComponent>();
  readonly enemies = new Set<number>();
  readonly enemyComponents = new Map<number, EnemyComponent>();
  readonly projectiles = new Set<number>();
  readonly projectileComponents = new Map<number, ProjectileComponent>();
  readonly enemyProjectiles = new Set<number>();
  readonly enemyProjectileComponents = new Map<number, EnemyProjectileComponent>();
  readonly hazards = new Set<number>();
  readonly hazardComponents = new Map<number, HazardComponent>();
  readonly chests = new Set<number>();
  readonly chestComponents = new Map<number, ChestComponent>();
  readonly xpOrbs = new Set<number>();
  readonly xpComponents = new Map<number, XpComponent>();

  readonly enemyPool = new NumericIdPool(10_000);
  readonly projectilePool = new NumericIdPool(120_000);
  readonly enemyProjectilePool = new NumericIdPool(120_000);
  readonly hazardPool = new NumericIdPool(60_000);
  readonly chestPool = new NumericIdPool(80_000);
  readonly xpPool = new NumericIdPool(220_000);

  readonly pendingRemoval = new Set<number>();

  readonly input: InputState = {
    up: false,
    down: false,
    left: false,
    right: false
  };

  readonly hazardTickInterval = 0.2;

  readonly playerId = 1;
  playerStats: PlayerStats = createDefaultPlayerStats();
  uiState: UIState = 'boot';
  quality: QualityTier = 'high';
  rendererKind: RendererKind | null = null;
  reducedMotion = false;
  viewport: ViewportMetrics = {
    cssWidth: 1280,
    cssHeight: 720,
    halfDiagonal: Math.hypot(640, 360)
  };

  inventorySlots: InventorySlot[] = createDefaultInventory();
  catalystRanks = new Map<string, number>();
  pendingLevelChoices: LevelUpChoice[] = [];
  pendingChestChoices: ChestChoice[] = [];
  chosenItems: string[] = [];

  rng: SeededRng;
  seed: number;
  runTime = 0;
  level = 1;
  xp = 0;
  xpToNext = xpThresholdForLevel(1);
  kills = 0;
  totalSpawns = 0;
  weaponCooldownBySlot: number[] = [0, 0, 0, 0];
  contactCooldown = 0;
  hazardTickCooldown = 0;
  damageWindowCooldown = 0;
  damageWindowTaken = 0;
  levelUpCooldown = 0;
  levelUpXpGate = 0;
  spawnAccumulator = 0;
  chestPickupCooldown = 0;
  activeEventId: string | null = null;
  enemySpeedScale = 1;
  spawnIntervalScale = 1;
  playerMoveSpeedScale = 1;
  enemyHealthScale = 1;
  enemyXpScale = 1;
  projectileDamageScale = 1;
  damageFlashTimer = 0;
  impactFlashTimer = 0;
  shotsFired = 0;
  enemyShotsFired = 0;
  levelUpOfferedCount = 0;
  playerHitCount = 0;
  totalDamageDealt = 0;
  totalDamageTaken = 0;
  hazardsCreated = 0;
  threatLevel = 0;
  eliteKills = 0;
  director: RunDirectorState = {
    phaseId: 'awakening',
    intensity: 0.35,
    heat: 0,
    targetThreat: 14,
    targetEnemies: 10,
    lastEliteSpawnTime: -999,
    nextGuaranteedEliteTime: 240,
    antiLullTimer: 0
  };

  constructor(seed: number, reducedMotion: boolean, config: Partial<GameConfig> = {}) {
    this.config = {
      ...DEFAULT_GAME_CONFIG,
      ...config
    };

    this.seed = normalizeSeed(seed);
    this.rng = new SeededRng(this.seed);
    this.reducedMotion = reducedMotion;
    this.enemyHash = new SpatialHash(this.config.collisionCellSize);
    this.xpHash = new SpatialHash(this.config.collisionCellSize);
    this.hazardHash = new SpatialHash(this.config.collisionCellSize);
    this.chestHash = new SpatialHash(this.config.collisionCellSize);
  }

  setRendererKind(kind: RendererKind): void {
    this.rendererKind = kind;
  }

  setViewport(metrics: ViewportMetrics): void {
    const width = Number.isFinite(metrics.cssWidth) ? Math.max(1, metrics.cssWidth) : this.viewport.cssWidth;
    const height = Number.isFinite(metrics.cssHeight) ? Math.max(1, metrics.cssHeight) : this.viewport.cssHeight;
    const halfDiagonal =
      Number.isFinite(metrics.halfDiagonal) && metrics.halfDiagonal > 0
        ? metrics.halfDiagonal
        : Math.hypot(width * 0.5, height * 0.5);
    this.viewport = {
      cssWidth: width,
      cssHeight: height,
      halfDiagonal
    };
  }

  setQuality(tier: QualityTier): void {
    this.quality = tier;
  }

  resetRun(seed = this.seed): void {
    this.seed = normalizeSeed(seed);
    this.rng = new SeededRng(this.seed);

    this.entities.clear();
    this.entityKind.clear();
    this.positions.clear();
    this.velocities.clear();
    this.radii.clear();
    this.health.clear();
    this.enemies.clear();
    this.enemyComponents.clear();
    this.projectiles.clear();
    this.projectileComponents.clear();
    this.enemyProjectiles.clear();
    this.enemyProjectileComponents.clear();
    this.hazards.clear();
    this.hazardComponents.clear();
    this.chests.clear();
    this.chestComponents.clear();
    this.xpOrbs.clear();
    this.xpComponents.clear();
    this.pendingRemoval.clear();

    this.enemyHash.clear();
    this.hazardHash.clear();
    this.xpHash.clear();
    this.chestHash.clear();

    this.enemyPool.reset();
    this.projectilePool.reset();
    this.enemyProjectilePool.reset();
    this.hazardPool.reset();
    this.chestPool.reset();
    this.xpPool.reset();

    this.playerStats = createDefaultPlayerStats();
    this.inventorySlots = createDefaultInventory();
    this.catalystRanks.clear();
    this.pendingLevelChoices = [];
    this.pendingChestChoices = [];
    this.weaponCooldownBySlot = [0, 0, 0, 0];
    this.chosenItems = [];

    this.uiState = 'playing';
    this.runTime = 0;
    this.level = 1;
    this.xp = 0;
    this.xpToNext = xpThresholdForLevel(1);
    this.kills = 0;
    this.totalSpawns = 0;
    this.contactCooldown = 0;
    this.hazardTickCooldown = 0;
    this.damageWindowCooldown = 0;
    this.damageWindowTaken = 0;
    this.levelUpCooldown = 0;
    this.levelUpXpGate = 0;
    this.spawnAccumulator = 0;
    this.chestPickupCooldown = 0;
    this.activeEventId = null;
    this.enemySpeedScale = 1;
    this.spawnIntervalScale = 1;
    this.playerMoveSpeedScale = 1;
    this.enemyHealthScale = 1;
    this.enemyXpScale = 1;
    this.projectileDamageScale = 1;
    this.damageFlashTimer = 0;
    this.impactFlashTimer = 0;
    this.shotsFired = 0;
    this.enemyShotsFired = 0;
    this.levelUpOfferedCount = 0;
    this.playerHitCount = 0;
    this.totalDamageDealt = 0;
    this.totalDamageTaken = 0;
    this.hazardsCreated = 0;
    this.threatLevel = 0;
    this.eliteKills = 0;
    this.director = {
      phaseId: 'awakening',
      intensity: 0.35,
      heat: 0,
      targetThreat: 14,
      targetEnemies: 10,
      lastEliteSpawnTime: -999,
      nextGuaranteedEliteTime: 240,
      antiLullTimer: 0
    };

    this.spawnPlayer();
    this.addWeaponToFirstOpenSlot(STARTING_WEAPON_ID);
  }

  private spawnPlayer(): void {
    this.entities.add(this.playerId);
    this.entityKind.set(this.playerId, 'player');
    this.positions.set(this.playerId, { x: 0, y: 0 });
    this.velocities.set(this.playerId, { x: 0, y: 0 });
    this.radii.set(this.playerId, 15);
    this.health.set(this.playerId, {
      hp: this.playerStats.hp,
      maxHp: this.playerStats.maxHp
    });
  }

  getPlayerPosition(): Vec2 {
    const pos = this.positions.get(this.playerId);
    if (!pos) return { x: 0, y: 0 };
    return pos;
  }

  getEnemyCount(): number {
    return this.enemies.size;
  }

  getCurrentEnemyThreat(): number {
    let total = 0;
    for (const component of this.enemyComponents.values()) {
      const archetype = ENEMY_ARCHETYPES[component.archetypeId];
      total += archetype?.threat ?? 1;
    }
    return total;
  }

  getArmedWeaponSlots(): InventorySlot[] {
    return this.inventorySlots.filter((slot) => slot.itemId !== null);
  }

  getWeaponForSlot(slotIndex: number): InventorySlot | null {
    const slot = this.inventorySlots[slotIndex];
    if (!slot || !slot.itemId) return null;
    return slot;
  }

  getCatalystRank(catalystId: string): number {
    return this.catalystRanks.get(catalystId) ?? 0;
  }

  getSnapshot() {
    const inventorySummary = this.inventorySlots
      .filter((slot) => slot.itemId)
      .map((slot) => `${slot.itemId}:${slot.rank}${slot.isEvolved ? '*' : ''}`);

    return {
      seed: this.seed,
      timeSeconds: this.runTime,
      level: this.level,
      kills: this.kills,
      enemiesAlive: this.enemies.size,
      upgradesChosen: [...this.chosenItems, ...inventorySummary]
    };
  }

  markForRemoval(entityId: number): void {
    if (entityId === this.playerId) return;
    this.pendingRemoval.add(entityId);
  }

  flushRemovals(): void {
    if (this.pendingRemoval.size === 0) return;

    for (const entityId of this.pendingRemoval) {
      const kind = this.entityKind.get(entityId);
      if (!kind) continue;

      this.entities.delete(entityId);
      this.entityKind.delete(entityId);
      this.positions.delete(entityId);
      this.velocities.delete(entityId);
      this.radii.delete(entityId);
      this.health.delete(entityId);

      if (kind === 'enemy') {
        this.enemies.delete(entityId);
        this.enemyComponents.delete(entityId);
        this.enemyPool.release(entityId);
      } else if (kind === 'projectile') {
        this.projectiles.delete(entityId);
        this.projectileComponents.delete(entityId);
        this.projectilePool.release(entityId);
      } else if (kind === 'enemy_projectile') {
        this.enemyProjectiles.delete(entityId);
        this.enemyProjectileComponents.delete(entityId);
        this.enemyProjectilePool.release(entityId);
      } else if (kind === 'hazard') {
        this.hazards.delete(entityId);
        this.hazardComponents.delete(entityId);
        this.hazardPool.release(entityId);
      } else if (kind === 'chest') {
        this.chests.delete(entityId);
        this.chestComponents.delete(entityId);
        this.chestPool.release(entityId);
      } else if (kind === 'xp') {
        this.xpOrbs.delete(entityId);
        this.xpComponents.delete(entityId);
        this.xpPool.release(entityId);
      }
    }

    this.pendingRemoval.clear();
  }

  spawnEnemy(archetypeId: string, position: Vec2): number {
    const archetype: EnemyArchetype | undefined = ENEMY_ARCHETYPES[archetypeId];
    if (!archetype) {
      throw new Error(`Unknown enemy archetype: ${archetypeId}`);
    }

    const entityId = this.enemyPool.acquire();
    this.entities.add(entityId);
    this.entityKind.set(entityId, 'enemy');
    this.positions.set(entityId, { ...position });
    this.velocities.set(entityId, { x: 0, y: 0 });
    this.radii.set(entityId, archetype.radius);
    const scaledMaxHp = Math.max(1, Math.round(archetype.maxHp * this.enemyHealthScale));
    const scaledXpDrop = Math.max(1, Math.round(archetype.xpDrop * this.enemyXpScale));
    this.health.set(entityId, { hp: scaledMaxHp, maxHp: scaledMaxHp });
    this.enemies.add(entityId);
    this.enemyComponents.set(entityId, {
      archetypeId,
      behavior: archetype.behavior,
      speed: archetype.speed,
      touchDamage: archetype.touchDamage,
      xpDrop: scaledXpDrop,
      dashCooldown: archetype.dash ? randomCooldown(this.rng, archetype.dash.cooldown) : 0,
      dashWindup: 0,
      dashDuration: 0,
      dashDirection: { x: 0, y: 0 },
      spitCooldown: archetype.spit ? this.rng.float(archetype.spit.cooldown * 0.85, archetype.spit.cooldown * 1.35) : 0
    });

    this.totalSpawns += 1;
    return entityId;
  }

  spawnPlayerProjectile(config: PlayerProjectileSpawnConfig): number {
    const playerPos = this.getPlayerPosition();
    const entityId = this.projectilePool.acquire();

    this.entities.add(entityId);
    this.entityKind.set(entityId, 'projectile');
    this.positions.set(entityId, { x: playerPos.x, y: playerPos.y });
    this.velocities.set(entityId, {
      x: config.direction.x * config.speed,
      y: config.direction.y * config.speed
    });
    this.radii.set(entityId, config.radius);
    this.projectiles.add(entityId);
    this.projectileComponents.set(entityId, {
      damage: config.damage,
      age: 0,
      lifetime: config.lifetime,
      pierce: config.pierce,
      hitEnemyIds: new Set<number>(),
      weaponId: config.weaponId,
      colorHex: config.colorHex,
      hazardRadius: config.hazardRadius ?? 0,
      hazardDuration: config.hazardDuration ?? 0,
      hazardDamagePerSecond: config.hazardDamagePerSecond ?? 0
    });

    this.shotsFired += 1;
    return entityId;
  }

  spawnEnemyProjectile(position: Vec2, direction: Vec2, config: EnemyProjectileSpawnConfig): number {
    const magnitude = Math.hypot(direction.x, direction.y);
    if (magnitude < 0.0001) {
      return -1;
    }

    const entityId = this.enemyProjectilePool.acquire();
    const vx = (direction.x / magnitude) * config.speed;
    const vy = (direction.y / magnitude) * config.speed;

    this.entities.add(entityId);
    this.entityKind.set(entityId, 'enemy_projectile');
    this.positions.set(entityId, { x: position.x, y: position.y });
    this.velocities.set(entityId, { x: vx, y: vy });
    this.radii.set(entityId, config.radius);
    this.enemyProjectiles.add(entityId);
    this.enemyProjectileComponents.set(entityId, {
      damage: config.damage,
      age: 0,
      lifetime: config.lifetime,
      hazardRadius: config.hazardRadius,
      hazardDuration: config.hazardDuration,
      hazardDamagePerSecond: config.hazardDamagePerSecond
    });

    this.enemyShotsFired += 1;
    return entityId;
  }

  spawnHazard(position: Vec2, config: HazardSpawnConfig): number {
    const entityId = this.hazardPool.acquire();

    this.entities.add(entityId);
    this.entityKind.set(entityId, 'hazard');
    this.positions.set(entityId, { ...position });
    this.velocities.set(entityId, { x: 0, y: 0 });
    this.radii.set(entityId, config.radius);
    this.hazards.add(entityId);
    this.hazardComponents.set(entityId, {
      damagePerSecond: config.damagePerSecond,
      age: 0,
      lifetime: config.duration,
      team: config.team,
      armDelay: Math.max(0, config.armDelay ?? 0)
    });

    this.hazardsCreated += 1;
    this.impactFlashTimer = Math.max(this.impactFlashTimer, 0.16);
    return entityId;
  }

  spawnChest(position: Vec2, guaranteedEvolution = false): number {
    const entityId = this.chestPool.acquire();

    this.entities.add(entityId);
    this.entityKind.set(entityId, 'chest');
    this.positions.set(entityId, { ...position });
    this.velocities.set(entityId, { x: 0, y: 0 });
    this.radii.set(entityId, 18);
    this.chests.add(entityId);
    this.chestComponents.set(entityId, {
      age: 0,
      lifetime: 22,
      guaranteedEvolution
    });

    return entityId;
  }

  spawnXpOrb(position: Vec2, value: number): number {
    const entityId = this.xpPool.acquire();

    this.entities.add(entityId);
    this.entityKind.set(entityId, 'xp');
    this.positions.set(entityId, { ...position });
    this.velocities.set(entityId, { x: 0, y: 0 });
    this.radii.set(entityId, 8);
    this.xpOrbs.add(entityId);
    this.xpComponents.set(entityId, { value });

    return entityId;
  }

  gainXp(amount: number): void {
    this.xp += Math.max(0, amount);
  }

  spendXpForLevel(): boolean {
    if (this.levelUpCooldown > 0) return false;
    if (this.xp < this.levelUpXpGate) return false;
    if (this.xp < this.xpToNext) return false;
    this.xp -= this.xpToNext;
    this.level += 1;
    this.xpToNext = xpThresholdForLevel(this.level);
    this.levelUpXpGate = 0;
    return true;
  }

  beginLevelUp(choices: LevelUpChoice[]): void {
    this.pendingLevelChoices = choices;
    this.levelUpOfferedCount += 1;
    this.uiState = 'levelup';
  }

  applyLevelChoice(choiceId: string): void {
    const choice = this.pendingLevelChoices.find((entry) => entry.id === choiceId);
    if (!choice) return;

    if (choice.choiceType === 'new_item') {
      if (choice.itemKind === 'weapon' && choice.itemId) {
        this.addWeaponToFirstOpenSlot(choice.itemId);
      }
      if (choice.itemKind === 'catalyst' && choice.itemId) {
        this.addCatalystRank(choice.itemId);
      }
    }

    if (choice.choiceType === 'upgrade_item') {
      if (choice.itemKind === 'weapon' && choice.slotIndex !== undefined) {
        this.upgradeWeaponSlot(choice.slotIndex);
      }
      if (choice.itemKind === 'catalyst' && choice.itemId) {
        this.addCatalystRank(choice.itemId);
      }
    }

    if (choice.choiceType === 'stat_boost') {
      switch (choice.statBoost) {
        case 'heal':
          this.playerStats.hp = Math.min(this.playerStats.maxHp, this.playerStats.hp + 36);
          break;
        case 'armor':
          this.playerStats.armor = clamp(this.playerStats.armor + 0.45, 0, 8);
          break;
        case 'speed':
          this.playerStats.moveSpeed += 18;
          break;
        case 'damage':
          this.playerStats.damageMultiplier += 0.12;
          break;
        default:
          this.playerStats.hp = Math.min(this.playerStats.maxHp, this.playerStats.hp + 22);
          break;
      }
    }

    this.chosenItems.push(choice.id);
    this.pendingLevelChoices = [];
    this.uiState = 'playing';
    this.armLevelUpCooldown();
    this.applyPostModalGrace(0.75);
  }

  beginChestChoices(choices: ChestChoice[]): void {
    this.pendingChestChoices = choices;
    this.uiState = 'chest';
  }

  applyChestChoice(choiceId: string): void {
    const choice = this.pendingChestChoices.find((entry) => entry.id === choiceId);
    if (!choice) return;

    if (choice.choiceType === 'evolve' && choice.slotIndex !== undefined && choice.evolvedWeaponId) {
      const slot = this.inventorySlots[choice.slotIndex];
      if (slot && slot.itemId) {
        slot.itemId = choice.evolvedWeaponId;
        slot.rank = 1;
        slot.isEvolved = true;
        this.chosenItems.push(`evolution:${choice.evolvedWeaponId}`);
      }
    } else if (choice.choiceType === 'reward') {
      if (choice.rewardType === 'xp_burst') {
        this.gainXp(Math.round(this.xpToNext * 0.55));
      } else if (choice.rewardType === 'heal') {
        this.playerStats.hp = this.playerStats.maxHp;
      } else {
        const catalystIds = Object.keys(CATALYST_DEFINITIONS).filter((id) => this.getCatalystRank(id) < 1);
        if (catalystIds.length > 0) {
          this.addCatalystRank(catalystIds[this.rng.int(0, catalystIds.length - 1)]);
        } else {
          this.gainXp(Math.round(this.xpToNext * 0.4));
        }
      }
    }

    this.pendingChestChoices = [];
    this.uiState = 'playing';
    this.applyPostModalGrace(0.75);
  }

  consumeNearbyChest(): void {
    if (this.chests.size === 0 || this.chestPickupCooldown > 0 || this.uiState !== 'playing') return;

    const playerPos = this.getPlayerPosition();
    const playerRadius = this.radii.get(this.playerId) ?? 14;

    for (const chestId of this.chests) {
      const pos = this.positions.get(chestId);
      const radius = this.radii.get(chestId);
      if (!pos || radius === undefined) continue;

      const dx = playerPos.x - pos.x;
      const dy = playerPos.y - pos.y;
      const rr = playerRadius + radius + 10;
      if (dx * dx + dy * dy <= rr * rr) {
        this.openChest(chestId);
        break;
      }
    }
  }

  openChest(chestId: number): void {
    const chest = this.chestComponents.get(chestId);
    this.markForRemoval(chestId);
    this.chestPickupCooldown = 0.25;

    const evolutionCandidates = this.getEvolutionCandidates();
    const shouldGuaranteeEvolution = Boolean(chest?.guaranteedEvolution && evolutionCandidates.length > 0);
    const evolutionEligible = evolutionCandidates.length > 0 && (this.runTime >= 480 || shouldGuaranteeEvolution);
    if (evolutionEligible) {
      const shuffled = [...evolutionCandidates].sort((a, b) => a.slotIndex - b.slotIndex);
      const picked: ChestChoice[] = [];

      while (picked.length < Math.min(2, shuffled.length)) {
        const index = this.rng.int(0, shuffled.length - 1);
        const candidate = shuffled.splice(index, 1)[0];
        picked.push({
          id: `chest_evolve_${candidate.slotIndex}_${candidate.evolvedWeaponId}`,
          title: `Evolve: ${candidate.evolvedWeaponName}`,
          description: `Transform slot ${candidate.slotIndex + 1} into a legendary weapon.`,
          choiceType: 'evolve',
          slotIndex: candidate.slotIndex,
          evolvedWeaponId: candidate.evolvedWeaponId
        });
      }

      if (picked.length < 2) {
        picked.push({
          id: 'chest_reward_xp',
          title: 'Chaos Tribute',
          description: 'Gain a large burst of XP.',
          choiceType: 'reward',
          rewardType: 'xp_burst'
        });
      }

      this.beginChestChoices(picked);
      return;
    }

    const fallbackChoices: ChestChoice[] = [
      {
        id: 'chest_reward_xp',
        title: 'Chaos Tribute',
        description: 'Gain a large burst of XP.',
        choiceType: 'reward',
        rewardType: 'xp_burst'
      },
      {
        id: 'chest_reward_heal',
        title: 'Blood Mend',
        description: 'Restore to full HP.',
        choiceType: 'reward',
        rewardType: 'heal'
      },
      {
        id: 'chest_reward_catalyst',
        title: 'Arcane Relic',
        description: 'Gain a catalyst rank or fallback XP.',
        choiceType: 'reward',
        rewardType: 'catalyst_boost'
      }
    ];

    if (chest?.guaranteedEvolution) {
      fallbackChoices[0].description = 'Guaranteed premium reward: massive XP burst.';
      fallbackChoices[2].description = 'Guaranteed premium reward: catalyst rank or large fallback XP.';
    }

    this.beginChestChoices(fallbackChoices);
  }

  applyPostModalGrace(seconds: number, includeHazards = true): void {
    const duration = Math.max(0, seconds);
    if (duration <= 0) return;
    this.contactCooldown = Math.max(this.contactCooldown, duration);
    if (includeHazards) {
      this.hazardTickCooldown = Math.max(this.hazardTickCooldown, duration);
    }
  }

  private armLevelUpCooldown(): void {
    const xpBuffer = Math.max(8, Math.round(this.xpToNext * 0.08));
    this.levelUpCooldown = Math.max(this.levelUpCooldown, 0.75);
    this.levelUpXpGate = Math.max(this.levelUpXpGate, this.xp + xpBuffer);
  }

  getEvolutionCandidates(): Array<{
    slotIndex: number;
    evolvedWeaponId: string;
    evolvedWeaponName: string;
    catalystId: string;
  }> {
    const out: Array<{
      slotIndex: number;
      evolvedWeaponId: string;
      evolvedWeaponName: string;
      catalystId: string;
    }> = [];

    for (const slot of this.inventorySlots) {
      if (!slot.itemId || slot.isEvolved || slot.rank < 8) continue;

      const recipe = EVOLUTION_RECIPES.find((entry) => entry.weaponId === slot.itemId);
      if (!recipe) continue;
      if (this.runTime < recipe.minTimeSeconds) continue;
      if (this.getCatalystRank(recipe.catalystId) <= 0) continue;

      const evolved = WEAPON_ARCHETYPES[recipe.evolvedWeaponId];
      if (!evolved) continue;

      out.push({
        slotIndex: slot.slotIndex,
        evolvedWeaponId: recipe.evolvedWeaponId,
        evolvedWeaponName: evolved.name,
        catalystId: recipe.catalystId
      });
    }

    return out;
  }

  addWeaponToFirstOpenSlot(weaponId: string): boolean {
    const slot = this.inventorySlots.find((entry) => entry.itemId === null);
    if (!slot) return false;

    if (!WEAPON_ARCHETYPES[weaponId]) return false;

    slot.itemId = weaponId;
    slot.rank = 1;
    slot.isEvolved = false;
    this.weaponCooldownBySlot[slot.slotIndex] = 0;
    this.chosenItems.push(`weapon:${weaponId}`);
    return true;
  }

  upgradeWeaponSlot(slotIndex: number): boolean {
    const slot = this.inventorySlots[slotIndex];
    if (!slot || !slot.itemId || slot.isEvolved) return false;
    if (slot.rank >= 8) return false;

    slot.rank += 1;
    this.chosenItems.push(`weapon_up:${slot.itemId}:${slot.rank}`);
    return true;
  }

  addCatalystRank(catalystId: string): boolean {
    const catalyst = CATALYST_DEFINITIONS[catalystId];
    if (!catalyst) return false;

    const current = this.getCatalystRank(catalystId);
    if (current >= catalyst.maxRank) return false;

    const nextRank = current + 1;
    this.catalystRanks.set(catalystId, nextRank);
    this.applyCatalystEffects(catalyst);
    this.chosenItems.push(`catalyst:${catalystId}:${nextRank}`);
    return true;
  }

  private applyCatalystEffects(catalyst: CatalystDefinition): void {
    for (const effect of catalyst.effects) {
      switch (effect.type) {
        case 'max_hp': {
          this.playerStats.maxHp += effect.amount;
          this.playerStats.hp = Math.min(this.playerStats.maxHp, this.playerStats.hp + effect.amount);
          break;
        }
        case 'heal': {
          this.playerStats.hp = Math.min(this.playerStats.maxHp, this.playerStats.hp + effect.amount);
          break;
        }
        case 'move_speed': {
          this.playerStats.moveSpeed += effect.amount;
          break;
        }
        case 'pickup_radius': {
          this.playerStats.pickupRadius += effect.amount;
          break;
        }
        case 'regen': {
          this.playerStats.regenPerSecond += effect.amount;
          break;
        }
        case 'global_damage_mult': {
          this.playerStats.damageMultiplier += effect.amount;
          break;
        }
        case 'global_cooldown_mult': {
          this.playerStats.cooldownMultiplier = clamp(this.playerStats.cooldownMultiplier + effect.amount, 0, 0.65);
          break;
        }
        case 'projectile_speed_mult': {
          this.playerStats.projectileSpeedMultiplier += effect.amount;
          break;
        }
        case 'crit_chance': {
          this.playerStats.critChance = clamp(this.playerStats.critChance + effect.amount, 0, 0.68);
          break;
        }
        case 'crit_damage': {
          this.playerStats.critMultiplier += effect.amount;
          break;
        }
        case 'armor': {
          this.playerStats.armor = clamp(this.playerStats.armor + effect.amount, 0, 8);
          break;
        }
      }
    }
  }

  getWeaponRuntimeStats(slotIndex: number): {
    weaponId: string;
    name: string;
    rarity: 'common' | 'rare' | 'epic' | 'legendary';
    pattern: string;
    rank: number;
    damage: number;
    cooldown: number;
    projectileSpeed: number;
    projectileLifetime: number;
    projectileRadius: number;
    pierce: number;
    range: number;
    projectilesPerAttack: number;
    spreadAngleDeg: number;
    colorHex: number;
    powerScore: number;
  } | null {
    const slot = this.inventorySlots[slotIndex];
    if (!slot || !slot.itemId) return null;

    const weapon = WEAPON_ARCHETYPES[slot.itemId];
    if (!weapon) return null;

    const rank = slot.rank;
    const rankScale = 1 + (rank - 1) * 0.085;
    const damage =
      (weapon.baseDamage + weapon.damagePerRank * Math.max(0, rank - 1)) *
      rankScale *
      this.playerStats.damageMultiplier *
      this.projectileDamageScale;

    const cooldownRankScale = Math.max(0.2, 1 - weapon.cooldownScalePerRank * Math.max(0, rank - 1));
    const cooldownPlayerScale = Math.max(0.35, 1 - this.playerStats.cooldownMultiplier);
    const cooldown = weapon.baseCooldown * cooldownRankScale * cooldownPlayerScale;

    const projectileSpeed =
      weapon.projectileSpeed * (1 + (rank - 1) * 0.04) * this.playerStats.projectileSpeedMultiplier;

    const pierce = Math.round(weapon.basePierce + weapon.piercePerRank * Math.max(0, rank - 1));

    return {
      weaponId: weapon.id,
      name: weapon.name,
      rarity: weapon.rarity,
      pattern: weapon.pattern,
      rank,
      damage,
      cooldown,
      projectileSpeed,
      projectileLifetime: weapon.projectileLifetime,
      projectileRadius: weapon.projectileRadius,
      pierce,
      range: weapon.range,
      projectilesPerAttack: weapon.projectilesPerAttack,
      spreadAngleDeg: weapon.spreadAngleDeg,
      colorHex: weapon.colorHex,
      powerScore: damage * (1 + pierce * 0.22) * rarityScore(weapon.rarity)
    };
  }

  applyPlayerRegen(dt: number): void {
    if (this.playerStats.regenPerSecond <= 0) return;
    this.playerStats.hp = Math.min(
      this.playerStats.maxHp,
      this.playerStats.hp + this.playerStats.regenPerSecond * dt
    );
  }

  private applyRawPlayerDamage(amount: number): void {
    if (this.uiState !== 'playing') return;

    const damageCap = this.playerStats.maxHp * 0.45;
    const available = Math.max(0, damageCap - this.damageWindowTaken);
    if (available <= 0) return;

    const reducedByArmor = amount * (1 - clamp(this.playerStats.armor * 0.08, 0, 0.6));
    const clamped = Math.min(available, Math.max(0, reducedByArmor));
    if (clamped <= 0) return;

    this.playerStats.hp -= clamped;
    this.damageWindowTaken += clamped;
    this.totalDamageTaken += clamped;
    this.damageWindowCooldown = 0.5;
    this.damageFlashTimer = Math.max(this.damageFlashTimer, 0.2);
    this.playerHitCount += 1;

    if (this.playerStats.hp <= 0) {
      this.playerStats.hp = 0;
      this.uiState = 'gameover';
    }
  }

  applyPlayerDamage(amount: number): void {
    if (this.contactCooldown > 0 || this.uiState !== 'playing') return;

    this.contactCooldown = this.playerStats.contactInvuln;
    this.applyRawPlayerDamage(amount);
  }

  applyHazardDamage(amount: number): void {
    if (this.hazardTickCooldown > 0 || this.uiState !== 'playing') return;

    this.hazardTickCooldown = this.hazardTickInterval;
    this.applyRawPlayerDamage(amount);
  }

  applyProjectileHitDamage(baseDamage: number): number {
    const critRoll = this.rng.next();
    const crit = critRoll < this.playerStats.critChance;
    const dealt = crit ? baseDamage * this.playerStats.critMultiplier : baseDamage;
    if (crit) {
      this.impactFlashTimer = Math.max(this.impactFlashTimer, 0.2);
    }
    return dealt;
  }

  recordDamageDealt(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.totalDamageDealt += amount;
  }

  updateCooldowns(dt: number): void {
    for (let i = 0; i < this.weaponCooldownBySlot.length; i += 1) {
      this.weaponCooldownBySlot[i] = Math.max(0, this.weaponCooldownBySlot[i] - dt);
    }

    this.contactCooldown = Math.max(0, this.contactCooldown - dt);
    this.hazardTickCooldown = Math.max(0, this.hazardTickCooldown - dt);
    this.levelUpCooldown = Math.max(0, this.levelUpCooldown - dt);
    this.damageWindowCooldown = Math.max(0, this.damageWindowCooldown - dt);
    if (this.damageWindowCooldown <= 0) {
      this.damageWindowTaken = 0;
    }
    this.damageFlashTimer = Math.max(0, this.damageFlashTimer - dt);
    this.impactFlashTimer = Math.max(0, this.impactFlashTimer - dt);
    this.chestPickupCooldown = Math.max(0, this.chestPickupCooldown - dt);
  }

  updateChestAges(dt: number): void {
    for (const chestId of this.chests) {
      const chest = this.chestComponents.get(chestId);
      if (!chest) continue;
      chest.age += dt;
      if (chest.age >= chest.lifetime) {
        this.markForRemoval(chestId);
      }
    }
  }

  toRunSummaryText(): string {
    const evolvedCount = this.inventorySlots.filter((slot) => slot.isEvolved).length;
    const dps = this.runTime > 0 ? this.totalDamageDealt / this.runTime : 0;
    const buildSummary = this.inventorySlots
      .filter((slot) => slot.itemId)
      .map((slot) => {
        const weaponName = slot.itemId ? WEAPON_ARCHETYPES[slot.itemId]?.name ?? slot.itemId : '-';
        return `${weaponName} R${slot.rank}${slot.isEvolved ? '*' : ''}`;
      })
      .join(', ');
    return `Survived ${this.runTime.toFixed(1)}s | Lvl ${this.level} | Kills ${this.kills} | Evolutions ${evolvedCount} | DPS ${dps.toFixed(1)} | Damage ${Math.round(this.totalDamageDealt)} dealt / ${Math.round(this.totalDamageTaken)} taken | Seed ${this.seed} | Build ${buildSummary || 'None'}`;
  }
}
