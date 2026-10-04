// Fixed cube: front/back, right/left, top/bottom. Opposite faces sum to seven.
export const CUBE_VALUES = [1, 6, 2, 5, 3, 4] as const;
const FACE_ANGLES: readonly (readonly [number, number])[] = [
  [0, 0], [0, 0], [0, -90], [-90, 0], [90, 0], [0, 90], [0, 180]
];

export function dicePose(time: number, previous: number, next: number, index: number, size: number) {
  const t = Math.max(0, Math.min(1, time));
  const [startX, startY] = FACE_ANGLES[previous];
  const [endX, endY] = FACE_ANGLES[next];
  const direction = index % 2 ? -1 : 1;
  // A released die keeps its angular momentum in flight, then brakes smoothly.
  // Integrating a smoothstep velocity ramp avoids stop/start easing and reduces
  // peak angular speed. Both velocity and acceleration match at brake onset.
  const brakeAt = .55;
  const brake = Math.max(0, (t - brakeAt) / (1 - brakeAt));
  const rotation = (t <= brakeAt ? t : brakeAt + (1 - brakeAt) * (brake - brake ** 3 + .5 * brake ** 4)) / ((1 + brakeAt) / 2);
  // Do not add a complete turn on BOTH axes. That produced up to 630 degrees of
  // yaw alone, making pips strobe even with high-frequency browser callbacks.
  const pitchDelta = endX - startX;
  const pitchTravel = pitchDelta + (pitchDelta > 0 ? -360 : pitchDelta < 0 ? 360 : direction * 360);
  const yawTravel = ((endY - startY + 540) % 360) - 180;
  const contact = .78;
  const phase = t < contact ? t / contact : (t - contact) / (1 - contact);
  const height = t < contact ? .34 : .055;
  return {
    x: direction * size * .04 * Math.sin(2 * Math.PI * t) * Math.sin(Math.PI * t),
    y: phase === 0 || phase === 1 ? 0 : -size * height * Math.sin(Math.PI * phase) ** 2,
    z: -size / 2,
    rotateX: startX + pitchTravel * rotation,
    rotateY: startY + yawTravel * rotation,
    rotateZ: direction * 10 * Math.sin(2 * Math.PI * t) * (1 - t)
  };
}

// Shared path control points; the browser interpolates at its native refresh rate.
const OFFSETS = [...Array.from({ length: 61 }, (_, i) => i / 60), .78, .9]
  .filter((value, index, all) => all.indexOf(value) === index).sort((a, b) => a - b);
type Pose = ReturnType<typeof dicePose>;

function motionFrame(offset: number, pose: Pose): Keyframe {
  return {
    offset,
    transform: `translate3d(${pose.x}px, ${pose.y}px, ${pose.z}px) rotateX(${pose.rotateX}deg) rotateY(${pose.rotateY}deg) rotateZ(${pose.rotateZ}deg)`
  };
}

/** Opacity of a neutral shade over each white face, under a fixed upper-left light. */
export function diceFaceShades(pose: Pose): number[] {
  const radians = Math.PI / 180;
  const cx = Math.cos(pose.rotateX * radians), sx = Math.sin(pose.rotateX * radians);
  const cy = Math.cos(pose.rotateY * radians), sy = Math.sin(pose.rotateY * radians);
  const cz = Math.cos(pose.rotateZ * radians), sz = Math.sin(pose.rotateZ * radians);
  // CSS rotates Z, then Y, then X. Bring the fixed light into cube space using
  // the inverse in reverse order, then dot it with the six axis-aligned normals.
  const x = -.35, y = -.45 * cx + .82 * sx, z = .45 * sx + .82 * cx;
  const x2 = x * cy - z * sy, z2 = x * sy + z * cy;
  const localX = x2 * cz + y * sz, localY = -x2 * sz + y * cz;
  return [z2, -z2, localX, -localX, -localY, localY].map(light => {
    const shade = Math.min(.26, Math.max(0, (.82 - light) * .16));
    // Every camera-facing resting face must match the plain white die exactly.
    return shade < 1e-9 ? 0 : shade;
  });
}

function shadowFrame(offset: number, pose: Pose, size: number): Keyframe {
  const lift = size > 0 ? Math.min(1, Math.max(0, -pose.y / (size * .34))) : 0;
  const x = pose.x + size * .12 * lift;
  return {
    offset,
    // A projection onto the ground: drift and light offset, never cube rotation.
    transform: `translate3d(${Math.abs(x) < 1e-9 ? 0 : x}px, ${size * .045 * lift}px, 0px) scale(${1 + .5 * lift}, ${1 + .75 * lift})`,
    opacity: .14 - .065 * lift
  };
}

export function diceKeyframes(previous: number, next: number, index: number, size: number): Keyframe[] {
  return OFFSETS.map(offset => motionFrame(offset, dicePose(offset, previous, next, index, size)));
}

type OpacityFrame = { offset: number; opacity: number };

function compactLighting(frames: OpacityFrame[]): OpacityFrame[] {
  // Preserve the curve within less than a quarter of one 8-bit color level.
  // Native linear interpolation needs no redundant samples in flat/near-linear
  // portions; fewer keyframes reduce startup work without a per-frame JS loop.
  const keep = new Set([0, frames.length - 1]);
  const ranges: Array<[number, number]> = [[0, frames.length - 1]];
  while (ranges.length) {
    const [first, last] = ranges.pop()!;
    let largest = 1 / 1024;
    let selected = -1;
    for (let i = first + 1; i < last; i++) {
      const progress = (frames[i].offset - frames[first].offset) / (frames[last].offset - frames[first].offset);
      const expected = frames[first].opacity + (frames[last].opacity - frames[first].opacity) * progress;
      const error = Math.abs(frames[i].opacity - expected);
      if (error > largest) { largest = error; selected = i; }
    }
    if (selected >= 0) {
      keep.add(selected);
      ranges.push([first, selected], [selected, last]);
    }
  }
  return frames.filter((_, index) => keep.has(index));
}

export function diceAnimationTracks(previous: number, next: number, index: number, size: number) {
  const samples = OFFSETS.map(offset => {
    const pose = dicePose(offset, previous, next, index, size);
    return { offset, pose, shades: diceFaceShades(pose) };
  });
  return {
    motion: samples.map(({ offset, pose }) => motionFrame(offset, pose)),
    lighting: CUBE_VALUES.map((_, side) => compactLighting(samples.map(({ offset, shades }) => ({ offset, opacity: shades[side] })))),
    shadow: samples.map(({ offset, pose }) => shadowFrame(offset, pose, size))
  };
}
