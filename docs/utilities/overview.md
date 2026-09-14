# Utilities Documentation

The utilities page (`/pages/utilities/`) is an interactive dashboard housing five independent browser-based utilities. Each runs entirely client-side with no server backend.

## Source and build

- **Editable source:** `utilities-src/src/` (TypeScript, Vite build)
- **Generated output:** `pages/utilities/assets/` — do not hand-edit
- **Entrypoint:** `utilities-src/src/main.ts` bootstraps all five utility controllers
- **Shared shell:** `js/utilities-shell.js` handles tabbed navigation between utilities
- **Build:** `npm run utilities:build`
- **Verify:** `npm run utilities:check && npm run utilities:browser-check && npm run utilities:perf`

## Utilities at a glance

| Utility | Description | Key files |
|---|---|---|
| **Image Transform** | Pixel-level morphing between two images using color-space matching and animated particle transitions | `transformCore.ts`, `transformIntelligence.ts`, `transformAnimation.ts`, `transform.worker.ts`, `transformCache.ts`, `transformRenderPlan.ts`, `presets.ts`, `uiState.ts` |
| **Fourier Reconstruction** | Full-song audio analysis via windowed FFT with interactive component slider and live playback | `audioFourierController.ts`, `audioFourierCore.ts`, `audioFourierWaveRenderer.ts`, `audioPresets.ts`, `fft.ts` |
| **Local Assistant** | In-browser LLM chat (Bonsai 1.7B) running on WebGPU via Transformers.js | `local-llm-chat.js`, `local-llm-worker.js`, `local-llm-config.js`, `local-llm-cache.js`, `local-llm-rendering.js` |
| **Virtual Machine** | x86 PC emulator (v86) running Tiny Core Linux 11 in the browser with networking via TCP relay | `retroVmController.ts`, `retroVmConfig.ts`, `retroVmSupport.ts`, `retroVmTypes.ts` |
| **Stress Test** | CPU and GPU stress benchmark using Web Workers and WebGPU/WebGL compute shaders | `stressTestController.ts`, `stressTestCore.ts`, `stressTestGpu.ts`, `stressTest.worker.ts` |

## Shared infrastructure

- `workerRuntime.ts` — shared ImageTransform worker request handler with bitmap preparation and cancellation
- `math.ts` — `clamp`, `assertPowerOfTwo` and other math utilities
- `bufferUtils.ts` — ArrayBuffer slicing and conversion helpers
- `types.ts` — shared type definitions for Image Transform

## Per-utility documentation

- [Image Transform](./image-transform.md)
- [Fourier Reconstruction](./fourier-reconstruction.md)
- [Local Assistant](./local-assistant.md)
- [Virtual Machine](./virtual-machine.md)
- [Stress Test](./stress-test.md)
