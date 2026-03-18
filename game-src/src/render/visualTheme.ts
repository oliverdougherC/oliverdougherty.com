import type { ColorVisionMode, EnemyRole, VisualThemeTokens } from '../types';

type EnemyPalette = Record<EnemyRole, { fill: number; stroke: number }>;

const BASE_ENEMIES: EnemyPalette = {
  swarmer: { fill: 0xff8b63, stroke: 0xfffaf4 },
  charger: { fill: 0x67a2ff, stroke: 0xf4f9ff },
  bruiser: { fill: 0xffbf5d, stroke: 0xfff7e4 },
  tank: { fill: 0xc382ff, stroke: 0xfbf4ff },
  sniper: { fill: 0x72f0b1, stroke: 0xf2fff8 },
  summoner: { fill: 0xea8dff, stroke: 0xfff4ff },
  disruptor: { fill: 0xff659f, stroke: 0xffedf5 }
};

const DEUTERANOPIA_ENEMIES: EnemyPalette = {
  swarmer: { fill: 0xffa07b, stroke: 0xffefe5 },
  charger: { fill: 0x3f8de8, stroke: 0xe7f0ff },
  bruiser: { fill: 0xffc679, stroke: 0xfff0db },
  tank: { fill: 0xd09cff, stroke: 0xf9efff },
  sniper: { fill: 0x94efc7, stroke: 0xecfff7 },
  summoner: { fill: 0xd98dff, stroke: 0xf9edff },
  disruptor: { fill: 0xff85c3, stroke: 0xffe7f4 }
};

const PROTANOPIA_ENEMIES: EnemyPalette = {
  swarmer: { fill: 0xffa887, stroke: 0xfff1e6 },
  charger: { fill: 0x3c88e2, stroke: 0xe6efff },
  bruiser: { fill: 0xffcd84, stroke: 0xfff2dd },
  tank: { fill: 0xc89bff, stroke: 0xf8eeff },
  sniper: { fill: 0x9cf0cf, stroke: 0xedfff8 },
  summoner: { fill: 0xdc98ff, stroke: 0xf8eeff },
  disruptor: { fill: 0xff8dcc, stroke: 0xffebf6 }
};

const TRITANOPIA_ENEMIES: EnemyPalette = {
  swarmer: { fill: 0xff9a78, stroke: 0xffede4 },
  charger: { fill: 0x3e8be0, stroke: 0xe8f8ff },
  bruiser: { fill: 0xffc26f, stroke: 0xffefda },
  tank: { fill: 0xc2a3ff, stroke: 0xf3edff },
  sniper: { fill: 0x8ef0c5, stroke: 0xebfff7 },
  summoner: { fill: 0xf89dff, stroke: 0xffefff },
  disruptor: { fill: 0xff76ae, stroke: 0xffe4ef }
};

function enemyPalette(mode: ColorVisionMode): EnemyPalette {
  if (mode === 'deuteranopia') return DEUTERANOPIA_ENEMIES;
  if (mode === 'protanopia') return PROTANOPIA_ENEMIES;
  if (mode === 'tritanopia') return TRITANOPIA_ENEMIES;
  return BASE_ENEMIES;
}

function xpPalette(mode: ColorVisionMode): { fill: number; stroke: number } {
  if (mode === 'deuteranopia') return { fill: 0xffd65e, stroke: 0xfff9de };
  if (mode === 'protanopia') return { fill: 0x88f4ff, stroke: 0xedfbff };
  if (mode === 'tritanopia') return { fill: 0xffea74, stroke: 0xfff9de };
  return { fill: 0xffd35a, stroke: 0xfff7d2 };
}

export function createVisualTheme(mode: ColorVisionMode): VisualThemeTokens {
  const enemies = enemyPalette(mode);
  const xp = xpPalette(mode);
  return {
    player: { fill: 0xe7ffff, stroke: 0xffffff, aura: 0x95feff },
    projectiles: {
      allied: 0x8ee9ff,
      alliedStroke: 0xf4ffff,
      enemy: 0xff7b43,
      enemyStroke: 0xfff0df
    },
    pickups: {
      xpFill: xp.fill,
      xpStroke: xp.stroke,
      chestFill: 0x4e2f21,
      chestStroke: 0xffdb95
    },
    hazards: {
      fill: 0x7e1712,
      inner: 0xffc278,
      stroke: 0xffefcb
    },
    telegraph: {
      line: 0xffc25b,
      ring: 0xfff0c6
    },
    enemies,
    elite: {
      stroke: 0xfff2bc,
      crown: 0xffd16a
    },
    backdrop: {
      floor: 0x02050b,
      canopy: 0x0d1b2b,
      fog: 0x143a4f,
      vines: 0x156756,
      grade: 0xa6ffd9,
      eventTint: 0xffd89f
    }
  };
}

function channelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hexColor: number): number {
  const r = channelToLinear((hexColor >> 16) & 0xff);
  const g = channelToLinear((hexColor >> 8) & 0xff);
  const b = channelToLinear(hexColor & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function luminanceDelta(a: number, b: number): number {
  return Math.abs(relativeLuminance(a) - relativeLuminance(b));
}
