import type { ISystem } from '../types';
import { GameWorld } from '../core/world';

export class CleanupSystem implements ISystem<GameWorld> {
  update(_dt: number, world: GameWorld): void {
    const playerPos = world.getPlayerPosition();
    const despawnRadiusBase = Math.max(world.config.enemyDespawnRadius, world.viewport.halfDiagonal + 650);
    const despawnRadiusSq = despawnRadiusBase * despawnRadiusBase;

    for (const enemyId of world.enemies) {
      const health = world.health.get(enemyId);
      if (health && health.hp <= 0) {
        world.markForRemoval(enemyId);
        continue;
      }

      const pos = world.positions.get(enemyId);
      if (!pos) continue;

      const dx = pos.x - playerPos.x;
      const dy = pos.y - playerPos.y;
      if (dx * dx + dy * dy > despawnRadiusSq) {
        world.markForRemoval(enemyId);
      }
    }

    for (const projectileId of world.enemyProjectiles) {
      const pos = world.positions.get(projectileId);
      if (!pos) continue;

      const dx = pos.x - playerPos.x;
      const dy = pos.y - playerPos.y;
      if (dx * dx + dy * dy > (despawnRadiusBase + 760) ** 2) {
        world.markForRemoval(projectileId);
      }
    }

    for (const projectileId of world.projectiles) {
      const pos = world.positions.get(projectileId);
      if (!pos) continue;

      const dx = pos.x - playerPos.x;
      const dy = pos.y - playerPos.y;
      if (dx * dx + dy * dy > (despawnRadiusBase + 820) ** 2) {
        world.markForRemoval(projectileId);
      }
    }

    for (const chestId of world.chests) {
      const pos = world.positions.get(chestId);
      if (!pos) continue;
      const dx = pos.x - playerPos.x;
      const dy = pos.y - playerPos.y;
      if (dx * dx + dy * dy > (despawnRadiusBase + 500) ** 2) {
        world.markForRemoval(chestId);
      }
    }

    world.flushRemovals();
  }
}
