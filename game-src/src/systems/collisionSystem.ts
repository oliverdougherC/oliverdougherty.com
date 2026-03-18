import type { ISystem } from '../types';
import { GameWorld } from '../core/world';
import { ENEMY_ARCHETYPES } from '../data/enemies';

function circlesOverlap(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const rr = ar + br;
  return dx * dx + dy * dy <= rr * rr;
}

function normalize(x: number, y: number): { x: number; y: number } {
  const mag = Math.hypot(x, y);
  if (mag < 0.0001) return { x: 0, y: 0 };
  return { x: x / mag, y: y / mag };
}

function resolveEnemyDeath(
  world: GameWorld,
  enemyId: number,
  enemyPos: { x: number; y: number },
  enemyData: { archetypeId: string; xpDrop: number }
): void {
  world.kills += 1;
  const archetype = ENEMY_ARCHETYPES[enemyData.archetypeId];
  world.spawnXpOrb(enemyPos, enemyData.xpDrop);
  if (archetype?.isElite) {
    world.eliteKills += 1;
    world.spawnChest(enemyPos, true);
  }
  world.markForRemoval(enemyId);
}

export class CollisionSystem implements ISystem<GameWorld> {
  private readonly enemyHazardTickCooldown = new Map<number, number>();

  private tickEnemyHazardCooldowns(dt: number, world: GameWorld): void {
    for (const [enemyId, cooldown] of this.enemyHazardTickCooldown.entries()) {
      if (!world.enemies.has(enemyId)) {
        this.enemyHazardTickCooldown.delete(enemyId);
        continue;
      }
      const next = Math.max(0, cooldown - dt);
      if (next <= 0) {
        this.enemyHazardTickCooldown.delete(enemyId);
      } else {
        this.enemyHazardTickCooldown.set(enemyId, next);
      }
    }
  }

  update(dt: number, world: GameWorld): void {
    this.tickEnemyHazardCooldowns(dt, world);

    world.enemyHash.clear();
    world.xpHash.clear();
    world.hazardHash.clear();
    world.chestHash.clear();

    for (const enemyId of world.enemies) {
      const pos = world.positions.get(enemyId);
      const radius = world.radii.get(enemyId);
      if (!pos || radius === undefined) continue;
      world.enemyHash.insert(enemyId, pos, radius);
    }

    for (const xpId of world.xpOrbs) {
      const pos = world.positions.get(xpId);
      const radius = world.radii.get(xpId);
      if (!pos || radius === undefined) continue;
      world.xpHash.insert(xpId, pos, radius);
    }

    for (const hazardId of world.hazards) {
      const pos = world.positions.get(hazardId);
      const radius = world.radii.get(hazardId);
      if (!pos || radius === undefined) continue;
      world.hazardHash.insert(hazardId, pos, radius);
    }

    for (const chestId of world.chests) {
      const pos = world.positions.get(chestId);
      const radius = world.radii.get(chestId);
      if (!pos || radius === undefined) continue;
      world.chestHash.insert(chestId, pos, radius);
    }

    const playerPos = world.positions.get(world.playerId);
    const playerRadius = world.radii.get(world.playerId);

    if (!playerPos || playerRadius === undefined) return;

    const playerEnemyCandidates = world.enemyHash.queryCircle(
      playerPos,
      playerRadius + 64,
      96
    );

    for (const enemyId of playerEnemyCandidates) {
      const enemyPos = world.positions.get(enemyId);
      const enemyRadius = world.radii.get(enemyId);
      const enemy = world.enemyComponents.get(enemyId);
      if (!enemyPos || enemyRadius === undefined || !enemy) continue;

      if (circlesOverlap(playerPos.x, playerPos.y, playerRadius, enemyPos.x, enemyPos.y, enemyRadius)) {
        world.applyPlayerDamage(enemy.touchDamage);
        break;
      }
    }

    for (const projectileId of world.enemyProjectiles) {
      if (world.pendingRemoval.has(projectileId)) continue;

      const projectilePos = world.positions.get(projectileId);
      const projectileRadius = world.radii.get(projectileId);
      const projectileData = world.enemyProjectileComponents.get(projectileId);
      if (!projectilePos || projectileRadius === undefined || !projectileData) continue;

      if (
        circlesOverlap(
          playerPos.x,
          playerPos.y,
          playerRadius,
          projectilePos.x,
          projectilePos.y,
          projectileRadius
        )
      ) {
        const projectileVel = world.velocities.get(projectileId) ?? { x: 0, y: 0 };
        let impactDir = normalize(projectileVel.x, projectileVel.y);
        if (impactDir.x === 0 && impactDir.y === 0) {
          impactDir = normalize(projectilePos.x - playerPos.x, projectilePos.y - playerPos.y);
        }
        if (impactDir.x === 0 && impactDir.y === 0) {
          impactDir = { x: 1, y: 0 };
        }
        const initialOffset = Math.max(projectileRadius * 1.2, projectileData.hazardRadius * 0.22);
        const hazardPos = {
          x: projectilePos.x + impactDir.x * initialOffset,
          y: projectilePos.y + impactDir.y * initialOffset
        };
        const minCenterDistance = Math.max(playerRadius * 1.1, projectileData.hazardRadius * 0.55);
        const centerDistance = Math.hypot(hazardPos.x - playerPos.x, hazardPos.y - playerPos.y);
        if (centerDistance < minCenterDistance) {
          hazardPos.x = playerPos.x + impactDir.x * minCenterDistance;
          hazardPos.y = playerPos.y + impactDir.y * minCenterDistance;
        }

        world.applyPlayerDamage(projectileData.damage);
        world.spawnHazard(hazardPos, {
          radius: projectileData.hazardRadius,
          duration: projectileData.hazardDuration,
          damagePerSecond: projectileData.hazardDamagePerSecond,
          team: 'enemy',
          armDelay: 0.35
        });
        world.markForRemoval(projectileId);
      }
    }

    const hazardCandidates = world.hazardHash.queryCircle(playerPos, playerRadius + 120, 64);
    let totalEnemyHazardDamage = 0;
    for (const hazardId of hazardCandidates) {
      const hazardPos = world.positions.get(hazardId);
      const hazardRadius = world.radii.get(hazardId);
      const hazard = world.hazardComponents.get(hazardId);
      if (!hazardPos || hazardRadius === undefined || !hazard) continue;
      if (hazard.team !== 'enemy' || hazard.armDelay > 0) continue;

      if (circlesOverlap(playerPos.x, playerPos.y, playerRadius, hazardPos.x, hazardPos.y, hazardRadius)) {
        totalEnemyHazardDamage += hazard.damagePerSecond * world.hazardTickInterval;
      }
    }
    if (totalEnemyHazardDamage > 0) {
      world.applyHazardDamage(totalEnemyHazardDamage);
    }

    const pickupCandidates = world.xpHash.queryCircle(
      playerPos,
      playerRadius + world.playerStats.pickupRadius,
      132
    );

    for (const xpId of pickupCandidates) {
      const xpPos = world.positions.get(xpId);
      const xpRadius = world.radii.get(xpId);
      const xpData = world.xpComponents.get(xpId);
      if (!xpPos || xpRadius === undefined || !xpData) continue;

      if (
        circlesOverlap(
          playerPos.x,
          playerPos.y,
          playerRadius + world.playerStats.pickupRadius,
          xpPos.x,
          xpPos.y,
          xpRadius
        )
      ) {
        world.gainXp(xpData.value);
        world.markForRemoval(xpId);
      }
    }

    for (const enemyId of world.enemies) {
      if (world.pendingRemoval.has(enemyId)) continue;
      if (this.enemyHazardTickCooldown.has(enemyId)) continue;

      const enemyPos = world.positions.get(enemyId);
      const enemyRadius = world.radii.get(enemyId);
      const enemyHealth = world.health.get(enemyId);
      const enemyData = world.enemyComponents.get(enemyId);
      if (!enemyPos || enemyRadius === undefined || !enemyHealth || !enemyData) continue;

      const hazardCandidates = world.hazardHash.queryCircle(enemyPos, enemyRadius + 120, 64);
      let tookDamage = false;
      for (const hazardId of hazardCandidates) {
        const hazardPos = world.positions.get(hazardId);
        const hazardRadius = world.radii.get(hazardId);
        const hazard = world.hazardComponents.get(hazardId);
        if (!hazardPos || hazardRadius === undefined || !hazard) continue;
        if (hazard.team !== 'player' || hazard.armDelay > 0) continue;

        if (!circlesOverlap(enemyPos.x, enemyPos.y, enemyRadius, hazardPos.x, hazardPos.y, hazardRadius)) {
          continue;
        }

        const hazardDamage = hazard.damagePerSecond * world.hazardTickInterval;
        const appliedDamage = Math.min(enemyHealth.hp, hazardDamage);
        enemyHealth.hp -= hazardDamage;
        world.recordDamageDealt(appliedDamage);
        this.enemyHazardTickCooldown.set(enemyId, world.hazardTickInterval);
        tookDamage = true;
        break;
      }

      if (!tookDamage) continue;

      if (enemyHealth.hp <= 0) {
        resolveEnemyDeath(world, enemyId, enemyPos, enemyData);
      }
    }

    let narrowPhaseChecks = 0;

    for (const projectileId of world.projectiles) {
      if (narrowPhaseChecks >= world.config.maxNarrowPhaseChecks) break;
      if (world.pendingRemoval.has(projectileId)) continue;

      const projectilePos = world.positions.get(projectileId);
      const projectileRadius = world.radii.get(projectileId);
      const projectileData = world.projectileComponents.get(projectileId);
      if (!projectilePos || projectileRadius === undefined || !projectileData) continue;

      const candidates = world.enemyHash.queryCircle(projectilePos, projectileRadius + 56, 52);

      for (const enemyId of candidates) {
        if (narrowPhaseChecks >= world.config.maxNarrowPhaseChecks) break;
        narrowPhaseChecks += 1;

        if (world.pendingRemoval.has(enemyId)) continue;

        const enemyPos = world.positions.get(enemyId);
        const enemyRadius = world.radii.get(enemyId);
        const enemyHealth = world.health.get(enemyId);
        const enemyData = world.enemyComponents.get(enemyId);

        if (!enemyPos || enemyRadius === undefined || !enemyHealth || !enemyData) continue;

        if (!circlesOverlap(projectilePos.x, projectilePos.y, projectileRadius, enemyPos.x, enemyPos.y, enemyRadius)) {
          continue;
        }
        if (projectileData.hitEnemyIds.has(enemyId)) {
          continue;
        }

        projectileData.hitEnemyIds.add(enemyId);
        const dealt = world.applyProjectileHitDamage(projectileData.damage);
        const appliedDamage = Math.min(enemyHealth.hp, dealt);
        enemyHealth.hp -= dealt;
        world.recordDamageDealt(appliedDamage);
        projectileData.pierce -= 1;

        if (enemyHealth.hp <= 0) {
          resolveEnemyDeath(world, enemyId, enemyPos, enemyData);
        }

        // pierce semantics: basePierce=0 → hits 1 enemy (decrements to -1, then removed)
        // basePierce=N → hits N+1 enemies. The < 0 check is intentional and correct.
        if (projectileData.pierce < 0) {
          world.markForRemoval(projectileId);
          break;
        }
      }
    }
  }
}
