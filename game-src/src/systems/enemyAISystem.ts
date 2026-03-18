import type { ISystem, Vec2 } from '../types';
import { GameWorld } from '../core/world';
import { ENEMY_ARCHETYPES } from '../data/enemies';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalize(x: number, y: number): Vec2 {
  const mag = Math.hypot(x, y);
  if (mag < 0.0001) return { x: 0, y: 0 };
  return { x: x / mag, y: y / mag };
}

function setVelocity(velocity: Vec2, direction: Vec2, speed: number): void {
  velocity.x = direction.x * speed;
  velocity.y = direction.y * speed;
}

function rotate(vector: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return {
    x: vector.x * c - vector.y * s,
    y: vector.x * s + vector.y * c
  };
}

function buildSpitterAimDirection(
  world: GameWorld,
  enemyPos: Vec2,
  playerPos: Vec2,
  playerVelocity: Vec2,
  distance: number,
  projectileSpeed: number,
  spitRange: number,
  isElite: boolean
): Vec2 {
  const leadSeconds = clamp(distance / Math.max(120, projectileSpeed), 0.05, 0.28);
  const leadStrength = isElite ? 0.34 : 0.2;
  const predictedX = playerPos.x + playerVelocity.x * leadSeconds * leadStrength;
  const predictedY = playerPos.y + playerVelocity.y * leadSeconds * leadStrength;
  const baseAim = normalize(predictedX - enemyPos.x, predictedY - enemyPos.y);
  if (Math.hypot(baseAim.x, baseAim.y) < 0.0001) return baseAim;

  const closeFactor = clamp(1 - distance / Math.max(1, spitRange), 0, 1);
  const minSpreadDeg = isElite ? 2.2 : 3.4;
  const maxSpreadDeg = (isElite ? 8.2 : 13.2) + closeFactor * (isElite ? 7.2 : 13.6);
  const minSpread = (Math.PI / 180) * minSpreadDeg;
  const maxSpread = (Math.PI / 180) * maxSpreadDeg;
  const spread = world.rng.float(minSpread, maxSpread);
  const signedSpread = world.rng.next() < 0.5 ? -spread : spread;

  return rotate(baseAim, signedSpread);
}

export class EnemyAISystem implements ISystem<GameWorld> {
  update(dt: number, world: GameWorld): void {
    const playerPos = world.getPlayerPosition();
    const playerVelocity = world.velocities.get(world.playerId) ?? { x: 0, y: 0 };
    let projectedEnemyProjectileCount = world.enemyProjectiles.size;
    const projectedHazardCount = world.hazards.size;
    const projectileCap = world.runTime < 180 ? 9 : world.runTime < 420 ? 13 : 17;
    const hazardCap = world.runTime < 180 ? 8 : world.runTime < 420 ? 11 : 15;

    for (const enemyId of world.enemies) {
      const enemyPos = world.positions.get(enemyId);
      const enemyVel = world.velocities.get(enemyId);
      const enemyData = world.enemyComponents.get(enemyId);

      if (!enemyPos || !enemyVel || !enemyData) continue;

      const archetype = ENEMY_ARCHETYPES[enemyData.archetypeId];
      if (!archetype) continue;

      const dx = playerPos.x - enemyPos.x;
      const dy = playerPos.y - enemyPos.y;
      const distance = Math.hypot(dx, dy);
      const toPlayer = normalize(dx, dy);
      const baseSpeed = enemyData.speed * world.enemySpeedScale;

      if (enemyData.behavior === 'dash_striker' && archetype.dash) {
        if (enemyData.dashDuration > 0) {
          enemyData.dashDuration = Math.max(0, enemyData.dashDuration - dt);
          setVelocity(enemyVel, enemyData.dashDirection, baseSpeed * archetype.dash.speedMultiplier);
          if (enemyData.dashDuration <= 0) {
            enemyData.dashCooldown = world.rng.float(archetype.dash.cooldown * 0.85, archetype.dash.cooldown * 1.2);
          }
          continue;
        }

        if (enemyData.dashWindup > 0) {
          enemyData.dashWindup = Math.max(0, enemyData.dashWindup - dt);
          enemyVel.x = 0;
          enemyVel.y = 0;
          if (enemyData.dashWindup <= 0) {
            const direction = Math.hypot(enemyData.dashDirection.x, enemyData.dashDirection.y) > 0.1
              ? enemyData.dashDirection
              : toPlayer;
            enemyData.dashDirection = direction;
            enemyData.dashDuration = archetype.dash.duration;
          }
          continue;
        }

        enemyData.dashCooldown = Math.max(0, enemyData.dashCooldown - dt);
        if (distance > 0.1) {
          setVelocity(enemyVel, toPlayer, baseSpeed * 0.9);
        } else {
          enemyVel.x = 0;
          enemyVel.y = 0;
        }

        if (enemyData.dashCooldown <= 0 && distance <= archetype.dash.triggerRange) {
          enemyData.dashDirection = toPlayer;
          enemyData.dashWindup = archetype.dash.windup;
          enemyVel.x = 0;
          enemyVel.y = 0;
        }
        continue;
      }

      if (enemyData.behavior === 'spitter' && archetype.spit) {
        const desiredRange = archetype.spit.range * 0.72;
        enemyData.spitCooldown = Math.max(0, enemyData.spitCooldown - dt);

        if (distance < desiredRange * 0.78 && distance > 0.1) {
          setVelocity(enemyVel, { x: -toPlayer.x, y: -toPlayer.y }, baseSpeed * 1.05);
        } else if (distance > desiredRange * 1.08) {
          setVelocity(enemyVel, toPlayer, baseSpeed * 0.82);
        } else {
          const strafeSign = enemyId % 2 === 0 ? 1 : -1;
          const strafe = { x: -toPlayer.y * strafeSign, y: toPlayer.x * strafeSign };
          setVelocity(enemyVel, strafe, baseSpeed * 0.72);
        }

        const fireDistanceMin = Math.max(200, archetype.radius * 5.2);
        if (enemyData.spitCooldown <= 0 && distance <= archetype.spit.range * 1.22 && distance >= fireDistanceMin) {
          if (projectedEnemyProjectileCount >= projectileCap || projectedHazardCount >= hazardCap) {
            enemyData.spitCooldown = world.rng.float(archetype.spit.cooldown * 0.9, archetype.spit.cooldown * 1.2);
            continue;
          }

          const aimDirection = buildSpitterAimDirection(
            world,
            enemyPos,
            playerPos,
            playerVelocity,
            distance,
            archetype.spit.projectileSpeed,
            archetype.spit.range,
            Boolean(archetype.isElite)
          );
          const projectileId = world.spawnEnemyProjectile(enemyPos, aimDirection, {
            speed: archetype.spit.projectileSpeed,
            lifetime: archetype.spit.projectileLifetime,
            radius: archetype.spit.projectileRadius,
            damage: archetype.spit.projectileDamage,
            hazardRadius: archetype.spit.hazardRadius,
            hazardDuration: archetype.spit.hazardDuration,
            hazardDamagePerSecond: archetype.spit.hazardDamagePerSecond
          });
          if (projectileId >= 0) {
            projectedEnemyProjectileCount += 1;
          }
          const pressure = projectedEnemyProjectileCount + projectedHazardCount;
          const pressureCooldownScale = clamp(1 + Math.max(0, pressure - 10) * 0.045, 1, 1.45);
          enemyData.spitCooldown =
            world.rng.float(archetype.spit.cooldown * 0.96, archetype.spit.cooldown * 1.24) * pressureCooldownScale;
        }
        continue;
      }

      if (distance < 0.0001) {
        enemyVel.x = 0;
        enemyVel.y = 0;
        continue;
      }

      setVelocity(enemyVel, toPlayer, baseSpeed);
    }
  }
}
