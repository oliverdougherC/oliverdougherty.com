# Image Transform

## Overview

The Image Transform utility morphs one image into another through pixel-level color matching and animated particle transitions. Given a source image and a target image, it computes a bijective mapping where each source pixel is assigned to a target position, then animates the pixels traveling from their source coordinates to their target coordinates while gradually shifting color.

The result is a fluid reconstruction animation where the source image dissolves and reforms into the target image.

## Architecture

```
Main thread (UtilitiesApp)
  |
  +-- transform.worker.ts (Web Worker)
```

- **Main thread** (`main.ts`): `UtilitiesApp` class handles all UI interactions, file selection, demo loading, progress reporting, and canvas rendering.
- **Transform worker** (`transform.worker.ts`): Receives `ImageBitmap` objects, decodes and scales them, then runs the full matching pipeline. Communicates via structured clone / transferable ArrayBuffers.

## Pipeline

The transform computation happens in four stages:

### 1. Decoding

Both source and target images are decoded into `ImageBitmap`, then drawn onto `OffscreenCanvas` at the preset's `maxDimension`. Images are scaled to fit within the max dimension while preserving aspect ratio, then centered with transparent padding. The pixel data is extracted as `Uint8ClampedArray` RGBA.

Key constant: `MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024` (20 MB file size limit).

### 2. Analysis

`analyzeTransformImages()` in `transformIntelligence.ts` computes per-pixel metadata for both images:

**Source image:**
- `sourceUsefulnessByIndex` — how "valuable" each source pixel is as a donor. Computed as:
  ```
  usefulness = contrast * 0.42 + rarity * 0.34 + (1 - nearWhite) * 0.24
  ```
  where `rarity = 1 - sqrt(bucketFrequency)`. Pixels in flat, near-white areas get heavily penalized (multiplied by 0.12 if nearWhite > 0.96 and contrast < 0.05).
- `sourceNearWhiteByIndex` — how close each pixel is to white, using brightness and chroma.

**Target image:**
- `targetNeedByIndex` — how much each target position "needs" a good donor pixel:
  ```
  need = (1 - nearWhite) * 0.28 + contrast * 0.72
  ```
- `targetPriorityByIndex` — processing order: `need * 0.82 + (1 - nearWhite) * 0.18`

**Local contrast** is computed using a 4-neighbor (up/down/left/right) average of per-channel normalized distances. Edge pixels use fewer neighbors.

**Color rarity** uses quantized bucket counts: `shift = 8 - quantizationBits`, then counts how many source pixels share each quantized color key. Rare colors yield higher rarity scores.

### 3. Ranking and Assignment

The core matching algorithm (`transformCore.ts`) assigns each target pixel to exactly one source pixel:

1. **Bucket index construction**: Source pixels are grouped by quantized color into buckets. Each bucket contains color groups (exact RGB matches within the quantized bucket). Groups are sorted by donor usefulness.

2. **Target processing order**: Target pixels are sorted by `targetPriorityByIndex` (descending) — high-need, high-contrast positions are filled first.

3. **Shell search**: For each target pixel, the algorithm searches for candidate source donors:
   - Start with the exact quantized color bucket (radius 0)
   - Expand outward in shells (radius 1, 2, ...) through neighboring quantized color buckets
   - For each candidate, compute a weighted RGB distance score with penalties:
     ```
     distance = weightedRgbDistance(source, target)
               + (1 - donorUsefulness) * targetNeed * 50000
               + donorNearWhite * targetNeed * 34000
               + donorUsefulness * targetFlatBright * 14000
     ```
   - Shortlist the top candidates per target

4. **Assignment merge**: Candidates are merged into a final bijective assignment. Each source pixel can only be used once. When a source pixel is consumed, the next-best donor from the same color group is used.

**Weighted RGB distance** (`transformIntelligence.ts`): A CIE76-like perceptual metric that weights red/blue channels based on the mean red value:
```
distance = ((512 + redMean) * deltaR^2) / 256 + 4 * deltaG^2 + ((767 - redMean) * deltaB^2) / 256
```

### 4. Render Plan

`buildTransformRenderPlan()` in `transformRenderPlan.ts` computes the final pixel colors and tint strengths:

- **Tint strength** per target pixel determines how much the assigned source pixel's color is blended toward the true target color:
  ```
  tint = distanceNormalized * 0.48
        + donorDeficit * targetNeed * 0.78
        + whiteMismatch * 0.72
  ```
  where `donorDeficit = 1 - usefulness` and `whiteMismatch = sourceNearWhite * (1 - targetNearWhite)`.

- Multipliers reduce tint for good matches:
  - `EXACT_MATCH_TINT_MULTIPLIER = 0.12` (distance < 0.025, deficit < 0.22)
  - `CLOSE_MATCH_TINT_MULTIPLIER = 0.45` (distance < 0.08, not near-white)
  - `FLAT_BRIGHT_TINT_MULTIPLIER = 0.42` (target is near-white with low need)

- **Final pixels** are computed by mixing source and target colors using the tint strength.
- **Cheated target pixels** flag which target positions received a tint > 0.08 (i.e., needed color correction).

## Control panel and playback

The source and target frames share the sidebar height left after settings and presets.
Settings stay anchored at the bottom. At very short desktop heights (560px and below),
the two inputs sit side by side. Each image fills its own frame's width and remains square and vertically centered.
A shorter frame crops vertically without changing image scale; switching to the
side-by-side layout reduces image size to match the narrower frame. Labels and Choose controls remain visible and unclipped.

After generation, playback starts automatically and advances `#transformTimeline`.
The native range uses 0–1000 to select animation phase, with a percentage readout.
Pointer-down pauses immediately; dragging or keyboard changes render the selected
frame in either direction. Releasing the input never resumes automatically. Resume
continues from that position; at 100%, Replay starts again. Reset or invalidating a
result disables and resets the range. Reduced-motion generation shows the final frame
immediately; manual seeking and an explicit Play action remain available.

The same deterministic renderer is used for automatic playback and seeking. Each
render resets its scratch buffers, so visiting a phase produces the same pixels
regardless of the order in which frames were visited.

## Animation System

The animation (`transformAnimation.ts`) interpolates each source pixel from its original position to its assigned target position:

- **Easing**: `easeInOutCubic` for position interpolation
- **Tint phase**: `smoothstep(phase, 0.28, 0.96)` — color blending starts at 28% through the animation and completes at 96%
- **Draw priority**: When multiple pixels land on the same screen position during transit, a priority system determines which renders on top:
  - Stationary pixels (source == target) get priority 4
  - Pixels with shorter travel distance get higher priority
  - Higher tint strength slightly increases priority
  - Source index provides stable tie-breaking

Each frame, all pixels are rendered at their interpolated positions with their interpolated colors. The animation runs at 60fps for `animationDurationMs` milliseconds (preset-dependent).

## Presets

Three presets defined in `presets.ts`:

| Preset | maxDimension | quantizationBits | animationDurationMs | animationParticleBudget |
|--------|-------------|-----------------|---------------------|------------------------|
| Fast   | 256         | 4               | 2400                | 1100                   |
| Balanced | 384       | 5               | 3200                | 1800                   |
| Detailed | 512       | 6               | 4000                | 2600                   |

- **maxDimension**: Both images are scaled to fit within this square. Higher = more detail but slower.
- **quantizationBits**: Number of bits per color channel for bucketing. 4 bits = 16 levels/channel (4096 buckets), 6 bits = 64 levels/channel (262144 buckets). More bits = finer color matching but slower search.
- **animationDurationMs**: Total animation length.
- **animationParticleBudget**: Used for rendering optimizations.

## Built-in Demos and Caching

Three demo pairs are preconfigured in `uiState.ts`:

| Demo key | Source | Target |
|----------|--------|--------|
| pattern-face | pattern.png | face.png |
| source-target | pattern.png | lucki.jpeg |
| face-pattern | pattern.png | keef.jpeg |

Precomputed transform data is stored as base64-encoded JSON files in `src/data/precomputed-transforms/`. The `transformCache.ts` module handles:
- Serializing worker results (assignment, final pixels, tint strengths) to base64
- Hydrating precomputed data back into ArrayBuffer form
- In-memory caching of computed transforms via `Map<string, CachedBuiltInTransform>`
- Cache key format: `${presetId}\u001f${sourceUrl}\u001f${targetUrl}`

When a demo pair is selected and generated, the system first checks the cache. If a precomputed transform exists for that preset/demo combination, it loads instantly. Otherwise it computes and caches the result.

## File Reference

| File | Purpose |
|------|---------|
| `main.ts` | `UtilitiesApp` class — UI controller, file handling, demo loading, animation loop |
| `transformCore.ts` | Core matching pipeline: bucket construction, shell search, assignment merge |
| `transformIntelligence.ts` | Image analysis: contrast, near-white, usefulness, need, weighted RGB distance |
| `transformAnimation.ts` | Animation state creation and per-frame pixel rendering |
| `transformRenderPlan.ts` | Final pixel computation, tint strength calculation |
| `transformCache.ts` | Serialization/deserialization of precomputed transforms, in-memory cache |
| `transform.worker.ts` | Web Worker entry — bitmap decoding, pipeline orchestration |
| `workerRuntime.ts` | Shared worker request handler with bitmap preparation and cancellation |
| `workerTypes.ts` | Worker message type definitions |
| `presets.ts` | Fast/Balanced/Detailed preset definitions |
| `uiState.ts` | Demo pair definitions, state types, playback button logic |
| `types.ts` | Shared type definitions (TransformPreset, PreparedImageData, TransformMetadata, etc.) |
| `builtInTransformAssets.ts` | Precomputed transform asset imports |
| `math.ts` | `clamp()` and other math utilities |
| `bufferUtils.ts` | ArrayBuffer slicing and conversion helpers |

## Performance Considerations

- Images above the preset's maxDimension are scaled down, reducing pixel count quadratically
- Quantization reduces the color search space: 4-bit = ~4K buckets, 6-bit = ~262K buckets
- The shell search starts at radius 0 and expands outward, so most target pixels find matches quickly
- Donor groups are pre-sorted by usefulness, so the best donor is always checked first
- Worker cancellation uses a request ID counter — new requests invalidate in-flight computations
- `prefers-reduced-motion` is respected: animation is skipped, final result shown directly
