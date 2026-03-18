import { describe, expect, it } from 'vitest';
import { GameWorld } from '@/core/world';

describe('world lifecycle', () => {
  it('resetRun clears enemies and projectiles', () => {
    const world = new GameWorld(9001, false);
    world.resetRun(9001);

    world.spawnEnemy('brambleling', { x: 100, y: 100 });
    world.spawnEnemy('moss_hound', { x: 200, y: 200 });
    expect(world.enemies.size).toBeGreaterThan(0);

    world.resetRun(9002);

    expect(world.enemies.size).toBe(0);
    expect(world.projectiles.size).toBe(0);
    expect(world.hazards.size).toBe(0);
    expect(world.chests.size).toBe(0);
    expect(world.xpOrbs.size).toBe(0);
  });

  it('spawnEnemy creates entity with position, health, and radius', () => {
    const world = new GameWorld(9010, false);
    world.resetRun(9010);

    const id = world.spawnEnemy('brambleling', { x: 42, y: 73 });

    expect(world.enemies.has(id)).toBe(true);
    expect(world.positions.get(id)).toEqual({ x: 42, y: 73 });
    expect(world.health.get(id)).toBeDefined();
    expect(world.health.get(id)!.hp).toBeGreaterThan(0);
    expect(world.radii.get(id)).toBeGreaterThan(0);
  });

  it('markForRemoval adds entity to pending removal set', () => {
    const world = new GameWorld(9020, false);
    world.resetRun(9020);

    const id = world.spawnEnemy('brambleling', { x: 0, y: 0 });
    world.markForRemoval(id);

    expect(world.pendingRemoval.has(id)).toBe(true);
  });

  it('gainXp accumulates total experience', () => {
    const world = new GameWorld(9030, false);
    world.resetRun(9030);

    const before = world.xp;
    world.gainXp(100);

    expect(world.xp).toBeGreaterThan(before);
  });

  it('spawnChest creates a chest entity', () => {
    const world = new GameWorld(9040, false);
    world.resetRun(9040);

    const before = world.chests.size;
    world.spawnChest({ x: 300, y: 300 });

    expect(world.chests.size).toBe(before + 1);
  });

  it('spawnHazard creates hazard with correct team', () => {
    const world = new GameWorld(9050, false);
    world.resetRun(9050);

    const id = world.spawnHazard({ x: 0, y: 0 }, {
      radius: 40,
      duration: 2,
      damagePerSecond: 10,
      team: 'player'
    });

    expect(world.hazards.has(id)).toBe(true);
    const comp = world.hazardComponents.get(id);
    expect(comp).toBeDefined();
    expect(comp!.team).toBe('player');
  });

  it('player starts with the starting weapon in inventory', () => {
    const world = new GameWorld(9060, false);
    world.resetRun(9060);

    const hasWeapon = world.inventorySlots.some(
      (slot) => slot.itemId === 'rootspark_wand'
    );
    expect(hasWeapon).toBe(true);
  });

  it('entity IDs are unique across spawn calls', () => {
    const world = new GameWorld(9070, false);
    world.resetRun(9070);

    const ids = new Set<number>();
    for (let i = 0; i < 50; i++) {
      ids.add(world.spawnEnemy('brambleling', { x: i * 10, y: 0 }));
    }
    expect(ids.size).toBe(50);
  });
});
