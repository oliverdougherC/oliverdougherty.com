import { describe, expect, it, vi } from 'vitest';
import { GameWorld } from '@/core/world';
import { SpawnSystem } from '@/systems/spawnSystem';

describe('spawn system caching', () => {
  it('does not repeatedly query live enemy counts during burst spawning', () => {
    const world = new GameWorld(7003, false);
    const spawnSystem = new SpawnSystem();

    world.resetRun(7003);
    world.runTime = 200;

    const threatSpy = vi.spyOn(world, 'getCurrentEnemyThreat');
    const enemyCountSpy = vi.spyOn(world, 'getEnemyCount');

    spawnSystem.update(1.2, world);

    expect(world.enemies.size).toBeGreaterThan(1);
    expect(threatSpy).toHaveBeenCalledTimes(0);
    expect(enemyCountSpy).toHaveBeenCalledTimes(0);
  });
});
