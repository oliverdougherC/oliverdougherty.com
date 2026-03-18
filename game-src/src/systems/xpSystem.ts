import type { ISystem } from '../types';
import { GameWorld } from '../core/world';

export class XpSystem implements ISystem<GameWorld> {
  update(_dt: number, world: GameWorld): void {
    const playerPos = world.getPlayerPosition();

    for (const xpId of world.xpOrbs) {
      const xpPos = world.positions.get(xpId);
      const xpVel = world.velocities.get(xpId);
      if (!xpPos || !xpVel) continue;

      const dx = playerPos.x - xpPos.x;
      const dy = playerPos.y - xpPos.y;
      const distance = Math.hypot(dx, dy);
      const magnetRadius = world.playerStats.pickupRadius;

      const outerEdge = magnetRadius + 120;
      if (distance <= outerEdge && distance > 0.001) {
        const pull = distance <= magnetRadius ? 1 : 0.45;
        // gradient applies across the full attraction range so outer-zone orbs
        // accelerate smoothly as they approach the pickup boundary
        const proximityFactor = Math.max(0, outerEdge - distance) / outerEdge;
        const speed = 220 + proximityFactor * magnetRadius * 2;
        xpVel.x = (dx / distance) * speed * pull;
        xpVel.y = (dy / distance) * speed * pull;
      } else {
        xpVel.x *= 0.9;
        xpVel.y *= 0.9;
      }
    }
  }
}
