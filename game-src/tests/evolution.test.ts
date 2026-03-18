import { describe, expect, it } from 'vitest';
import { GameWorld } from '@/core/world';
import { EVOLUTION_RECIPES } from '@/data/evolutions';
import { WEAPON_ARCHETYPES } from '@/data/weapons';

describe('evolution gating', () => {
  it('requires rank, catalyst, and late-game timing', () => {
    const world = new GameWorld(31337, false);
    world.resetRun(31337);

    const slot = world.inventorySlots[0];
    expect(slot.itemId).toBe('rootspark_wand');

    slot.rank = 8;
    world.runTime = 400;
    world.addCatalystRank('ritual_resin');

    expect(world.getEvolutionCandidates()).toHaveLength(0);

    world.runTime = 500;
    const candidates = world.getEvolutionCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.evolvedWeaponId).toBe('worldroot_lance');
  });

  it('applies chest evolution choice to the selected slot', () => {
    const world = new GameWorld(9001, false);
    world.resetRun(9001);

    world.inventorySlots[0].rank = 8;
    world.runTime = 500;
    world.addCatalystRank('ritual_resin');

    world.beginChestChoices([
      {
        id: 'test_evolve',
        title: 'Evolve',
        description: 'test',
        choiceType: 'evolve',
        slotIndex: 0,
        evolvedWeaponId: 'worldroot_lance'
      }
    ]);

    world.applyChestChoice('test_evolve');

    expect(world.inventorySlots[0].itemId).toBe('worldroot_lance');
    expect(world.inventorySlots[0].isEvolved).toBe(true);
    expect(world.uiState).toBe('playing');
  });

  it('provides evolution coverage for every base weapon', () => {
    const recipeBases = new Set(EVOLUTION_RECIPES.map((recipe) => recipe.weaponId));
    const baseWeaponIds = Object.values(WEAPON_ARCHETYPES)
      .filter((weapon) => !weapon.isEvolution)
      .map((weapon) => weapon.id);

    for (const weaponId of baseWeaponIds) {
      expect(recipeBases.has(weaponId), `Missing evolution recipe for ${weaponId}`).toBe(true);
    }
  });
});
