# Fourier Reconstruction

## Overview

The Fourier Reconstruction utility performs a full-song spectral analysis using the Short-Time Fourier Transform (STFT), then lets users interactively reconstruct the audio signal from its frequency components. By adjusting a component slider, users can see how few sinusoidal signals are needed to approximate an audio waveform — from a sparse handful of the strongest frequencies up to the full proxy reconstruction.

The visualization shows both the original and reconstructed waveforms overlaid, with a playhead for live playback comparison.

## Architecture

```
Main thread (AudioFourierController)
  |
  +-- audioFourier.worker.ts (Web Worker)
        |
        +-- fft.ts (pure computation)
```

- **Main thread** (`audioFourierController.ts`): `AudioFourierController` class manages UI, file/preset selection, Web Audio API playback, and canvas rendering coordination.
- **Worker** (`audioFourier.worker.ts`): Runs the computationally expensive FFT analysis and reconstruction off the main thread.
- **FFT** (`fft.ts`): Pure JavaScript Cooley-Tukey radix-2 FFT implementation.
- **Wave renderer** (`audioFourierWaveRenderer.ts`): Dual-mode waveform renderer — WebGL when available, Canvas 2D fallback.

## Pipeline

### 1. Audio Loading

Audio can come from two sources:
- **Built-in presets** (`audioPresets.ts`): Three FLAC files shipped with the site:
  - "I Can't Wait To Get There" (default)
  - "Tell Your Friends"
  - "Best Friends"
- **User upload**: Any audio file dropped onto the dropzone.

Audio is decoded using the Web Audio API's `AudioContext.decodeAudioData()`, then downsampled to the preset's `proxySampleRate` (8000 / 22050 / 32000 Hz depending on preset).

### 2. Windowed Fourier Analysis

`buildWindowedFourierAnalysis()` in `audioFourierCore.ts`:

1. **Frame splitting**: The audio signal is split into overlapping frames of `frameSize` samples with `hopSize` stride (50% overlap).
2. **Windowing**: Each frame is multiplied by a Hann window to reduce spectral leakage.
3. **FFT**: Each windowed frame is transformed via the Cooley-Tukey FFT algorithm (`fft.ts`), producing `frameSize / 2 + 1` frequency bins (one-sided spectrum for real-valued signals).
4. **Coefficient extraction**: For each frame-bin pair, the real and imaginary components are stored, along with:
   - **Frequency**: `bin * sampleRate / frameSize`
   - **Amplitude**: One-sided amplitude normalization — DC and Nyquist bins are divided by `frameSize`, all others by `frameSize / 2`.
   - **Phase**: `atan2(imag, real)`
   - **Energy**: `real^2 + imag^2`
5. **Energy sorting**: All coefficients across all frames are sorted by energy (descending), with frequency as a tiebreaker. This produces the `componentOrder` array — the most energetically significant frequency components come first.

### 3. Component Reconstruction

`reconstructWindowedComponentCount()` and `reconstructWindowedComponentRange()` in `audioFourierCore.ts`:

- Takes the top-N energy-sorted components and reconstructs the time-domain signal using **overlap-add synthesis**.
- For each component, its frequency and amplitude are placed into the appropriate FFT bin for each frame.
- Inverse FFT is applied to each frame, then frames are overlapped and added with normalization to produce the reconstructed waveform.
- When `componentCount` equals the total coefficient count, the original signal is returned directly (optimization).

### 4. Energy Bands

Components are grouped into `energyBandCount` bands (8/12/20 depending on preset). Each band represents a fraction of the total signal energy. The slider maps to an **energy percentage** using a piecewise exponential curve:
- Below midpoint (0.5): power law with `ENERGY_SLIDER_LOW_EXPONENT`
- Above midpoint: linear interpolation from `ENERGY_SLIDER_MIDPOINT_VALUE` (0.8) to 1.0

This gives perceptually uniform control — small slider movements at the low end reveal the most significant components first.

**Per-band gains** are computed so that the selected bands include the target fraction of total energy. A makeup gain (`1 / sqrt(energyPercent)`, clamped to [1, 2.8]) compensates for perceived loudness loss.

## Visualization

### Waveform Canvas

`audioFourierWaveRenderer.ts` provides two rendering backends:

**WebGL renderer** (default when available):
- Uploads amplitude data as vertex buffers
- Renders envelope strips using triangle strips with custom shaders
- Separate programs for envelope rendering, solid lines, and texture-based empty state
- Supports WebGL1 and WebGL2

**Canvas 2D renderer** (fallback):
- Draws filled envelope paths with stroke outlines
- Glow effects via `shadowBlur`
- Playhead rendered as a vertical line

Both renderers show:
- Original signal envelope (dim, semi-transparent)
- Reconstructed signal envelope (bright, with glow)
- Playhead during playback

### Canvas sizing

- Wave canvas: max 4M backing pixels (WebGL) or 750K (Canvas 2D)
- DPR capped at 2x
- ResizeObserver monitors container changes

## Playback

The `AudioFourierController` uses the Web Audio API for live playback:

- **Band-based synthesis**: Each energy band gets its own `AudioBufferSourceNode` with a `GainNode`.
- Gains are set per-band based on the slider's energy percentage.
- A master gain node applies the makeup gain.
- Playback starts with a 35ms delay and 100ms fade-in to avoid clicks.
- The visual playhead is synced to the audio clock with reconciliation every 80ms.
- The bottom analysis track transitions into an audio timeline after generation, with elapsed and total time. Clicking seeks immediately; dragging previews the waveform and resumes on release if playback was running. Paused seeking stays paused. Arrow keys seek five seconds, Page Up/Down seek 10% of the song, and Home/End select the endpoints.
- The timeline retains its layout during the handover, fades in its playhead, and respects reduced motion. Analysis exposes a progressbar; playback exposes a labeled native range control.

## Presets

Three quality presets (`audioPresets.ts`):

| Preset | proxySampleRate | frameSize | hopSize | displaySampleCount | sliderSteps | energyBandCount |
|--------|----------------|-----------|---------|-------------------|-------------|----------------|
| Fast   | 8,000          | 1024      | 512     | 768               | 80          | 8              |
| Balanced | 22,050       | 2048      | 1024    | 1024              | 100         | 12             |
| Detailed | 32,000       | 4096      | 2048    | 1280              | 120         | 20             |

- **proxySampleRate**: Downsampled rate for analysis. Lower = faster but less frequency resolution.
- **frameSize**: FFT window size (must be power of 2). Larger = better frequency resolution, worse time resolution.
- **hopSize**: Frame stride. Always `frameSize / 2` (50% overlap for perfect reconstruction with Hann window).
- **displaySampleCount**: Number of points in the display waveform envelope.
- **sliderSteps**: Number of discrete steps in the component slider.
- **energyBandCount**: Number of frequency bands for reconstruction grouping.

## File Reference

| File | Purpose |
|------|---------|
| `audioFourierController.ts` | Main controller: UI, file handling, playback, canvas coordination |
| `audioFourierCore.ts` | FFT analysis pipeline, reconstruction, energy bands, envelope computation |
| `audioFourierWorkerTypes.ts` | Worker message type definitions |
| `audioFourierUiState.ts` | Playback button state resolution |
| `audioFourierWaveRenderer.ts` | WebGL and Canvas 2D waveform renderers |
| `audioFourier.worker.ts` | Web Worker for FFT analysis and reconstruction |
| `audioPresets.ts` | Quality presets and built-in audio file definitions |
| `audioSignal.ts` | Audio signal processing utilities |
| `fft.ts` | Cooley-Tukey radix-2 FFT implementation |
| `math.ts` | `clamp()`, `assertPowerOfTwo()`, and other math utilities |
| `bufferUtils.ts` | ArrayBuffer slicing and conversion |

## Performance Considerations

- FFT analysis runs entirely in a Web Worker to avoid blocking the UI
- The reconstruction scratch buffers are pre-allocated and reused between slider changes
- Full reconstruction at max components returns the original signal directly (no IFFT needed)
- Energy band caching avoids redundant reconstruction when the slider hasn't changed
- The worker supports cancellation via request IDs
- Console noise from the FFT worker is suppressed during loading
