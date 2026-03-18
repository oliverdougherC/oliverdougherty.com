import { createVisualTheme, luminanceDelta } from '../src/render/visualTheme';
import type { ColorVisionMode } from '../src/types';

const MODES: ColorVisionMode[] = ['normal', 'deuteranopia', 'protanopia', 'tritanopia'];

describe('visual theme contrast gates', () => {
  it('keeps player, enemy, xp, and hazard colors separated for readability', () => {
    for (const mode of MODES) {
      const theme = createVisualTheme(mode);

      const playerEnemy = luminanceDelta(theme.player.fill, theme.enemies.swarmer.fill);
      const playerHazard = luminanceDelta(theme.player.fill, theme.hazards.fill);
      const xpHazard = luminanceDelta(theme.pickups.xpFill, theme.hazards.fill);
      const xpEnemy = luminanceDelta(theme.pickups.xpFill, theme.enemies.charger.fill);

      expect(playerEnemy).toBeGreaterThan(0.08);
      expect(playerHazard).toBeGreaterThan(0.14);
      expect(xpHazard).toBeGreaterThan(0.12);
      expect(xpEnemy).toBeGreaterThan(0.08);
    }
  });
});
