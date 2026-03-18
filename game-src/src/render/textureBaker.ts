import { Texture } from 'pixi.js';
import type { EnemyRole, TextureDetail, TexturePack, VisualThemeTokens } from '../types';
import {
  ENEMY_TEXTURE_CARDS,
  HAZARD_TEXTURE_CARD,
  PICKUP_TEXTURE_CARDS,
  PROJECTILE_TEXTURE_CARDS
} from './atlas/entityAtlas';

type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

interface EnemyTextureSet {
  base: Texture;
  glow: Texture;
  elite: Texture;
}

export interface BakedTexturePack {
  key: string;
  manifest: TexturePack;
  player: {
    base: Texture;
    aura: Texture;
  };
  enemies: Record<EnemyRole, EnemyTextureSet>;
  projectiles: {
    allied: Texture;
    enemy: Texture;
  };
  hazards: {
    ring: Texture;
    core: Texture;
  };
  pickups: {
    chest: Texture;
    xp: Texture;
  };
}

const DETAIL_SIZE: Record<TextureDetail, number> = {
  ultra: 1536,
  high: 1024,
  medium: 768,
  low: 512
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function colorToCss(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function handle(detail: TextureDetail, id: string): string {
  return `${detail}:${id}`;
}

function createCanvas(size: number): CanvasLike | null {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(size, size);
  }
  return null;
}

function getContext2d(canvas: CanvasLike): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  const context = canvas.getContext('2d');
  if (!context || typeof (context as CanvasRenderingContext2D).fillRect !== 'function') {
    return null;
  }
  const ctx = context as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) {
    (ctx as CanvasRenderingContext2D).imageSmoothingQuality = 'high';
  }
  return ctx;
}

function configureTexture(texture: Texture): Texture {
  const source = texture.source;
  source.scaleMode = 'linear';
  source.mipmapFilter = 'linear';
  source.autoGenerateMipmaps = true;
  source.antialias = true;
  source.maxAnisotropy = 8;
  source.updateMipmaps();
  return texture;
}

function toTexture(canvas: CanvasLike): Texture {
  return configureTexture(Texture.from(canvas as unknown as HTMLCanvasElement));
}

function drawEnemyTexture(
  theme: VisualThemeTokens,
  role: EnemyRole,
  detail: TextureDetail,
  variant: 'base' | 'glow' | 'elite'
): Texture {
  const size = DETAIL_SIZE[detail];
  const canvas = createCanvas(size);
  if (!canvas) return Texture.WHITE;
  const ctx = getContext2d(canvas);
  if (!ctx) return Texture.WHITE;
  const center = size * 0.5;
  const card = ENEMY_TEXTURE_CARDS[role];
  const radius = size * 0.36;
  const palette = theme.enemies[role];
  const stroke = variant === 'elite' ? theme.elite.stroke : palette.stroke;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(center, center);

  const glowGradient = ctx.createRadialGradient(0, 0, radius * 0.1, 0, 0, radius * 1.2);
  glowGradient.addColorStop(0, colorToCss(palette.fill, variant === 'glow' ? 0.42 : 0.24));
  glowGradient.addColorStop(1, colorToCss(palette.fill, 0));
  ctx.fillStyle = glowGradient;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 1.28, 0, Math.PI * 2);
  ctx.fill();

  const bodyGradient = ctx.createRadialGradient(-radius * 0.2, -radius * 0.25, radius * 0.2, 0, 0, radius);
  bodyGradient.addColorStop(0, colorToCss(palette.stroke, 0.8));
  bodyGradient.addColorStop(0.35, colorToCss(palette.fill, 0.95));
  bodyGradient.addColorStop(1, colorToCss(palette.fill, 0.72));
  ctx.fillStyle = bodyGradient;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();

  if (card.notch > 0.01) {
    const notchCount = role === 'summoner' ? 6 : 4;
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < notchCount; i += 1) {
      const angle = (Math.PI * 2 * i) / notchCount;
      const nx = Math.cos(angle) * radius * 0.8;
      const ny = Math.sin(angle) * radius * 0.8;
      ctx.beginPath();
      ctx.arc(nx, ny, radius * card.notch * 0.42, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.strokeStyle = colorToCss(stroke, 0.96);
  ctx.lineWidth = size * 0.03;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.98, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = colorToCss(palette.stroke, 0.4);
  ctx.beginPath();
  ctx.arc(0, -radius * 0.32, radius * card.coreRatio * 0.5, 0, Math.PI * 2);
  ctx.fill();

  if (variant === 'elite') {
    ctx.strokeStyle = colorToCss(theme.elite.crown, 0.98);
    ctx.lineWidth = size * 0.015;
    ctx.beginPath();
    ctx.arc(0, -radius * 1.06, radius * 0.42, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
  return toTexture(canvas);
}

function drawProjectileTexture(
  theme: VisualThemeTokens,
  detail: TextureDetail,
  side: 'allied' | 'enemy'
): Texture {
  const size = Math.round(DETAIL_SIZE[detail] * 0.32);
  const canvas = createCanvas(size);
  if (!canvas) return Texture.WHITE;
  const ctx = getContext2d(canvas);
  if (!ctx) return Texture.WHITE;
  const center = size * 0.5;
  const card = PROJECTILE_TEXTURE_CARDS[side];
  const fill = side === 'allied' ? theme.projectiles.allied : theme.projectiles.enemy;
  const stroke = side === 'allied' ? theme.projectiles.alliedStroke : theme.projectiles.enemyStroke;
  const radius = size * 0.34;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(center, center);

  ctx.fillStyle = colorToCss(fill, 0.24);
  ctx.beginPath();
  ctx.arc(0, 0, radius * 1.3, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = colorToCss(fill, 0.95);
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(-radius * card.tail, radius * 0.56);
  ctx.lineTo(-radius * 0.12, 0);
  ctx.lineTo(-radius * card.tail, -radius * 0.56);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = colorToCss(stroke, 0.96);
  ctx.lineWidth = Math.max(2, size * 0.04);
  ctx.stroke();
  ctx.restore();
  return toTexture(canvas);
}

function drawHazardRingTexture(theme: VisualThemeTokens, detail: TextureDetail): Texture {
  const size = Math.round(DETAIL_SIZE[detail] * 0.62);
  const canvas = createCanvas(size);
  if (!canvas) return Texture.WHITE;
  const ctx = getContext2d(canvas);
  if (!ctx) return Texture.WHITE;
  const center = size * 0.5;
  const radius = size * 0.44;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(center, center);
  ctx.strokeStyle = colorToCss(theme.hazards.stroke, 0.78);
  ctx.lineWidth = size * 0.022;
  for (let i = 0; i < HAZARD_TEXTURE_CARD.ringCount; i += 1) {
    const ratio = 1 - i * 0.18;
    ctx.globalAlpha = clamp(0.9 - i * 0.22, 0.2, 1);
    ctx.beginPath();
    ctx.arc(0, 0, radius * ratio, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  return toTexture(canvas);
}

function drawHazardCoreTexture(theme: VisualThemeTokens, detail: TextureDetail): Texture {
  const size = Math.round(DETAIL_SIZE[detail] * 0.46);
  const canvas = createCanvas(size);
  if (!canvas) return Texture.WHITE;
  const ctx = getContext2d(canvas);
  if (!ctx) return Texture.WHITE;
  const center = size * 0.5;
  const radius = size * 0.38;

  ctx.clearRect(0, 0, size, size);
  const gradient = ctx.createRadialGradient(center, center, radius * 0.1, center, center, radius);
  gradient.addColorStop(0, colorToCss(theme.hazards.inner, 0.92));
  gradient.addColorStop(0.62, colorToCss(theme.hazards.fill, 0.74));
  gradient.addColorStop(1, colorToCss(theme.hazards.fill, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();
  return toTexture(canvas);
}

function drawPickupTexture(theme: VisualThemeTokens, detail: TextureDetail, kind: 'chest' | 'xp'): Texture {
  const card = PICKUP_TEXTURE_CARDS[kind];
  const size = Math.round((DETAIL_SIZE[detail] * card.size) / 220);
  const canvas = createCanvas(size);
  if (!canvas) return Texture.WHITE;
  const ctx = getContext2d(canvas);
  if (!ctx) return Texture.WHITE;
  const center = size * 0.5;
  ctx.clearRect(0, 0, size, size);

  if (kind === 'xp') {
    const radius = size * 0.4;
    ctx.fillStyle = colorToCss(theme.pickups.xpFill, 0.56);
    ctx.beginPath();
    ctx.arc(center, center, radius * 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colorToCss(theme.pickups.xpStroke, 0.24);
    ctx.beginPath();
    ctx.arc(center, center, radius * 1.02, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colorToCss(theme.pickups.xpFill, 0.92);
    ctx.beginPath();
    ctx.moveTo(center, center - radius);
    ctx.lineTo(center + radius, center);
    ctx.lineTo(center, center + radius);
    ctx.lineTo(center - radius, center);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = colorToCss(theme.pickups.xpStroke, 0.96);
    ctx.lineWidth = Math.max(2, size * 0.04);
    ctx.stroke();
    return toTexture(canvas);
  }

  const width = size * 0.66;
  const height = size * 0.46;
  ctx.fillStyle = colorToCss(theme.pickups.chestFill, 0.96);
  ctx.strokeStyle = colorToCss(theme.pickups.chestStroke, 0.96);
  ctx.lineWidth = Math.max(2, size * 0.03);
  ctx.beginPath();
  ctx.roundRect(center - width * 0.5, center - height * 0.45, width, height, size * 0.08);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = colorToCss(theme.pickups.chestStroke, 0.82);
  ctx.fillRect(center - width * 0.06, center - height * 0.48, width * 0.12, height * 1.02);
  return toTexture(canvas);
}

function drawPlayerTexture(theme: VisualThemeTokens, detail: TextureDetail, kind: 'base' | 'aura'): Texture {
  const size = Math.round(DETAIL_SIZE[detail] * 0.42);
  const canvas = createCanvas(size);
  if (!canvas) return Texture.WHITE;
  const ctx = getContext2d(canvas);
  if (!ctx) return Texture.WHITE;
  const center = size * 0.5;
  const radius = size * (kind === 'aura' ? 0.44 : 0.34);
  ctx.clearRect(0, 0, size, size);
  const gradient = ctx.createRadialGradient(center, center, radius * 0.2, center, center, radius);
  gradient.addColorStop(0, colorToCss(kind === 'aura' ? theme.player.aura : theme.player.stroke, 0.86));
  gradient.addColorStop(1, colorToCss(kind === 'aura' ? theme.player.aura : theme.player.fill, kind === 'aura' ? 0 : 0.9));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();
  if (kind === 'base') {
    ctx.strokeStyle = colorToCss(theme.player.stroke, 0.96);
    ctx.lineWidth = Math.max(2, size * 0.03);
    ctx.beginPath();
    ctx.arc(center, center, radius * 0.96, 0, Math.PI * 2);
    ctx.stroke();
  }
  return toTexture(canvas);
}

export function buildTexturePackManifest(theme: VisualThemeTokens, detail: TextureDetail): TexturePack {
  return {
    key: `${detail}:${theme.player.fill.toString(16)}:${theme.hazards.fill.toString(16)}`,
    player: {
      base: handle(detail, 'player.base'),
      aura: handle(detail, 'player.aura')
    },
    enemies: {
      swarmer: {
        base: handle(detail, 'enemy.swarmer.base'),
        glow: handle(detail, 'enemy.swarmer.glow'),
        elite: handle(detail, 'enemy.swarmer.elite')
      },
      charger: {
        base: handle(detail, 'enemy.charger.base'),
        glow: handle(detail, 'enemy.charger.glow'),
        elite: handle(detail, 'enemy.charger.elite')
      },
      bruiser: {
        base: handle(detail, 'enemy.bruiser.base'),
        glow: handle(detail, 'enemy.bruiser.glow'),
        elite: handle(detail, 'enemy.bruiser.elite')
      },
      tank: {
        base: handle(detail, 'enemy.tank.base'),
        glow: handle(detail, 'enemy.tank.glow'),
        elite: handle(detail, 'enemy.tank.elite')
      },
      sniper: {
        base: handle(detail, 'enemy.sniper.base'),
        glow: handle(detail, 'enemy.sniper.glow'),
        elite: handle(detail, 'enemy.sniper.elite')
      },
      summoner: {
        base: handle(detail, 'enemy.summoner.base'),
        glow: handle(detail, 'enemy.summoner.glow'),
        elite: handle(detail, 'enemy.summoner.elite')
      },
      disruptor: {
        base: handle(detail, 'enemy.disruptor.base'),
        glow: handle(detail, 'enemy.disruptor.glow'),
        elite: handle(detail, 'enemy.disruptor.elite')
      }
    },
    projectiles: {
      allied: handle(detail, 'projectile.allied'),
      enemy: handle(detail, 'projectile.enemy')
    },
    hazards: {
      ring: handle(detail, 'hazard.ring'),
      core: handle(detail, 'hazard.core')
    },
    pickups: {
      chest: handle(detail, 'pickup.chest'),
      xp: handle(detail, 'pickup.xp')
    }
  };
}

export function bakeTexturePack(theme: VisualThemeTokens, detail: TextureDetail): BakedTexturePack | null {
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
  const manifest = buildTexturePackManifest(theme, detail);
  const key = manifest.key;

  const enemies = {} as Record<EnemyRole, EnemyTextureSet>;
  (Object.keys(ENEMY_TEXTURE_CARDS) as EnemyRole[]).forEach((role) => {
    enemies[role] = {
      base: drawEnemyTexture(theme, role, detail, 'base'),
      glow: drawEnemyTexture(theme, role, detail, 'glow'),
      elite: drawEnemyTexture(theme, role, detail, 'elite')
    };
  });

  return {
    key,
    manifest,
    player: {
      base: drawPlayerTexture(theme, detail, 'base'),
      aura: drawPlayerTexture(theme, detail, 'aura')
    },
    enemies,
    projectiles: {
      allied: drawProjectileTexture(theme, detail, 'allied'),
      enemy: drawProjectileTexture(theme, detail, 'enemy')
    },
    hazards: {
      ring: drawHazardRingTexture(theme, detail),
      core: drawHazardCoreTexture(theme, detail)
    },
    pickups: {
      chest: drawPickupTexture(theme, detail, 'chest'),
      xp: drawPickupTexture(theme, detail, 'xp')
    }
  };
}
