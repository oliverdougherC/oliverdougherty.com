import { describe, expect, it } from 'vitest';
import { WEAPON_ARCHETYPES, BASE_WEAPON_IDS, STARTING_WEAPON_ID } from '@/data/weapons';
import { ENEMY_ARCHETYPES, ELITE_ENEMY_IDS } from '@/data/enemies';
import { CATALYST_DEFINITIONS, CATALYST_IDS } from '@/data/catalysts';
import { EVOLUTION_RECIPES } from '@/data/evolutions';
import { WAVE_STAGES, getWaveStageAt } from '@/data/waves';
import { DIRECTOR_BANDS, getDirectorBand } from '@/data/director';
import { UPGRADE_OPTIONS } from '@/data/upgrades';
import { RUN_EVENT_MODIFIERS } from '@/data/events';

/**
 * Data-consistency tests validate referential integrity across all game
 * data tables. These tests scale automatically—adding a new weapon,
 * enemy, catalyst, or evolution recipe will be caught if any cross-
 * reference is broken.
 */
describe('data consistency', () => {
  describe('weapons', () => {
    it('every weapon key matches its embedded id', () => {
      for (const [key, weapon] of Object.entries(WEAPON_ARCHETYPES)) {
        expect(weapon.id).toBe(key);
      }
    });

    it('starting weapon exists in archetypes', () => {
      expect(WEAPON_ARCHETYPES[STARTING_WEAPON_ID]).toBeDefined();
    });

    it('all base weapons are in the archetype table', () => {
      for (const id of BASE_WEAPON_IDS) {
        expect(WEAPON_ARCHETYPES[id]).toBeDefined();
      }
    });

    it('every weapon has valid numeric stats', () => {
      for (const weapon of Object.values(WEAPON_ARCHETYPES)) {
        expect(weapon.baseDamage).toBeGreaterThan(0);
        expect(weapon.baseCooldown).toBeGreaterThan(0);
        expect(weapon.projectileSpeed).toBeGreaterThanOrEqual(0);
        expect(weapon.projectileLifetime).toBeGreaterThan(0);
        expect(weapon.projectileRadius).toBeGreaterThan(0);
        expect(weapon.projectilesPerAttack).toBeGreaterThanOrEqual(1);
        expect(weapon.range).toBeGreaterThan(0);
      }
    });
  });

  describe('enemies', () => {
    it('every enemy key matches its embedded id', () => {
      for (const [key, enemy] of Object.entries(ENEMY_ARCHETYPES)) {
        expect(enemy.id).toBe(key);
      }
    });

    it('every enemy has positive hp, radius, and speed', () => {
      for (const enemy of Object.values(ENEMY_ARCHETYPES)) {
        expect(enemy.maxHp).toBeGreaterThan(0);
        expect(enemy.radius).toBeGreaterThan(0);
        expect(enemy.speed).toBeGreaterThan(0);
      }
    });

    it('elite enemies are marked with isElite', () => {
      for (const id of ELITE_ENEMY_IDS) {
        expect(ENEMY_ARCHETYPES[id]?.isElite).toBe(true);
      }
    });

    it('spitter enemies have spit configuration', () => {
      for (const enemy of Object.values(ENEMY_ARCHETYPES)) {
        if (enemy.behavior === 'spitter') {
          expect(enemy.spit).toBeDefined();
          expect(enemy.spit!.cooldown).toBeGreaterThan(0);
          expect(enemy.spit!.projectileSpeed).toBeGreaterThan(0);
        }
      }
    });

    it('dash_striker enemies have dash configuration', () => {
      for (const enemy of Object.values(ENEMY_ARCHETYPES)) {
        if (enemy.behavior === 'dash_striker') {
          expect(enemy.dash).toBeDefined();
          expect(enemy.dash!.cooldown).toBeGreaterThan(0);
          expect(enemy.dash!.speedMultiplier).toBeGreaterThan(1);
        }
      }
    });
  });

  describe('catalysts', () => {
    it('every catalyst key matches its embedded id', () => {
      for (const [key, catalyst] of Object.entries(CATALYST_DEFINITIONS)) {
        expect(catalyst.id).toBe(key);
      }
    });

    it('CATALYST_IDS matches the definition keys', () => {
      expect(CATALYST_IDS.sort()).toEqual(Object.keys(CATALYST_DEFINITIONS).sort());
    });

    it('every catalyst has at least one effect', () => {
      for (const catalyst of Object.values(CATALYST_DEFINITIONS)) {
        expect(catalyst.effects.length).toBeGreaterThan(0);
      }
    });
  });

  describe('evolution recipes', () => {
    it('every recipe references an existing base weapon', () => {
      for (const recipe of EVOLUTION_RECIPES) {
        expect(WEAPON_ARCHETYPES[recipe.weaponId]).toBeDefined();
      }
    });

    it('every recipe references an existing catalyst', () => {
      for (const recipe of EVOLUTION_RECIPES) {
        expect(CATALYST_DEFINITIONS[recipe.catalystId]).toBeDefined();
      }
    });

    it('every recipe references an existing evolved weapon', () => {
      for (const recipe of EVOLUTION_RECIPES) {
        expect(WEAPON_ARCHETYPES[recipe.evolvedWeaponId]).toBeDefined();
      }
    });

    it('recipe IDs are unique', () => {
      const ids = EVOLUTION_RECIPES.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('no two recipes share the same base weapon', () => {
      const weapons = EVOLUTION_RECIPES.map((r) => r.weaponId);
      expect(new Set(weapons).size).toBe(weapons.length);
    });

    it('every recipe has a positive minTimeSeconds', () => {
      for (const recipe of EVOLUTION_RECIPES) {
        expect(recipe.minTimeSeconds).toBeGreaterThan(0);
      }
    });
  });

  describe('wave stages', () => {
    it('stages cover time from 0 continuously', () => {
      expect(WAVE_STAGES[0].startTime).toBe(0);
      for (let i = 1; i < WAVE_STAGES.length; i++) {
        expect(WAVE_STAGES[i].startTime).toBe(WAVE_STAGES[i - 1].endTime);
      }
    });

    it('every stage weight references an existing enemy archetype', () => {
      for (const stage of WAVE_STAGES) {
        for (const enemyId of Object.keys(stage.weights)) {
          expect(ENEMY_ARCHETYPES[enemyId]).toBeDefined();
        }
      }
    });

    it('every stage weight sums to roughly 1.0', () => {
      for (const stage of WAVE_STAGES) {
        const total = Object.values(stage.weights).reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(1.0, 1);
      }
    });

    it('getWaveStageAt returns valid stage for any time', () => {
      expect(getWaveStageAt(0).id).toBe(WAVE_STAGES[0].id);
      expect(getWaveStageAt(-10).id).toBe(WAVE_STAGES[0].id);
      expect(getWaveStageAt(99999)).toBeDefined();
    });
  });

  describe('director bands', () => {
    it('bands cover time from 0 continuously', () => {
      expect(DIRECTOR_BANDS[0].startTime).toBe(0);
      for (let i = 1; i < DIRECTOR_BANDS.length; i++) {
        expect(DIRECTOR_BANDS[i].startTime).toBe(DIRECTOR_BANDS[i - 1].endTime);
      }
    });

    it('every band has min <= max for enemy and threat targets', () => {
      for (const band of DIRECTOR_BANDS) {
        expect(band.targetEnemiesMin).toBeLessThanOrEqual(band.targetEnemiesMax);
        expect(band.targetThreatMin).toBeLessThanOrEqual(band.targetThreatMax);
        expect(band.projectileHazardMin).toBeLessThanOrEqual(band.projectileHazardMax);
      }
    });

    it('getDirectorBand returns valid band for any time', () => {
      expect(getDirectorBand(0).id).toBe(DIRECTOR_BANDS[0].id);
      expect(getDirectorBand(-5).id).toBe(DIRECTOR_BANDS[0].id);
      expect(getDirectorBand(99999)).toBeDefined();
    });
  });

  describe('upgrades', () => {
    it('upgrade IDs are unique', () => {
      const ids = UPGRADE_OPTIONS.map((u) => u.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('every upgrade has a positive weight', () => {
      for (const upgrade of UPGRADE_OPTIONS) {
        expect(upgrade.weight).toBeGreaterThan(0);
      }
    });
  });

  describe('run events', () => {
    it('event IDs are unique', () => {
      const ids = RUN_EVENT_MODIFIERS.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('events have valid time windows', () => {
      for (const event of RUN_EVENT_MODIFIERS) {
        expect(event.startTime).toBeGreaterThanOrEqual(0);
        expect(event.endTime).toBeGreaterThan(event.startTime);
      }
    });
  });
});
