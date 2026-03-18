import { describe, expect, it } from 'vitest';
import { GameWorld } from '@/core/world';
import { CleanupSystem } from '@/systems/cleanupSystem';
import { SpawnSystem } from '@/systems/spawnSystem';

describe('viewport-aware spawn and cleanup', () => {
  it('spawns enemies outside a 4k viewport ring around the player', () => {
    const world = new GameWorld(1337, false);
    world.resetRun(1337);
    world.setViewport({
      cssWidth: 3840,
      cssHeight: 2160,
      halfDiagonal: Math.hypot(1920, 1080)
    });

    const spawnSystem = new SpawnSystem();
    spawnSystem.update(1, world);

    const playerPos = world.getPlayerPosition();
    const expectedMin = world.viewport.halfDiagonal + 140;
    expect(world.enemies.size).toBeGreaterThan(0);
    for (const enemyId of world.enemies) {
      const pos = world.positions.get(enemyId);
      expect(pos).toBeTruthy();
      const distance = Math.hypot((pos?.x ?? 0) - playerPos.x, (pos?.y ?? 0) - playerPos.y);
      expect(distance).toBeGreaterThanOrEqual(expectedMin - 0.01);
    }
  });

  it('does not despawn visible enemies on large viewports', () => {
    const world = new GameWorld(4242, false);
    world.resetRun(4242);
    world.setViewport({
      cssWidth: 3840,
      cssHeight: 2160,
      halfDiagonal: Math.hypot(1920, 1080)
    });

    const cleanup = new CleanupSystem();
    const visibleEnemyId = world.spawnEnemy('brambleling', { x: 2200, y: 0 });
    cleanup.update(0.016, world);
    expect(world.enemies.has(visibleEnemyId)).toBe(true);

    const farEnemyId = world.spawnEnemy('brambleling', { x: 3200, y: 0 });
    cleanup.update(0.016, world);
    expect(world.enemies.has(farEnemyId)).toBe(false);
  });
});
