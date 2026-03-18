import { describe, expect, it } from 'vitest';
import { buildHandbookSections } from '@/data/handbook';
import { CATALYST_DEFINITIONS } from '@/data/catalysts';
import { ENEMY_ARCHETYPES } from '@/data/enemies';
import { EVOLUTION_RECIPES } from '@/data/evolutions';
import { RUN_EVENT_MODIFIERS } from '@/data/events';
import { WEAPON_ARCHETYPES } from '@/data/weapons';

describe('handbook coverage', () => {
  it('includes every weapon, catalyst, evolution, event, and enemy', () => {
    const sections = buildHandbookSections();
    const allEntryIds = new Set(sections.flatMap((section) => section.entries.map((entry) => entry.id)));

    for (const weaponId of Object.keys(WEAPON_ARCHETYPES)) {
      expect(allEntryIds.has(`weapon-${weaponId}`), `Missing handbook weapon entry for ${weaponId}`).toBe(true);
    }
    for (const catalystId of Object.keys(CATALYST_DEFINITIONS)) {
      expect(allEntryIds.has(`catalyst-${catalystId}`), `Missing handbook catalyst entry for ${catalystId}`).toBe(true);
    }
    for (const recipe of EVOLUTION_RECIPES) {
      expect(allEntryIds.has(`evolution-${recipe.id}`), `Missing handbook evolution entry for ${recipe.id}`).toBe(true);
    }
    for (const event of RUN_EVENT_MODIFIERS) {
      expect(allEntryIds.has(`event-${event.id}`), `Missing handbook event entry for ${event.id}`).toBe(true);
    }
    for (const enemyId of Object.keys(ENEMY_ARCHETYPES)) {
      expect(allEntryIds.has(`enemy-${enemyId}`), `Missing handbook enemy entry for ${enemyId}`).toBe(true);
    }
  });

  it('supports search-friendly tags and content', () => {
    const sections = buildHandbookSections();
    const query = 'mortar';
    const matches = sections.flatMap((section) =>
      section.entries.filter((entry) => {
        const haystack = `${section.title} ${entry.title} ${entry.description} ${entry.tags.join(' ')}`.toLowerCase();
        return haystack.includes(query);
      })
    );
    expect(matches.some((entry) => entry.id === 'weapon-fungal_mortar')).toBe(true);
  });
});
