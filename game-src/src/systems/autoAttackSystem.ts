import type { ISystem, Vec2 } from '../types';
import { GameWorld } from '../core/world';
import { WEAPON_ARCHETYPES } from '../data/weapons';
import { findNearestEnemy } from './targeting';

function normalize(x: number, y: number): Vec2 {
  const mag = Math.hypot(x, y);
  if (mag < 0.0001) return { x: 0, y: 0 };
  return { x: x / mag, y: y / mag };
}

function rotate(vec: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return {
    x: vec.x * c - vec.y * s,
    y: vec.x * s + vec.y * c
  };
}

function spawnWeaponPattern(world: GameWorld, slotIndex: number, baseDirection: Vec2): void {
  const runtime = world.getWeaponRuntimeStats(slotIndex);
  if (!runtime) return;

  const spreadRad = (runtime.spreadAngleDeg * Math.PI) / 180;
  const projectiles = Math.max(1, runtime.projectilesPerAttack);

  const archetype = WEAPON_ARCHETYPES[runtime.weaponId];
  const hazardRank = Math.max(0, runtime.rank - 1);

  const spawn = (direction: Vec2): void => {
    world.spawnPlayerProjectile({
      direction,
      weaponId: runtime.weaponId,
      speed: runtime.projectileSpeed,
      lifetime: runtime.projectileLifetime,
      radius: runtime.projectileRadius,
      damage: runtime.damage,
      pierce: runtime.pierce,
      colorHex: runtime.colorHex,
      hazardRadius: archetype?.hazardRadiusBase !== undefined
        ? archetype.hazardRadiusBase + (archetype.hazardRadiusPerRank ?? 0) * hazardRank
        : 0,
      hazardDuration: archetype?.hazardDurationBase !== undefined
        ? archetype.hazardDurationBase + (archetype.hazardDurationPerRank ?? 0) * hazardRank
        : 0,
      hazardDamagePerSecond: archetype?.hazardDamageMultiplier !== undefined
        ? runtime.damage * archetype.hazardDamageMultiplier
        : 0
    });
  };

  switch (runtime.pattern) {
    case 'single': {
      spawn(baseDirection);
      break;
    }
    case 'heavy': {
      spawn(baseDirection);
      break;
    }
    case 'fan':
    case 'burst': {
      for (let i = 0; i < projectiles; i += 1) {
        const ratio = projectiles === 1 ? 0 : i / (projectiles - 1);
        const angle = -spreadRad / 2 + ratio * spreadRad;
        spawn(rotate(baseDirection, angle));
      }
      if (runtime.pattern === 'burst' && runtime.rarity !== 'common') {
        spawn(rotate(baseDirection, spreadRad * 0.16));
        spawn(rotate(baseDirection, -spreadRad * 0.16));
      }
      break;
    }
    case 'ring': {
      const count = Math.max(8, projectiles);
      for (let i = 0; i < count; i += 1) {
        const angle = (Math.PI * 2 * i) / count;
        spawn({ x: Math.cos(angle), y: Math.sin(angle) });
      }
      break;
    }
    case 'spiral': {
      const pivot = world.runTime * 3.4 + slotIndex;
      for (let i = 0; i < projectiles; i += 1) {
        const angle = pivot + (Math.PI * 2 * i) / projectiles;
        spawn({ x: Math.cos(angle), y: Math.sin(angle) });
      }
      break;
    }
    case 'orbit': {
      const count = Math.max(3, projectiles);
      for (let i = 0; i < count; i += 1) {
        const angle = world.runTime * 2.2 + (Math.PI * 2 * i) / count;
        spawn({ x: Math.cos(angle), y: Math.sin(angle) });
      }
      break;
    }
    default: {
      spawn(baseDirection);
      break;
    }
  }

  world.weaponCooldownBySlot[slotIndex] = runtime.cooldown;
}

export class AutoAttackSystem implements ISystem<GameWorld> {
  update(_dt: number, world: GameWorld): void {
    if (world.uiState !== 'playing') return;
    if (world.enemies.size === 0) return;

    const playerPos = world.getPlayerPosition();
    const candidates = Array.from(world.enemies)
      .map((enemyId) => {
        const pos = world.positions.get(enemyId);
        if (!pos) return null;
        return { id: enemyId, position: pos };
      })
      .filter((entry): entry is { id: number; position: { x: number; y: number } } => Boolean(entry));

    for (const slot of world.inventorySlots) {
      if (!slot.itemId) continue;
      if (world.weaponCooldownBySlot[slot.slotIndex] > 0) continue;

      const runtime = world.getWeaponRuntimeStats(slot.slotIndex);
      if (!runtime) continue;

      const target = findNearestEnemy(playerPos, candidates, runtime.range);
      if (!target && runtime.pattern !== 'ring' && runtime.pattern !== 'orbit' && runtime.pattern !== 'spiral') {
        continue;
      }

      const direction = target
        ? normalize(target.position.x - playerPos.x, target.position.y - playerPos.y)
        : { x: 1, y: 0 };

      spawnWeaponPattern(world, slot.slotIndex, direction);
    }
  }
}
