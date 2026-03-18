import { describe, expect, it } from 'vitest';
import { GameWorld } from '@/core/world';
import { CollisionSystem } from '@/systems/collisionSystem';

describe('collision system regressions', () => {
  it('does not let one projectile damage the same enemy on consecutive frames', () => {
    const world = new GameWorld(7001, false);
    const collision = new CollisionSystem();

    world.resetRun(7001);
    const enemyId = world.spawnEnemy('brambleling', { x: 0, y: 0 });
    const enemyHealth = world.health.get(enemyId);
    expect(enemyHealth).toBeTruthy();
    if (!enemyHealth) return;

    const projectileId = world.spawnPlayerProjectile({
      direction: { x: 0, y: 0 },
      weaponId: 'moon_disc',
      speed: 0,
      lifetime: 4,
      radius: 18,
      damage: 10,
      pierce: 1,
      colorHex: 0xffffff
    });

    const playerPos = world.positions.get(world.playerId);
    expect(playerPos).toBeTruthy();
    if (!playerPos) return;
    playerPos.x = 600;
    playerPos.y = 600;

    collision.update(1 / 60, world);
    const afterFirstHit = enemyHealth.hp;

    collision.update(1 / 60, world);

    expect(enemyHealth.hp).toBe(afterFirstHit);
    expect(world.projectiles.has(projectileId)).toBe(true);
  });

  it('accumulates overlapping enemy hazard damage into a single tick', () => {
    const world = new GameWorld(7002, false);
    const collision = new CollisionSystem();

    world.resetRun(7002);
    const startHp = world.playerStats.hp;
    const playerPos = world.getPlayerPosition();

    world.spawnHazard(playerPos, {
      radius: 90,
      duration: 4,
      damagePerSecond: 30,
      team: 'enemy'
    });
    world.spawnHazard(playerPos, {
      radius: 90,
      duration: 4,
      damagePerSecond: 45,
      team: 'enemy'
    });

    collision.update(1 / 60, world);

    expect(world.playerStats.hp).toBeCloseTo(
      startHp - (30 + 45) * world.hazardTickInterval,
      5
    );
  });
});
