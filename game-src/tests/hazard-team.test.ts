import { describe, expect, it } from 'vitest';
import { GameWorld } from '@/core/world';
import { CollisionSystem } from '@/systems/collisionSystem';
import { ProjectileSystem } from '@/systems/projectileSystem';

function movePlayer(world: GameWorld, x: number, y: number): void {
  const playerPos = world.positions.get(world.playerId);
  if (!playerPos) return;
  playerPos.x = x;
  playerPos.y = y;
}

describe('hazard ownership and arming fairness', () => {
  it('does not let player hazards damage the player', () => {
    const world = new GameWorld(5101, false);
    const collision = new CollisionSystem();

    world.resetRun(5101);
    const startHp = world.playerStats.hp;
    world.spawnHazard(world.getPlayerPosition(), {
      radius: 84,
      duration: 4,
      damagePerSecond: 60,
      team: 'player'
    });

    collision.update(1 / 60, world);

    expect(world.playerStats.hp).toBe(startHp);
  });

  it('lets player hazards damage enemies', () => {
    const world = new GameWorld(5102, false);
    const collision = new CollisionSystem();

    world.resetRun(5102);
    movePlayer(world, 0, 0);
    const enemyId = world.spawnEnemy('brambleling', { x: 220, y: 0 });
    const enemyHealth = world.health.get(enemyId);
    expect(enemyHealth).toBeTruthy();
    if (!enemyHealth) return;

    world.spawnHazard({ x: 220, y: 0 }, {
      radius: 88,
      duration: 4,
      damagePerSecond: 60,
      team: 'player'
    });

    collision.update(1 / 60, world);

    expect(enemyHealth.hp).toBeLessThan(enemyHealth.maxHp);
  });

  it('arms enemy hazards after delay before damaging the player', () => {
    const world = new GameWorld(5103, false);
    const projectileSystem = new ProjectileSystem();
    const collision = new CollisionSystem();

    world.resetRun(5103);
    const startHp = world.playerStats.hp;
    world.spawnHazard(world.getPlayerPosition(), {
      radius: 92,
      duration: 4,
      damagePerSecond: 60,
      team: 'enemy',
      armDelay: 0.35
    });

    for (let i = 0; i < 3; i += 1) {
      projectileSystem.update(0.1, world);
      collision.update(0.1, world);
    }
    expect(world.playerStats.hp).toBe(startHp);

    projectileSystem.update(0.1, world);
    collision.update(0.1, world);
    expect(world.playerStats.hp).toBeLessThan(startHp);
  });

  it('does not let enemy hazards damage enemies', () => {
    const world = new GameWorld(5104, false);
    const projectileSystem = new ProjectileSystem();
    const collision = new CollisionSystem();

    world.resetRun(5104);
    movePlayer(world, 1200, 1200);
    const enemyId = world.spawnEnemy('moss_hound', { x: 0, y: 0 });
    const enemyHealth = world.health.get(enemyId);
    expect(enemyHealth).toBeTruthy();
    if (!enemyHealth) return;

    world.spawnHazard({ x: 0, y: 0 }, {
      radius: 90,
      duration: 4,
      damagePerSecond: 80,
      team: 'enemy'
    });

    for (let i = 0; i < 6; i += 1) {
      projectileSystem.update(0.1, world);
      collision.update(0.1, world);
    }

    expect(enemyHealth.hp).toBe(enemyHealth.maxHp);
  });
});
