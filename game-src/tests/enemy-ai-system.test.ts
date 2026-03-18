import { describe, expect, it } from 'vitest';
import { GameWorld } from '@/core/world';
import { EnemyAISystem } from '@/systems/enemyAISystem';

function unit(x: number, y: number): { x: number; y: number } {
  const mag = Math.hypot(x, y);
  if (mag < 0.0001) return { x: 0, y: 0 };
  return { x: x / mag, y: y / mag };
}

describe('enemy ai spitter fairness', () => {
  it('does not fire perfectly player-locked spit trajectories', () => {
    const world = new GameWorld(2026, false);
    const ai = new EnemyAISystem();

    world.resetRun(2026);
    const enemyId = world.spawnEnemy('spore_channeler', { x: -420, y: 0 });
    const enemy = world.enemyComponents.get(enemyId);
    expect(enemy).toBeTruthy();
    if (!enemy) return;
    enemy.spitCooldown = 0;

    ai.update(1 / 60, world);

    expect(world.enemyProjectiles.size).toBe(1);
    const projectileId = Array.from(world.enemyProjectiles)[0];
    const projectileVel = world.velocities.get(projectileId);
    const enemyPos = world.positions.get(enemyId);
    const playerPos = world.getPlayerPosition();
    expect(projectileVel).toBeTruthy();
    expect(enemyPos).toBeTruthy();
    if (!projectileVel || !enemyPos) return;

    const perfectAim = unit(playerPos.x - enemyPos.x, playerPos.y - enemyPos.y);
    const actualAim = unit(projectileVel.x, projectileVel.y);
    const dot = perfectAim.x * actualAim.x + perfectAim.y * actualAim.y;

    expect(dot).toBeLessThan(0.9995);
  });

  it('throttles spit firing when projectile pressure is already high', () => {
    const world = new GameWorld(2027, false);
    const ai = new EnemyAISystem();

    world.resetRun(2027);
    world.runTime = 90;
    for (let i = 0; i < 10; i += 1) {
      world.spawnEnemyProjectile(
        { x: 320 + i * 10, y: 220 },
        { x: 1, y: 0 },
        {
          speed: 160,
          lifetime: 2,
          radius: 6,
          damage: 3,
          hazardRadius: 16,
          hazardDuration: 1,
          hazardDamagePerSecond: 2
        }
      );
    }

    const enemyId = world.spawnEnemy('spore_channeler', { x: -360, y: 0 });
    const enemy = world.enemyComponents.get(enemyId);
    expect(enemy).toBeTruthy();
    if (!enemy) return;
    enemy.spitCooldown = 0;

    ai.update(1 / 60, world);

    expect(world.enemyProjectiles.size).toBe(10);
    expect(enemy.spitCooldown).toBeGreaterThan(0);
  });

  it('prevents close-range point-blank spit fire', () => {
    const world = new GameWorld(2028, false);
    const ai = new EnemyAISystem();

    world.resetRun(2028);
    const enemyId = world.spawnEnemy('grave_bell', { x: 90, y: 0 });
    const enemy = world.enemyComponents.get(enemyId);
    expect(enemy).toBeTruthy();
    if (!enemy) return;
    enemy.spitCooldown = 0;

    ai.update(1 / 60, world);

    expect(world.enemyProjectiles.size).toBe(0);
    expect(enemy.spitCooldown).toBe(0);
  });

  it('keeps grave bell from firing inside the expanded minimum distance gate', () => {
    const world = new GameWorld(2029, false);
    const ai = new EnemyAISystem();

    world.resetRun(2029);
    const enemyId = world.spawnEnemy('grave_bell', { x: 180, y: 0 });
    const enemy = world.enemyComponents.get(enemyId);
    expect(enemy).toBeTruthy();
    if (!enemy) return;
    enemy.spitCooldown = 0;

    ai.update(1 / 60, world);

    expect(world.enemyProjectiles.size).toBe(0);
    expect(enemy.spitCooldown).toBe(0);
  });
});
