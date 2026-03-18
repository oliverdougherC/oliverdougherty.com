import { describe, expect, it } from 'vitest';
import { SpatialHash } from '@/core/spatialHash';

describe('spatial hash (extended)', () => {
  it('clear removes all entities', () => {
    const hash = new SpatialHash(100);
    hash.insert(1, { x: 0, y: 0 }, 10);
    hash.insert(2, { x: 50, y: 50 }, 10);
    hash.clear();

    const results = hash.queryCircle({ x: 0, y: 0 }, 200);
    expect(results).toHaveLength(0);
  });

  it('handles negative coordinates', () => {
    const hash = new SpatialHash(100);
    hash.insert(1, { x: -150, y: -200 }, 10);

    const results = hash.queryCircle({ x: -150, y: -200 }, 50);
    expect(results).toContain(1);
  });

  it('entity spanning multiple cells is found from any adjacent cell', () => {
    const hash = new SpatialHash(50);
    // Large radius entity at cell boundary
    hash.insert(1, { x: 50, y: 50 }, 30);

    // Query from each quadrant around the entity
    expect(hash.queryCircle({ x: 25, y: 25 }, 40)).toContain(1);
    expect(hash.queryCircle({ x: 75, y: 75 }, 40)).toContain(1);
    expect(hash.queryCircle({ x: 25, y: 75 }, 40)).toContain(1);
    expect(hash.queryCircle({ x: 75, y: 25 }, 40)).toContain(1);
  });

  it('does not return duplicate entity IDs', () => {
    const hash = new SpatialHash(20);
    // Insert entity with large radius spanning many cells
    hash.insert(1, { x: 0, y: 0 }, 50);

    const results = hash.queryCircle({ x: 0, y: 0 }, 100);
    const unique = new Set(results);
    expect(unique.size).toBe(results.length);
  });

  it('handles zero-radius query', () => {
    const hash = new SpatialHash(100);
    hash.insert(1, { x: 50, y: 50 }, 10);

    // Zero-radius query at the entity's cell should still find it
    const results = hash.queryCircle({ x: 50, y: 50 }, 0);
    expect(results).toContain(1);
  });

  it('handles many entities in the same cell', () => {
    const hash = new SpatialHash(100);
    const count = 200;
    for (let i = 0; i < count; i++) {
      hash.insert(i, { x: 10, y: 10 }, 5);
    }

    const results = hash.queryCircle({ x: 10, y: 10 }, 50);
    expect(results).toHaveLength(count);
  });

  it('maxCandidates of 1 returns exactly 1', () => {
    const hash = new SpatialHash(100);
    hash.insert(1, { x: 0, y: 0 }, 5);
    hash.insert(2, { x: 5, y: 0 }, 5);

    const results = hash.queryCircle({ x: 0, y: 0 }, 50, 1);
    expect(results).toHaveLength(1);
  });

  it('empty hash returns empty array', () => {
    const hash = new SpatialHash(100);
    expect(hash.queryCircle({ x: 0, y: 0 }, 500)).toHaveLength(0);
  });
});
