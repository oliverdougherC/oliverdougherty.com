import { describe, expect, it } from 'vitest';
import { GameWorld } from '@/core/world';
import { CollisionSystem } from '@/systems/collisionSystem';

function createWorldWithEnemy(seed = 8001) {
  const world = new GameWorld(seed, false);
  world.resetRun(seed);

  // Move player far away so it doesn't collide with test entities
  const playerPos = world.positions.get(world.playerId)!;
  playerPos.x = 5000;
  playerPos.y = 5000;

  return world;
}

describe('collision system (extended)', () => {
  it('player takes damage from enemy contact', () => {
    const world = new GameWorld(8010, false);
    world.resetRun(8010);
    const collision = new CollisionSystem();

    const playerPos = world.getPlayerPosition();
    const startHp = world.playerStats.hp;

    // Spawn enemy directly on top of player
    world.spawnEnemy('brambleling', { x: playerPos.x, y: playerPos.y });

    collision.update(1 / 60, world);

    expect(world.playerStats.hp).toBeLessThan(startHp);
  });

  it('player hazard with armDelay does not damage enemies', () => {
    const world = createWorldWithEnemy();
    const collision = new CollisionSystem();

    const enemyId = world.spawnEnemy('brambleling', { x: 100, y: 100 });
    const enemyHealth = world.health.get(enemyId)!;
    const startHp = enemyHealth.hp;

    world.spawnHazard({ x: 100, y: 100 }, {
      radius: 80,
      duration: 4,
      damagePerSecond: 100,
      team: 'player',
      armDelay: 2.0
    });

    collision.update(1 / 60, world);

    expect(enemyHealth.hp).toBe(startHp);
  });

  it('enemy hazard with armDelay does not damage player', () => {
    const world = new GameWorld(8012, false);
    world.resetRun(8012);
    const collision = new CollisionSystem();
    const startHp = world.playerStats.hp;
    const playerPos = world.getPlayerPosition();

    world.spawnHazard(playerPos, {
      radius: 80,
      duration: 4,
      damagePerSecond: 100,
      team: 'enemy',
      armDelay: 2.0
    });

    collision.update(1 / 60, world);

    expect(world.playerStats.hp).toBe(startHp);
  });

  it('projectile with pierce > 0 hits multiple enemies', () => {
    const world = createWorldWithEnemy();
    const collision = new CollisionSystem();

    const enemy1 = world.spawnEnemy('brambleling', { x: 100, y: 100 });
    const enemy2 = world.spawnEnemy('brambleling', { x: 100, y: 100 });
    const hp1 = world.health.get(enemy1)!;
    const hp2 = world.health.get(enemy2)!;
    const startHp1 = hp1.hp;
    const startHp2 = hp2.hp;

    world.spawnPlayerProjectile({
      direction: { x: 1, y: 0 },
      weaponId: 'rootspark_wand',
      speed: 0,
      lifetime: 4,
      radius: 50,
      damage: 5,
      pierce: 1,
      colorHex: 0xffffff
    });

    // Position projectile on enemies
    const projId = [...world.projectiles][0];
    world.positions.get(projId)!.x = 100;
    world.positions.get(projId)!.y = 100;

    collision.update(1 / 60, world);

    // Both should take damage
    expect(hp1.hp).toBeLessThan(startHp1);
    expect(hp2.hp).toBeLessThan(startHp2);
    // Projectile should survive (pierce was 1 → hits 2 enemies total)
    expect(world.projectiles.has(projId)).toBe(true);
  });

  it('projectile is removed when pierce is exhausted', () => {
    const world = createWorldWithEnemy();
    const collision = new CollisionSystem();

    world.spawnEnemy('brambleling', { x: 100, y: 100 });

    world.spawnPlayerProjectile({
      direction: { x: 1, y: 0 },
      weaponId: 'rootspark_wand',
      speed: 0,
      lifetime: 4,
      radius: 50,
      damage: 5,
      pierce: 0,
      colorHex: 0xffffff
    });

    const projId = [...world.projectiles][0];
    world.positions.get(projId)!.x = 100;
    world.positions.get(projId)!.y = 100;

    collision.update(1 / 60, world);

    expect(world.pendingRemoval.has(projId)).toBe(true);
  });

  it('enemy death from hazard increments kill counter', () => {
    const world = createWorldWithEnemy();
    const collision = new CollisionSystem();

    const startKills = world.kills;
    const enemyId = world.spawnEnemy('brambleling', { x: 200, y: 200 });
    // Set enemy HP very low so hazard kills it
    world.health.get(enemyId)!.hp = 1;

    world.spawnHazard({ x: 200, y: 200 }, {
      radius: 80,
      duration: 4,
      damagePerSecond: 999,
      team: 'player'
    });

    collision.update(1 / 60, world);

    expect(world.kills).toBe(startKills + 1);
  });

  it('XP orb is collected when within pickup radius', () => {
    const world = new GameWorld(8016, false);
    world.resetRun(8016);
    const collision = new CollisionSystem();
    const playerPos = world.getPlayerPosition();

    const xpBefore = world.xp;
    world.spawnXpOrb({ x: playerPos.x + 1, y: playerPos.y }, 50);

    collision.update(1 / 60, world);

    expect(world.xp).toBe(xpBefore + 50);
  });

  it('player hazard team does not damage player', () => {
    const world = new GameWorld(8017, false);
    world.resetRun(8017);
    const collision = new CollisionSystem();
    const startHp = world.playerStats.hp;
    const playerPos = world.getPlayerPosition();

    world.spawnHazard(playerPos, {
      radius: 80,
      duration: 4,
      damagePerSecond: 100,
      team: 'player'
    });

    collision.update(1 / 60, world);

    expect(world.playerStats.hp).toBe(startHp);
  });
});
