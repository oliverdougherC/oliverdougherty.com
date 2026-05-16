import type { TransformPreset } from './types';

export interface TransformAnimationInput {
  width: number;
  height: number;
  sourcePixels: Uint8ClampedArray;
  finalPixels: Uint8ClampedArray;
  assignment: Uint32Array;
  tintStrengthByTarget: Float32Array;
  cheatedTargetPixels: Uint8Array;
  preset: TransformPreset;
}

export interface TransformAnimationState {
  width: number;
  height: number;
  sourcePixels: Uint8ClampedArray;
  finalPixels: Uint8ClampedArray;
  targetIndexBySource: Uint32Array;
  tintStrengthBySource: Float32Array;
  cheatedTargetPixels: Uint8Array;
  positionPriorityScratch: Float32Array;
  sourceXBySource: Uint16Array;
  sourceYBySource: Uint16Array;
  targetXBySource: Uint16Array;
  targetYBySource: Uint16Array;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function easeInOutCubic(value: number) {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function smoothstep(value: number, start: number, end: number) {
  if (start === end) {
    return value >= end ? 1 : 0;
  }

  const normalized = clamp((value - start) / (end - start), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function buildTargetIndexBySource(assignment: Uint32Array) {
  const targetIndexBySource = new Uint32Array(assignment.length);

  for (let targetIndex = 0; targetIndex < assignment.length; targetIndex += 1) {
    targetIndexBySource[assignment[targetIndex]] = targetIndex;
  }

  return targetIndexBySource;
}

function buildTintStrengthBySource(targetIndexBySource: Uint32Array, tintStrengthByTarget: Float32Array) {
  const tintStrengthBySource = new Float32Array(targetIndexBySource.length);

  for (let sourceIndex = 0; sourceIndex < targetIndexBySource.length; sourceIndex += 1) {
    tintStrengthBySource[sourceIndex] = tintStrengthByTarget[targetIndexBySource[sourceIndex]];
  }

  return tintStrengthBySource;
}

function mixChannel(sourceValue: number, finalValue: number, tintPhase: number) {
  return Math.round(sourceValue + (finalValue - sourceValue) * tintPhase);
}

export function createTransformAnimationState(input: TransformAnimationInput): TransformAnimationState {
  const targetIndexBySource = buildTargetIndexBySource(input.assignment);
  const sourceXBySource = new Uint16Array(targetIndexBySource.length);
  const sourceYBySource = new Uint16Array(targetIndexBySource.length);
  const targetXBySource = new Uint16Array(targetIndexBySource.length);
  const targetYBySource = new Uint16Array(targetIndexBySource.length);

  for (let sourceIndex = 0; sourceIndex < targetIndexBySource.length; sourceIndex += 1) {
    const targetIndex = targetIndexBySource[sourceIndex];
    sourceXBySource[sourceIndex] = sourceIndex % input.width;
    sourceYBySource[sourceIndex] = Math.floor(sourceIndex / input.width);
    targetXBySource[sourceIndex] = targetIndex % input.width;
    targetYBySource[sourceIndex] = Math.floor(targetIndex / input.width);
  }

  return {
    width: input.width,
    height: input.height,
    sourcePixels: input.sourcePixels,
    finalPixels: input.finalPixels,
    targetIndexBySource,
    tintStrengthBySource: buildTintStrengthBySource(targetIndexBySource, input.tintStrengthByTarget),
    cheatedTargetPixels: input.cheatedTargetPixels,
    positionPriorityScratch: new Float32Array(input.assignment.length),
    sourceXBySource,
    sourceYBySource,
    targetXBySource,
    targetYBySource
  };
}

export function renderTransformAnimationPixels(
  state: TransformAnimationState,
  phase: number,
  destination: Uint8ClampedArray<ArrayBufferLike>
) {
  if (destination.length !== state.finalPixels.length) {
    throw new Error('Animation destination buffer must match the final pixel buffer length.');
  }

  const resolvedPhase = clamp(phase, 0, 1);

  if (resolvedPhase <= 0) {
    destination.set(state.sourcePixels);
    return destination;
  }

  if (resolvedPhase >= 1) {
    destination.set(state.finalPixels);
    return destination;
  }

  destination.fill(0);
  state.positionPriorityScratch.fill(-1);

  const easedPhase = easeInOutCubic(resolvedPhase);
  const tintPhaseBase = smoothstep(resolvedPhase, 0.28, 0.96);

  for (let sourceIndex = 0; sourceIndex < state.targetIndexBySource.length; sourceIndex += 1) {
    const targetIndex = state.targetIndexBySource[sourceIndex];
    const sourceX = state.sourceXBySource[sourceIndex];
    const sourceY = state.sourceYBySource[sourceIndex];
    const targetX = state.targetXBySource[sourceIndex];
    const targetY = state.targetYBySource[sourceIndex];
    const currentX = Math.round(sourceX + (targetX - sourceX) * easedPhase);
    const currentY = Math.round(sourceY + (targetY - sourceY) * easedPhase);
    const boundedX = clamp(currentX, 0, state.width - 1);
    const boundedY = clamp(currentY, 0, state.height - 1);
    const destinationIndex = boundedY * state.width + boundedX;
    const travelDistance = Math.abs(targetX - sourceX) + Math.abs(targetY - sourceY);
    const drawPriority =
      (sourceIndex === targetIndex ? 4 : 0) +
      1 / (travelDistance + 1) +
      state.tintStrengthBySource[sourceIndex] * 0.01 +
      sourceIndex / (state.targetIndexBySource.length * 1_000_000);

    if (drawPriority < state.positionPriorityScratch[destinationIndex]) {
      continue;
    }

    state.positionPriorityScratch[destinationIndex] = drawPriority;

    const sourceOffset = sourceIndex * 4;
    const targetOffset = targetIndex * 4;
    const tintStrength = state.tintStrengthBySource[sourceIndex];
    const tintPhase = tintPhaseBase * tintStrength;
    const writeOffset = destinationIndex * 4;

    destination[writeOffset] = mixChannel(state.sourcePixels[sourceOffset], state.finalPixels[targetOffset], tintPhase);
    destination[writeOffset + 1] = mixChannel(
      state.sourcePixels[sourceOffset + 1],
      state.finalPixels[targetOffset + 1],
      tintPhase
    );
    destination[writeOffset + 2] = mixChannel(
      state.sourcePixels[sourceOffset + 2],
      state.finalPixels[targetOffset + 2],
      tintPhase
    );
    destination[writeOffset + 3] = 255;
  }

  return destination;
}
