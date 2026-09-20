# Utilities Documentation

The utilities page (`/pages/utilities/`) is a desktop-only curiosity-driven workbench.
Its numbered, name-only index opens three tools: Image Transform, Fourier Reconstruction,
and Stress Test. They run client-side. Virtual Machine remains preserved but hidden;
the old Local Assistant implementation has been removed.

White space, black JetBrains Mono typography, thin rules, and violet `#7050C0` controls
connect the workbench to the rest of the site. There are no introductory descriptions,
tutorials, or tooltips. Functional labels, visible state, and reset actions let users
explore. Each tool has room for its own output and control arrangement.

## Source and build

- **Editable source:** `utilities-src/src/` (TypeScript, Vite build)
- **Generated output:** `pages/utilities/assets/` — do not hand-edit
- **Entrypoint:** `utilities-src/src/main.ts` lazily initializes controllers on stage activation; retains the VM loader
- **Shared shell:** `js/utilities-shell.js` handles index/workspace hash routing, focus, heading metadata, and the workspace switcher
- **Build:** `npm run utilities:build`
- **Verify:** `npm run utilities:check && npm run utilities:browser-check && npm run utilities:perf`

## Utilities at a glance

| Utility | Description | Key files |
|---|---|---|
| **Image Transform** | Pixel-level morphing between two images using color-space matching and animated particle transitions | `transformCore.ts`, `transformIntelligence.ts`, `transformAnimation.ts`, `transform.worker.ts`, `transformCache.ts`, `transformRenderPlan.ts`, `presets.ts`, `uiState.ts` |
| **Fourier Reconstruction** | Full-song audio analysis via windowed FFT with interactive component slider and live playback | `audioFourierController.ts`, `audioFourierCore.ts`, `audioFourierWaveRenderer.ts`, `audioPresets.ts`, `fft.ts` |
| **Virtual Machine (hidden, retained)** | x86 PC emulator (v86) running Tiny Core Linux 11 in the browser with networking via TCP relay | `retroVmController.ts`, `retroVmConfig.ts`, `retroVmSupport.ts`, `retroVmTypes.ts` |
| **Stress Test** | CPU and GPU stress benchmark using Web Workers and WebGPU/WebGL compute shaders | `stressTestController.ts`, `stressTestCore.ts`, `stressTestGpu.ts`, `stressTest.worker.ts` |

## Shared infrastructure

- `workerRuntime.ts` — shared ImageTransform worker request handler with bitmap preparation and cancellation
- `math.ts` — `clamp`, `assertPowerOfTwo` and other math utilities
- `bufferUtils.ts` — ArrayBuffer slicing and conversion helpers
- `types.ts` — shared type definitions for Image Transform

See [Adding a utility](./adding-a-utility.md) for the shared workspace contract and extension checklist.

## Per-utility documentation

- [Image Transform](./image-transform.md)
- [Fourier Reconstruction](./fourier-reconstruction.md)
- [Virtual Machine](./virtual-machine.md)
- [Stress Test](./stress-test.md)
