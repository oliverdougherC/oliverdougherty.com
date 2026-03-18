import type { HandbookEntry, HandbookSection } from '../types';
import { CATALYST_DEFINITIONS } from './catalysts';
import { ENEMY_ARCHETYPES } from './enemies';
import { EVOLUTION_RECIPES } from './evolutions';
import { RUN_EVENT_MODIFIERS } from './events';
import { WEAPON_ARCHETYPES } from './weapons';

function rarityLabel(rarity: 'common' | 'rare' | 'epic' | 'legendary'): string {
  return rarity.charAt(0).toUpperCase() + rarity.slice(1);
}

export function buildHandbookSections(): HandbookSection[] {
  const controlEntries: HandbookEntry[] = [
    {
      id: 'controls-movement',
      title: 'Movement and Core Inputs',
      description: 'Move with WASD or arrow keys. Press Esc to pause/resume. Press O for settings, H for handbook, M to mute.',
      tags: ['controls', 'movement', 'pause', 'settings', 'audio']
    },
    {
      id: 'controls-restart',
      title: 'Restart Safety',
      description: 'Quick restart is intentionally gated to avoid accidental run loss: use Shift+R (same seed) or Shift+N (new seed) while paused or at game over.',
      tags: ['controls', 'restart', 'seed']
    },
    {
      id: 'controls-build',
      title: 'Build Progression',
      description: 'Weapons auto-fire. You can hold up to 4 weapons and stack catalysts. Level-up and chest menus support number-key selection.',
      tags: ['build', 'weapons', 'catalysts', 'levelup', 'chests']
    }
  ];

  const weaponEntries = Object.values(WEAPON_ARCHETYPES)
    .map((weapon) => {
      const evolutionLabel = weapon.isEvolution ? ` Evolution of ${weapon.evolvedFrom ?? 'unknown'}.` : '';
      const hazardLabel =
        weapon.hazardRadiusBase && weapon.hazardDamageMultiplier
          ? ` Spawns hazard pools (base radius ${weapon.hazardRadiusBase}, duration ${weapon.hazardDurationBase ?? 0}s).`
          : '';
      return {
        id: `weapon-${weapon.id}`,
        title: weapon.name,
        description: `${rarityLabel(weapon.rarity)} ${weapon.pattern} weapon.${evolutionLabel} ${weapon.description}${hazardLabel}`.trim(),
        tags: ['weapon', weapon.rarity, weapon.pattern, weapon.id]
      } satisfies HandbookEntry;
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  const catalystEntries = Object.values(CATALYST_DEFINITIONS)
    .map((catalyst) => ({
      id: `catalyst-${catalyst.id}`,
      title: catalyst.name,
      description: `${rarityLabel(catalyst.rarity)} catalyst (max rank ${catalyst.maxRank}). ${catalyst.description}`,
      tags: ['catalyst', catalyst.rarity, catalyst.id]
    }))
    .sort((a, b) => a.title.localeCompare(b.title));

  const evolutionEntries = EVOLUTION_RECIPES.map((recipe) => {
    const baseWeapon = WEAPON_ARCHETYPES[recipe.weaponId];
    const evolvedWeapon = WEAPON_ARCHETYPES[recipe.evolvedWeaponId];
    const catalyst = CATALYST_DEFINITIONS[recipe.catalystId];
    return {
      id: `evolution-${recipe.id}`,
      title: evolvedWeapon?.name ?? recipe.evolvedWeaponId,
      description: `Evolve ${baseWeapon?.name ?? recipe.weaponId} with ${catalyst?.name ?? recipe.catalystId}. Eligible at ${Math.floor(recipe.minTimeSeconds / 60)}:${String(recipe.minTimeSeconds % 60).padStart(2, '0')} and offered via elite chest.`,
      tags: ['evolution', recipe.weaponId, recipe.catalystId, recipe.evolvedWeaponId]
    };
  }).sort((a, b) => a.title.localeCompare(b.title));

  const eventEntries = RUN_EVENT_MODIFIERS.map((event) => ({
    id: `event-${event.id}`,
    title: event.label,
    description: `${event.startTime}s-${event.endTime}s. ${event.description}`,
    tags: ['event', event.id, 'timeline']
  }));

  const enemyEntries = Object.values(ENEMY_ARCHETYPES)
    .map((enemy) => ({
      id: `enemy-${enemy.id}`,
      title: enemy.name,
      description: `${enemy.isElite ? 'Elite ' : ''}${enemy.role} (${enemy.behavior}) unlocks at ${enemy.unlockTime}s. Threat ${enemy.threat.toFixed(1)}, HP ${enemy.maxHp}, speed ${enemy.speed}.`,
      tags: ['enemy', enemy.role, enemy.behavior, enemy.id, enemy.isElite ? 'elite' : 'normal']
    }))
    .sort((a, b) => a.title.localeCompare(b.title));

  const coreEntries: HandbookEntry[] = [
    {
      id: 'core-xp-levelup',
      title: 'XP and Level-ups',
      description: 'Collect XP gems to level. Level-ups present 3 choices. Weapon slots cap at 4, so later choices prioritize upgrades and catalysts.',
      tags: ['core', 'xp', 'levelup', 'build']
    },
    {
      id: 'core-chests-evolution',
      title: 'Elite Chests and Evolutions',
      description: 'Elite enemies drop chests. After evolution timing is met, chest choices can offer evolution upgrades when recipe conditions are satisfied.',
      tags: ['core', 'chest', 'elite', 'evolution']
    },
    {
      id: 'core-survivability',
      title: 'Damage, Armor, and Hazard Ticks',
      description: 'Armor reduces incoming damage up to a cap. Contact and hazard damage are rate-limited by cooldown windows to avoid instant multi-hit deletion.',
      tags: ['core', 'damage', 'armor', 'hazard', 'survivability']
    },
    {
      id: 'core-director',
      title: 'Director and Events',
      description: 'Spawn pressure scales with director intensity/heat and timed events. Survive pacing spikes by kiting, prioritizing spitters, and controlling hazard zones.',
      tags: ['core', 'director', 'events', 'spawns']
    }
  ];

  return [
    { id: 'controls', title: 'Controls', entries: controlEntries },
    { id: 'weapons', title: 'Weapons', entries: weaponEntries },
    { id: 'catalysts', title: 'Catalysts', entries: catalystEntries },
    { id: 'evolutions', title: 'Evolutions', entries: evolutionEntries },
    { id: 'events', title: 'Events', entries: eventEntries },
    { id: 'enemies', title: 'Enemies', entries: enemyEntries },
    { id: 'core', title: 'Core Mechanics', entries: coreEntries }
  ];
}
