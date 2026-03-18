import type { ISystem } from '../types';
import { GameWorld } from '../core/world';

export class ProjectileSystem implements ISystem<GameWorld> {
  update(dt: number, world: GameWorld): void {
    const playerPos = world.getPlayerPosition();

    for (const projectileId of world.projectiles) {
      const projectile = world.projectileComponents.get(projectileId);
      const projectilePos = world.positions.get(projectileId);
      if (!projectile || !projectilePos) continue;

      projectile.age += dt;

      const expired = projectile.age >= projectile.lifetime;
      const tooFar =
        (projectilePos.x - playerPos.x) * (projectilePos.x - playerPos.x) +
          (projectilePos.y - playerPos.y) * (projectilePos.y - playerPos.y) >
        2400 * 2400;

      if (!expired && !tooFar) continue;

      if (projectile.hazardRadius > 1 && projectile.hazardDuration > 0.2 && projectile.hazardDamagePerSecond > 0) {
        world.spawnHazard(projectilePos, {
          radius: projectile.hazardRadius,
          duration: projectile.hazardDuration,
          damagePerSecond: projectile.hazardDamagePerSecond,
          team: 'player'
        });
      }

      world.markForRemoval(projectileId);
    }

    for (const projectileId of world.enemyProjectiles) {
      const projectile = world.enemyProjectileComponents.get(projectileId);
      const projectilePos = world.positions.get(projectileId);
      if (!projectile || !projectilePos) continue;

      projectile.age += dt;
      if (projectile.age < projectile.lifetime) continue;

      world.spawnHazard(projectilePos, {
        radius: projectile.hazardRadius,
        duration: projectile.hazardDuration,
        damagePerSecond: projectile.hazardDamagePerSecond,
        team: 'enemy'
      });
      world.markForRemoval(projectileId);
    }

    for (const hazardId of world.hazards) {
      const hazard = world.hazardComponents.get(hazardId);
      if (!hazard) continue;
      hazard.age += dt;
      hazard.armDelay = Math.max(0, hazard.armDelay - dt);
      if (hazard.age >= hazard.lifetime) {
        world.markForRemoval(hazardId);
      }
    }
  }
}
