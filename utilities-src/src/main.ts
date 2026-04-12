import { getPreset } from './presets';
import { PRECOMPUTED_BUILT_IN_TRANSFORM_ASSETS } from './builtInTransformAssets';
import { buildTransformRenderPlan } from './transformRenderPlan';
import {
  buildBuiltInTransformCacheKey,
  cloneCachedBuiltInTransform,
  createCachedBuiltInTransform,
  hydratePrecomputedBuiltInTransform,
  type SerializedPrecomputedBuiltInTransform,
  type CachedBuiltInTransform
} from './transformCache';
import { DeathCalculatorController } from './deathCalculatorController';
import { AudioFourierController } from './audioFourierController';
import {
  createTransformAnimationState,
  renderTransformAnimationPixels,
  resolveAccentParticlesFrame,
  type TransformAnimationState
} from './transformAnimation';
import { resolveOutputDimensions, transformPreparedImages } from './transformCore';
import { RetroVmController } from './retroVmController';
import type { PreparedImageTransfer, TransformMetadata, TransformPresetId } from './types';
import { DEMOS, resolvePlaybackButtonLabel, type ImageSelection, type SelectionKind, type StateKind } from './uiState';
import type { WorkerRequest, WorkerResponse, WorkerSuccessMessage } from './workerTypes';

interface HydratedTransfer {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

interface ActiveTransform {
  metadata: TransformMetadata;
  source: HydratedTransfer;
  target: HydratedTransfer;
  assignment: Uint32Array;
}

function asArrayBuffer(buffer: ArrayBufferLike) {
  return buffer as ArrayBuffer;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

class UtilitiesApp {
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly root: HTMLElement;
  private readonly sourceInput: HTMLInputElement;
  private readonly targetInput: HTMLInputElement;
  private readonly presetSelect: HTMLSelectElement;
  private readonly generateButton: HTMLButtonElement;
  private readonly swapButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly playButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly statusChip: HTMLElement | null;
  private readonly statusText: HTMLElement | null;
  private readonly progressText: HTMLElement;
  private readonly progressMeta: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly sourceSelectionLabel: HTMLElement;
  private readonly targetSelectionLabel: HTMLElement;
  private readonly sourceMeta: HTMLElement;
  private readonly targetMeta: HTMLElement;
  private readonly resultMeta: HTMLElement | null;
  private readonly outputSize: HTMLElement;
  private readonly pixelCount: HTMLElement;
  private readonly duration: HTMLElement;
  private readonly sourcePlaceholder: HTMLElement;
  private readonly targetPlaceholder: HTMLElement;
  private readonly resultPlaceholder: HTMLElement;
  private readonly sourceDropzone: HTMLElement;
  private readonly targetDropzone: HTMLElement;
  private readonly sourceCanvas: HTMLCanvasElement;
  private readonly targetCanvas: HTMLCanvasElement;
  private readonly resultCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly sourceContext: CanvasRenderingContext2D;
  private readonly targetContext: CanvasRenderingContext2D;
  private readonly resultContext: CanvasRenderingContext2D;
  private readonly overlayContext: CanvasRenderingContext2D;
  private readonly demoButtons: HTMLButtonElement[];
  private readonly builtInTransformCache = new Map<string, CachedBuiltInTransform>();
  private readonly builtInTransformAssetPromises = new Map<string, Promise<SerializedPrecomputedBuiltInTransform>>();

  private sourceSelection: ImageSelection | null = null;
  private targetSelection: ImageSelection | null = null;
  private worker: Worker | null = null;
  private activeRequestId = 0;
  private activeWorkerRequestId = 0;
  private activeTransform: ActiveTransform | null = null;
  private animationState: TransformAnimationState | null = null;
  private animationFramePixels: Uint8ClampedArray | null = null;
  private finalResultImageData: ImageData | null = null;
  private animationFrameId = 0;
  private animationStartedAt = 0;
  private animationElapsedMs = 0;
  private state: StateKind = 'idle';
  private workerUnavailable = false;
  private workerFallbackScheduled = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.sourceInput = this.requireElement('transformSourceInput');
    this.targetInput = this.requireElement('transformTargetInput');
    this.presetSelect = this.requireElement('transformPreset');
    this.generateButton = this.requireElement('transformGenerateBtn');
    this.swapButton = this.requireElement('transformSwapBtn');
    this.resetButton = this.requireElement('transformResetBtn');
    this.playButton = this.requireElement('transformPlayBtn');
    this.pauseButton = this.requireElement('transformPauseBtn');
    this.statusChip = document.getElementById('transformStatusChip');
    this.statusText = document.getElementById('transformStatusText');
    this.progressText = this.requireElement('transformProgressText');
    this.progressMeta = this.requireElement('transformProgressMeta');
    this.progressBar = this.requireElement('transformProgressBar');
    this.progressFill = this.requireElement('transformProgressFill');
    this.sourceSelectionLabel = this.requireElement('transformSourceSelection');
    this.targetSelectionLabel = this.requireElement('transformTargetSelection');
    this.sourceMeta = this.requireElement('transformSourceMeta');
    this.targetMeta = this.requireElement('transformTargetMeta');
    this.resultMeta = document.getElementById('transformResultMeta');
    this.outputSize = this.requireElement('transformOutputSize');
    this.pixelCount = this.requireElement('transformPixelCount');
    this.duration = this.requireElement('transformDuration');
    this.sourcePlaceholder = this.requireElement('transformSourcePlaceholder');
    this.targetPlaceholder = this.requireElement('transformTargetPlaceholder');
    this.resultPlaceholder = this.requireElement('transformResultPlaceholder');
    this.sourceDropzone = this.requireElement('sourceDropzone');
    this.targetDropzone = this.requireElement('targetDropzone');
    this.sourceCanvas = this.requireElement('transformSourceCanvas');
    this.targetCanvas = this.requireElement('transformTargetCanvas');
    this.resultCanvas = this.requireElement('transformResultCanvas');
    this.overlayCanvas = this.requireElement('transformOverlayCanvas');
    this.demoButtons = Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-demo-key]'));

    this.sourceContext = this.getContext(this.sourceCanvas);
    this.targetContext = this.getContext(this.targetCanvas);
    this.resultContext = this.getContext(this.resultCanvas);
    this.overlayContext = this.getContext(this.overlayCanvas);
    this.overlayContext.imageSmoothingEnabled = false;
  }

  init() {
    this.sourceInput.addEventListener('change', () => {
      this.handleFileSelection('source', this.sourceInput.files?.[0] ?? null);
    });
    this.targetInput.addEventListener('change', () => {
      this.handleFileSelection('target', this.targetInput.files?.[0] ?? null);
    });
    this.generateButton.addEventListener('click', () => {
      void this.generateTransform();
    });
    this.swapButton.addEventListener('click', () => {
      void this.swapSelections();
    });
    this.resetButton.addEventListener('click', () => {
      this.resetAll();
    });
    this.playButton.addEventListener('click', () => this.handlePlaybackButton());
    this.pauseButton.addEventListener('click', () => this.pauseAnimation());
    this.presetSelect.addEventListener('change', () => {
      const preset = getPreset(this.selectedPreset);
      if (this.activeTransform) {
        this.invalidateComputedState(`Preset changed to ${preset.label}. Generate again to rebuild the transform.`);
        return;
      }
      this.progressMeta.textContent = `${preset.label} preset · up to ${preset.maxDimension}px working size`;
    });

    this.demoButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const demoKey = button.dataset.demoKey;
        if (!demoKey || !(demoKey in DEMOS)) {
          return;
        }
        this.applyDemo(demoKey);
      });
    });

    this.bindDropzone(this.sourceDropzone, 'source');
    this.bindDropzone(this.targetDropzone, 'target');
    this.syncSelectionLabels();
    this.syncButtons();
    this.applyDemo('pattern-face');
  }

  private get selectedPreset(): TransformPresetId {
    return this.presetSelect.value as TransformPresetId;
  }

  private requireElement<T extends HTMLElement>(id: string) {
    const element = document.getElementById(id) as T | null;
    if (!element) {
      throw new Error(`Missing required element: ${id}`);
    }
    return element;
  }

  private setResultMetaCopy(text: string) {
    this.root.dataset.resultMetaMessage = text;
    if (this.resultMeta) {
      this.resultMeta.textContent = text;
    }
  }

  private getContext(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to acquire 2D canvas context.');
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    return context;
  }

  private bindDropzone(element: HTMLElement, kind: SelectionKind) {
    const preventDefaults = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    ['dragenter', 'dragover'].forEach((eventName) => {
      element.addEventListener(eventName, (event) => {
        preventDefaults(event as DragEvent);
        element.classList.add('drag-active');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      element.addEventListener(eventName, (event) => {
        preventDefaults(event as DragEvent);
        element.classList.remove('drag-active');
      });
    });

    element.addEventListener('drop', (event) => {
      const dragEvent = event as DragEvent;
      const file = dragEvent.dataTransfer?.files?.[0] ?? null;
      this.handleFileSelection(kind, file);
    });
  }

  private handleFileSelection(kind: SelectionKind, file: File | null) {
    if (!file) {
      return;
    }

    const nextSelection: ImageSelection = {
      kind: 'file',
      label: file.name,
      file
    };

    if (kind === 'source') {
      this.sourceSelection = nextSelection;
      this.sourceInput.value = '';
    } else {
      this.targetSelection = nextSelection;
      this.targetInput.value = '';
    }

    this.discardActiveRequest();
    this.clearActiveDemo();
    this.syncSelectionLabels();
    this.invalidateComputedState('Selection updated. Generate again to rebuild the transform.');
  }

  private applyDemo(demoKey: string) {
    const demo = DEMOS[demoKey];
    this.discardActiveRequest();
    this.sourceSelection = demo.source;
    this.targetSelection = demo.target;
    this.syncActiveDemo();
    this.syncSelectionLabels();
    this.invalidateComputedState('Built-in pair selected. Press generate to load the transform.');
  }

  private clearActiveDemo() {
    this.demoButtons.forEach((button) => button.classList.remove('active'));
  }

  private syncActiveDemo() {
    const activeDemoKey = this.resolveActiveDemoKey();
    this.demoButtons.forEach((button) => {
      button.classList.toggle('active', Boolean(activeDemoKey) && button.dataset.demoKey === activeDemoKey);
    });
  }

  private resolveActiveDemoKey() {
    if (!this.sourceSelection || !this.targetSelection) {
      return null;
    }

    for (const [demoKey, demo] of Object.entries(DEMOS)) {
      if (
        this.sourceSelection.kind === 'demo' &&
        this.targetSelection.kind === 'demo' &&
        this.sourceSelection.url === demo.source.url &&
        this.targetSelection.url === demo.target.url
      ) {
        return demoKey;
      }
    }

    return null;
  }

  private syncSelectionLabels() {
    this.sourceSelectionLabel.textContent = this.sourceSelection ? this.sourceSelection.label : 'No source selected';
    this.targetSelectionLabel.textContent = this.targetSelection ? this.targetSelection.label : 'No target selected';
    this.syncButtons();
  }

  private syncButtons() {
    const hasBothSelections = Boolean(this.sourceSelection && this.targetSelection);
    const hasResult = Boolean(this.activeTransform);
    const isProcessing = this.state === 'processing';
    const isAnimating = this.state === 'animating';

    this.playButton.textContent = resolvePlaybackButtonLabel({
      hasResult,
      isProcessing,
      isAnimating,
      reducedMotion: this.reducedMotion,
      animationElapsedMs: this.animationElapsedMs
    });
    this.presetSelect.disabled = isProcessing;
    this.generateButton.disabled = !hasBothSelections || isProcessing;
    this.swapButton.disabled = !hasBothSelections || isProcessing;
    this.resetButton.disabled = isProcessing && !hasResult;
    this.playButton.disabled = !hasResult || isProcessing || isAnimating || this.reducedMotion;
    this.pauseButton.disabled = !hasResult || !isAnimating;
  }

  private setState(state: StateKind, text: string) {
    this.state = state;
    if (this.statusText) {
      this.statusText.textContent = text;
    }
    this.root.dataset.transformStatusMessage = text;
    const chipLabel =
      state === 'ready' ? 'Ready' : state === 'complete' ? 'Complete' : state[0].toUpperCase() + state.slice(1);
    this.root.dataset.transformStatusChip = chipLabel;
    if (this.statusChip) {
      this.statusChip.textContent = chipLabel;
      this.statusChip.className = `utility-status-chip utility-status-chip--${state}`;
    }
    this.syncButtons();
  }

  private setProgress(progress: number, text: string, meta?: string) {
    const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
    this.progressText.textContent = text;
    if (meta) {
      this.progressMeta.textContent = meta;
    }
    this.progressFill.style.width = `${percent}%`;
    this.progressBar.setAttribute('aria-valuenow', String(percent));
  }

  private clearDiagnostics() {
    delete this.root.dataset.lastRequestId;
    delete this.root.dataset.matcherStrategy;
    delete this.root.dataset.fallbackCount;
    delete this.root.dataset.shortlistHitRate;
    delete this.root.dataset.decodeMs;
    delete this.root.dataset.analyzeMs;
    delete this.root.dataset.rankMs;
    delete this.root.dataset.assignMs;
    delete this.root.dataset.totalMs;
    delete this.root.dataset.evaluatedCandidateCount;
    delete this.root.dataset.evaluatedGroupCount;
    delete this.root.dataset.averageGroupsPerTarget;
  }

  private discardActiveRequest() {
    if (this.activeRequestId <= 0) {
      return;
    }

    this.abandonActiveComputation();
    this.activeRequestId += 1;
  }

  private isCurrentRequest(requestId: number) {
    return requestId === this.activeRequestId;
  }

  private clearActiveWorkerRequest(requestId: number) {
    if (this.activeWorkerRequestId === requestId) {
      this.activeWorkerRequestId = 0;
    }
  }

  private abandonActiveComputation() {
    if (this.activeWorkerRequestId > 0) {
      this.cancelActiveRequest(this.activeWorkerRequestId);
      this.activeWorkerRequestId = 0;
    }

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  private clearAllCanvases() {
    this.sourceContext.clearRect(0, 0, this.sourceCanvas.width, this.sourceCanvas.height);
    this.targetContext.clearRect(0, 0, this.targetCanvas.width, this.targetCanvas.height);
    this.clearResultSurfaces();
  }

  private invalidateComputedState(statusText: string) {
    this.pauseAnimation();
    this.activeTransform = null;
    this.animationState = null;
    this.animationFramePixels = null;
    this.finalResultImageData = null;
    this.clearDiagnostics();
    this.clearAllCanvases();
    this.updateCanvasPlaceholder(this.sourcePlaceholder, true);
    this.updateCanvasPlaceholder(this.targetPlaceholder, true);
    this.updateCanvasPlaceholder(this.resultPlaceholder, true);
    this.sourceMeta.textContent = this.sourceSelection
      ? 'Generate a transform to preview the selected source image.'
      : 'Waiting for an image.';
    this.targetMeta.textContent = this.targetSelection
      ? 'Generate a transform to preview the selected target image.'
      : 'Waiting for an image.';
    this.setResultMetaCopy(
      this.sourceSelection && this.targetSelection
        ? 'Generate a transform to rebuild the current image pair.'
        : 'Generate a transform to begin the animation.'
    );
    this.outputSize.textContent = '—';
    this.pixelCount.textContent = '—';
    this.duration.textContent = '—';
    const preset = getPreset(this.selectedPreset);
    this.setState('idle', statusText);
    this.setProgress(
      0,
      this.sourceSelection && this.targetSelection
        ? 'Selections are ready. Generate a new transform to continue.'
        : 'Ready for input.',
      `${preset.label} preset · up to ${preset.maxDimension}px working size`
    );
  }

  private syncDiagnostics(metadata: TransformMetadata, requestId: number) {
    this.root.dataset.lastRequestId = String(requestId);
    this.root.dataset.matcherStrategy = metadata.matcherStrategy;
    this.root.dataset.fallbackCount = String(metadata.fallbackCount);
    this.root.dataset.shortlistHitRate = metadata.shortlistHitRate.toFixed(4);
    this.root.dataset.decodeMs = metadata.timingsMs.decode.toFixed(2);
    this.root.dataset.analyzeMs = metadata.timingsMs.analyze.toFixed(2);
    this.root.dataset.rankMs = metadata.timingsMs.rank.toFixed(2);
    this.root.dataset.assignMs = metadata.timingsMs.assign.toFixed(2);
    this.root.dataset.totalMs = metadata.timingsMs.total.toFixed(2);
    this.root.dataset.evaluatedCandidateCount = String(metadata.evaluatedCandidateCount);
    this.root.dataset.evaluatedGroupCount = String(metadata.evaluatedGroupCount);
    this.root.dataset.averageGroupsPerTarget = metadata.averageGroupsPerTarget.toFixed(4);
  }

  private getBuiltInTransformCacheKey(presetId: TransformPresetId) {
    return buildBuiltInTransformCacheKey(this.sourceSelection, this.targetSelection, presetId);
  }

  private getPrecomputedBuiltInTransformAssetUrl(presetId: TransformPresetId) {
    const cacheKey = this.getBuiltInTransformCacheKey(presetId);
    if (!cacheKey) {
      return null;
    }

    return PRECOMPUTED_BUILT_IN_TRANSFORM_ASSETS[cacheKey] ?? null;
  }

  private getCachedBuiltInTransform(requestId: number, presetId: TransformPresetId) {
    const cacheKey = this.getBuiltInTransformCacheKey(presetId);
    if (!cacheKey) {
      return null;
    }

    const cached = this.builtInTransformCache.get(cacheKey);
    return cached ? cloneCachedBuiltInTransform(cached, requestId) : null;
  }

  private storeBuiltInTransform(message: WorkerSuccessMessage, renderPlan: ReturnType<typeof buildTransformRenderPlan>) {
    const cacheKey = this.getBuiltInTransformCacheKey(message.metadata.presetId);
    if (!cacheKey) {
      return;
    }

    this.builtInTransformCache.set(cacheKey, createCachedBuiltInTransform(message, renderPlan));
  }

  private async loadPrecomputedBuiltInTransformAsset(
    presetId: TransformPresetId
  ): Promise<SerializedPrecomputedBuiltInTransform | null> {
    const cacheKey = this.getBuiltInTransformCacheKey(presetId);
    const assetUrl = this.getPrecomputedBuiltInTransformAssetUrl(presetId);
    if (!cacheKey || !assetUrl) {
      return null;
    }

    let assetPromise = this.builtInTransformAssetPromises.get(cacheKey);
    if (!assetPromise) {
      assetPromise = fetch(assetUrl).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Unable to load precomputed built-in transform asset: ${response.status}`);
        }

        return (await response.json()) as SerializedPrecomputedBuiltInTransform;
      });
      this.builtInTransformAssetPromises.set(cacheKey, assetPromise);
    }

    try {
      return await assetPromise;
    } catch (error) {
      this.builtInTransformAssetPromises.delete(cacheKey);
      throw error;
    }
  }

  private async restorePrecomputedBuiltInTransform(
    requestId: number,
    presetId: TransformPresetId
  ) {
    const serialized = await this.loadPrecomputedBuiltInTransformAsset(presetId);
    if (!serialized) {
      return null;
    }

    let sourceBitmap: ImageBitmap | null = null;
    let targetBitmap: ImageBitmap | null = null;

    try {
      const settled = await Promise.allSettled([
        this.selectionToBitmap(this.sourceSelection as ImageSelection),
        this.selectionToBitmap(this.targetSelection as ImageSelection)
      ]);
      const sourceResult = settled[0];
      const targetResult = settled[1];

      if (sourceResult.status !== 'fulfilled' || targetResult.status !== 'fulfilled') {
        if (sourceResult.status === 'fulfilled') {
          sourceResult.value.close();
        }
        if (targetResult.status === 'fulfilled') {
          targetResult.value.close();
        }
        throw sourceResult.status === 'rejected'
          ? sourceResult.reason
          : targetResult.status === 'rejected'
            ? targetResult.reason
            : new Error('Unable to load demo assets.');
      }

      sourceBitmap = sourceResult.value;
      targetBitmap = targetResult.value;

      const hydrated = hydratePrecomputedBuiltInTransform(serialized);
      const preset = getPreset(presetId);
      const prepared = this.prepareBitmapsOnMainThread(sourceBitmap, targetBitmap, preset.maxDimension);
      sourceBitmap.close();
      targetBitmap.close();
      sourceBitmap = null;
      targetBitmap = null;

      if (
        prepared.source.width !== hydrated.metadata.outputWidth ||
        prepared.source.height !== hydrated.metadata.outputHeight
      ) {
        throw new Error('Precomputed built-in transform dimensions do not match the prepared demo assets.');
      }

      return {
        message: {
          type: 'success' as const,
          requestId,
          source: prepared.source,
          target: prepared.target,
          assignment: hydrated.assignment,
          metadata: {
            ...hydrated.metadata,
            sourceOriginalWidth: prepared.source.originalWidth,
            sourceOriginalHeight: prepared.source.originalHeight,
            targetOriginalWidth: prepared.target.originalWidth,
            targetOriginalHeight: prepared.target.originalHeight,
            sourceScaled: prepared.source.scaled,
            targetScaled: prepared.target.scaled
          }
        },
        renderPlan: {
          finalPixels: new Uint8ClampedArray(hydrated.finalPixels),
          tintStrengthByTarget: new Float32Array(hydrated.tintStrengthByTarget),
          cheatedTargetPixels: new Uint8Array(hydrated.cheatedTargetPixels)
        }
      };
    } finally {
      sourceBitmap?.close();
      targetBitmap?.close();
    }
  }

  private async generateTransform(options?: { forceMainThread?: boolean; retryMessage?: string }) {
    if (!this.sourceSelection || !this.targetSelection) {
      this.setState('error', 'Choose both a source image and a target image.');
      this.setProgress(0, 'Two images are required before generating a transform.');
      return;
    }

    this.abandonActiveComputation();
    this.pauseAnimation();
    this.activeTransform = null;
    this.animationState = null;
    this.animationFramePixels = null;
    this.finalResultImageData = null;
    this.clearDiagnostics();
    this.updateCanvasPlaceholder(this.resultPlaceholder, true);
    this.setResultMetaCopy('Generating transform…');
    this.outputSize.textContent = '—';
    this.pixelCount.textContent = '—';
    this.duration.textContent = '—';
    this.clearResultSurfaces();

    const requestId = ++this.activeRequestId;
    const preset = getPreset(this.selectedPreset);
    const cachedTransform = this.getCachedBuiltInTransform(requestId, preset.id);
    if (cachedTransform) {
      this.setState('processing', 'Loading cached built-in transform…');
      this.setProgress(0.98, 'Restoring built-in pair from cache…', `${preset.label} preset · cached demo pair`);
      this.applyTransformSuccess(
        cachedTransform.message,
        {
          finalPixels: new Uint8ClampedArray(cachedTransform.finalPixels),
          tintStrengthByTarget: new Float32Array(cachedTransform.tintStrengthByTarget),
          cheatedTargetPixels: new Uint8Array(cachedTransform.cheatedTargetPixels)
        },
        false
      );
      return;
    }

    if (!options?.forceMainThread) {
      const precomputedBuiltInTransformUrl = this.getPrecomputedBuiltInTransformAssetUrl(preset.id);
      if (precomputedBuiltInTransformUrl) {
        this.setState('processing', 'Loading precomputed built-in transform…');
        this.setProgress(0.08, 'Loading precomputed demo asset…', `${preset.label} preset · shipped demo cache`);

        try {
          const precomputedBuiltInTransform = await this.restorePrecomputedBuiltInTransform(requestId, preset.id);
          if (precomputedBuiltInTransform && requestId === this.activeRequestId) {
            this.setProgress(0.98, 'Restoring precomputed built-in transform…', `${preset.label} preset · shipped demo cache`);
            this.applyTransformSuccess(precomputedBuiltInTransform.message, precomputedBuiltInTransform.renderPlan);
            return;
          }
        } catch (error) {
          this.setProgress(
            0.12,
            error instanceof Error
              ? `${error.message} Falling back to live generation…`
              : 'Precomputed demo unavailable. Falling back to live generation…',
            `${preset.label} preset · live fallback`
          );
        }
      }
    }

    this.setState('processing', 'Preparing images and analyzing pixels…');
    this.setProgress(
      0.02,
      options?.retryMessage ?? 'Loading image data…',
      `${preset.label} preset · up to ${preset.maxDimension}px working size`
    );

    let sourceBitmap: ImageBitmap | null = null;
    let targetBitmap: ImageBitmap | null = null;
    try {
      const bitmapResults = await Promise.allSettled([
        this.selectionToBitmap(this.sourceSelection),
        this.selectionToBitmap(this.targetSelection)
      ]);
      const sourceResult = bitmapResults[0];
      const targetResult = bitmapResults[1];

      if (sourceResult.status !== 'fulfilled' || targetResult.status !== 'fulfilled') {
        if (sourceResult.status === 'fulfilled') {
          sourceResult.value.close();
        }
        if (targetResult.status === 'fulfilled') {
          targetResult.value.close();
        }
        const rejection =
          sourceResult.status === 'rejected'
            ? sourceResult.reason
            : targetResult.status === 'rejected'
              ? targetResult.reason
              : new Error('Unable to load the selected images.');
        throw rejection;
      }

      sourceBitmap = sourceResult.value;
      targetBitmap = targetResult.value;

      if (!this.isCurrentRequest(requestId)) {
        sourceBitmap.close();
        targetBitmap.close();
        return;
      }

      if (options?.forceMainThread || this.workerUnavailable || typeof Worker === 'undefined') {
        await this.runOnMainThread(requestId, sourceBitmap, targetBitmap);
        return;
      }

      const worker = this.getWorker();
      const supportsBitmapPath = typeof OffscreenCanvas === 'function';

      if (supportsBitmapPath) {
        const request: WorkerRequest = {
          type: 'transform',
          requestId,
          presetId: this.selectedPreset,
          sourceBitmap,
          targetBitmap
        };

        this.activeWorkerRequestId = requestId;
        worker.postMessage(request, [sourceBitmap, targetBitmap]);
        return;
      }

      const prepared = this.prepareBitmapsOnMainThread(sourceBitmap, targetBitmap, preset.maxDimension);
      sourceBitmap.close();
      targetBitmap.close();

      const request: WorkerRequest = {
        type: 'transform-prepared',
        requestId,
        presetId: this.selectedPreset,
        source: prepared.source,
        target: prepared.target
      };

      this.activeWorkerRequestId = requestId;
      worker.postMessage(request, [prepared.source.pixels, prepared.target.pixels]);
    } catch (error) {
      sourceBitmap?.close();
      targetBitmap?.close();
      if (!this.isCurrentRequest(requestId)) {
        return;
      }
      this.setState('error', error instanceof Error ? error.message : 'Unable to load the selected images.');
      this.setProgress(0, 'Image preparation failed.', 'Try different files or a demo pair.');
    }
  }

  private async runOnMainThread(requestId: number, sourceBitmap: ImageBitmap, targetBitmap: ImageBitmap) {
    const preset = getPreset(this.selectedPreset);
    const totalStartedAt = performance.now();
    try {
      const prepared = this.prepareBitmapsOnMainThread(sourceBitmap, targetBitmap, preset.maxDimension);
      const decodeMs = performance.now() - totalStartedAt;
      sourceBitmap.close();
      targetBitmap.close();

      const sourcePixels = new Uint8ClampedArray(prepared.source.pixels);
      const targetPixels = new Uint8ClampedArray(prepared.target.pixels);
      const result = transformPreparedImages(
        {
          width: prepared.source.width,
          height: prepared.source.height,
          pixels: sourcePixels
        },
        {
          width: prepared.target.width,
          height: prepared.target.height,
          pixels: targetPixels
        },
        preset.quantizationBits,
        {
          isCancelled: () => !this.isCurrentRequest(requestId),
          onProgress: (completed, total) => {
            this.handleWorkerMessage({
              type: 'progress',
              requestId,
              stage: 'assigning',
              progress: completed / total,
              message: `Assigning donors… ${completed}/${total}`
            });
          },
          onStageProgress: (stage, progress, message) => {
            this.handleWorkerMessage({
              type: 'progress',
              requestId,
              stage,
              progress,
              message
            });
          }
        }
      );

      const metadata: TransformMetadata = {
        presetId: this.selectedPreset,
        quantizationBits: preset.quantizationBits,
        outputWidth: result.source.width,
        outputHeight: result.source.height,
        pixelCount: result.pixelCount,
        sourceOriginalWidth: prepared.source.originalWidth,
        sourceOriginalHeight: prepared.source.originalHeight,
        targetOriginalWidth: prepared.target.originalWidth,
        targetOriginalHeight: prepared.target.originalHeight,
        sourceScaled: prepared.source.scaled,
        targetScaled: prepared.target.scaled,
        processingMs: decodeMs + result.timingsMs.total,
        timingsMs: {
          ...result.timingsMs,
          decode: decodeMs,
          total: decodeMs + result.timingsMs.total
        },
        matcherStrategy: result.matcherStrategy,
        fallbackCount: result.matcherStats.fallbackCount,
        shortlistHitRate: result.matcherStats.shortlistHitRate,
        evaluatedCandidateCount: result.matcherStats.evaluatedCandidateCount,
        evaluatedGroupCount: result.matcherStats.evaluatedGroupCount,
        averageGroupsPerTarget: result.matcherStats.averageGroupsPerTarget,
        workerCount: result.workerCount
      };

      if (this.isCurrentRequest(requestId)) {
        this.handleWorkerMessage({
          type: 'success',
          requestId,
          source: {
            ...prepared.source,
            pixels: asArrayBuffer(sourcePixels.buffer)
          },
          target: {
            ...prepared.target,
            pixels: asArrayBuffer(targetPixels.buffer)
          },
          assignment: asArrayBuffer(result.assignment.buffer),
          metadata
        });
      }
    } catch (error) {
      if (!this.isCurrentRequest(requestId)) {
        return;
      }
      this.handleWorkerMessage({
        type: 'error',
        requestId,
        message: error instanceof Error ? error.message : 'Unable to compute the transform.'
      });
    }
  }

  private getWorker() {
    if (this.worker) {
      return this.worker;
    }

    this.worker = new Worker(new URL('./transform.worker.ts', import.meta.url), {
      type: 'module'
    });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      this.handleWorkerMessage(event.data);
    });
    this.worker.addEventListener('error', (event) => {
      event.preventDefault();
      this.handleWorkerFailure('Worker unavailable. Retrying on the main thread…');
    });
    this.worker.addEventListener('messageerror', () => {
      this.handleWorkerFailure('Worker communication failed. Retrying on the main thread…');
    });
    return this.worker;
  }

  private handleWorkerFailure(message: string) {
    this.activeWorkerRequestId = 0;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.workerUnavailable = true;

    if (
      this.workerFallbackScheduled ||
      this.state !== 'processing' ||
      !this.sourceSelection ||
      !this.targetSelection
    ) {
      return;
    }

    this.workerFallbackScheduled = true;
    void this.generateTransform({
      forceMainThread: true,
      retryMessage: message
    }).finally(() => {
      this.workerFallbackScheduled = false;
    });
  }

  private cancelActiveRequest(requestId: number = this.activeWorkerRequestId) {
    if (this.worker && requestId > 0) {
      const request: WorkerRequest = {
        type: 'cancel',
        requestId
      };
      this.worker.postMessage(request);
    }
  }

  private handleWorkerMessage(message: WorkerResponse) {
    if (message.requestId !== this.activeRequestId) {
      return;
    }

    if (message.type === 'progress') {
      this.setState('processing', message.message);
      this.setProgress(message.progress, message.message);
      return;
    }

    if (message.type === 'error') {
      this.clearActiveWorkerRequest(message.requestId);
      this.clearDiagnostics();
      this.setState('error', message.message);
      this.setProgress(0, message.message, 'Try a different image pair or preset.');
      return;
    }

    if (message.type === 'cancelled') {
      this.clearActiveWorkerRequest(message.requestId);
      this.clearDiagnostics();
      this.setState('idle', 'Transform cancelled.');
      this.setProgress(0, 'Transform cancelled.');
      return;
    }

    this.clearActiveWorkerRequest(message.requestId);
    this.applyTransformSuccess(message);
  }

  private applyTransformSuccess(
    message: WorkerSuccessMessage,
    precomputedRenderPlan?: ReturnType<typeof buildTransformRenderPlan>,
    shouldStoreBuiltInTransform: boolean = true
  ) {
    const transform: ActiveTransform = {
      metadata: message.metadata,
      source: this.inflateTransfer(message.source),
      target: this.inflateTransfer(message.target),
      assignment: new Uint32Array(asArrayBuffer(message.assignment))
    };

    this.activeTransform = transform;
    this.syncDiagnostics(transform.metadata, message.requestId);
    this.paintPreparedImage(this.sourceCanvas, this.sourceContext, transform.source);
    this.paintPreparedImage(this.targetCanvas, this.targetContext, transform.target);
    this.updateCanvasPlaceholder(this.sourcePlaceholder, false);
    this.updateCanvasPlaceholder(this.targetPlaceholder, false);
    this.configureCanvasAspect(transform.metadata.outputWidth, transform.metadata.outputHeight);

    this.sourceMeta.textContent = this.describeImageMeta(
      transform.metadata.sourceOriginalWidth,
      transform.metadata.sourceOriginalHeight,
      transform.metadata.outputWidth,
      transform.metadata.outputHeight,
      transform.metadata.sourceScaled
    );
    this.targetMeta.textContent = this.describeImageMeta(
      transform.metadata.targetOriginalWidth,
      transform.metadata.targetOriginalHeight,
      transform.metadata.outputWidth,
      transform.metadata.outputHeight,
      transform.metadata.targetScaled
    );
    this.outputSize.textContent = `${transform.metadata.outputWidth} × ${transform.metadata.outputHeight}`;
    this.pixelCount.textContent = transform.metadata.pixelCount.toLocaleString();
    this.duration.textContent = `${transform.metadata.processingMs.toFixed(0)} ms`;
    const renderPlan =
      precomputedRenderPlan ??
      buildTransformRenderPlan(
        {
          width: transform.source.width,
          height: transform.source.height,
          pixels: transform.source.pixels
        },
        {
          width: transform.target.width,
          height: transform.target.height,
          pixels: transform.target.pixels
        },
        transform.assignment,
        transform.metadata.quantizationBits
      );
    if (shouldStoreBuiltInTransform) {
      this.storeBuiltInTransform(message, renderPlan);
    }
    const finalResultPixels = renderPlan.finalPixels;
    this.finalResultImageData = new ImageData(
      finalResultPixels.slice(),
      transform.metadata.outputWidth,
      transform.metadata.outputHeight
    );
    this.animationState = createTransformAnimationState({
      width: transform.metadata.outputWidth,
      height: transform.metadata.outputHeight,
      sourcePixels: transform.source.pixels,
      finalPixels: finalResultPixels,
      assignment: transform.assignment,
      tintStrengthByTarget: renderPlan.tintStrengthByTarget,
      cheatedTargetPixels: renderPlan.cheatedTargetPixels,
      preset: getPreset(transform.metadata.presetId)
    });
    this.animationFramePixels = new Uint8ClampedArray(finalResultPixels.length);

    this.resetResultCanvas();

    if (this.reducedMotion) {
      this.renderCompleteResult();
      this.setState('complete', 'Transform ready. Reduced motion is enabled, so the final result is shown immediately.');
      this.setProgress(
        1,
        'Transform complete.',
        `${transform.metadata.matcherStrategy} · analyze ${transform.metadata.timingsMs.analyze.toFixed(0)} ms · assign ${transform.metadata.timingsMs.assign.toFixed(0)} ms`
      );
      this.setResultMetaCopy('Final result rendered immediately for reduced motion.');
    } else {
      this.setState('ready', 'Transform ready. Press play or replay to run the animation.');
      this.setProgress(
        0,
        'Transform ready to animate.',
        `${transform.metadata.matcherStrategy} · analyze ${transform.metadata.timingsMs.analyze.toFixed(0)} ms · assign ${transform.metadata.timingsMs.assign.toFixed(0)} ms`
      );
      this.setResultMetaCopy('Pixels from the source image shift into their assigned landing positions.');
      this.playAnimation();
    }
  }

  private inflateTransfer(transfer: PreparedImageTransfer): HydratedTransfer {
    return {
      width: transfer.width,
      height: transfer.height,
      pixels: new Uint8ClampedArray(asArrayBuffer(transfer.pixels))
    };
  }

  private configureCanvasAspect(width: number, height: number) {
    const ratio = `${width} / ${height}`;
    this.sourceCanvas.parentElement?.style.setProperty('--canvas-aspect', ratio);
    this.targetCanvas.parentElement?.style.setProperty('--canvas-aspect', ratio);
    this.resultCanvas.parentElement?.style.setProperty('--canvas-aspect', ratio);
  }

  private describeImageMeta(originalWidth: number, originalHeight: number, width: number, height: number, scaled: boolean) {
    return scaled
      ? `${originalWidth} × ${originalHeight} normalized to ${width} × ${height}`
      : `${width} × ${height} working size`;
  }

  private updateCanvasPlaceholder(placeholder: HTMLElement, visible: boolean) {
    placeholder.classList.toggle('is-hidden', !visible);
  }

  private paintPreparedImage(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, image: HydratedTransfer) {
    canvas.width = image.width;
    canvas.height = image.height;
    context.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0);
  }

  private clearResultSurfaces() {
    this.resultContext.clearRect(0, 0, this.resultCanvas.width, this.resultCanvas.height);
    this.overlayContext.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  private resetResultCanvas() {
    if (!this.activeTransform) {
      return;
    }

    this.animationElapsedMs = 0;
    this.animationStartedAt = 0;
    this.resultCanvas.width = this.activeTransform.metadata.outputWidth;
    this.resultCanvas.height = this.activeTransform.metadata.outputHeight;
    this.overlayCanvas.width = this.activeTransform.metadata.outputWidth;
    this.overlayCanvas.height = this.activeTransform.metadata.outputHeight;
    this.updateCanvasPlaceholder(this.resultPlaceholder, false);
    this.renderAnimationFrame(0);
  }

  private renderCompleteResult() {
    if (!this.finalResultImageData) {
      return;
    }

    this.resultContext.putImageData(this.finalResultImageData, 0, 0);
    this.overlayContext.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  private renderAnimationFrame(phase: number) {
    if (!this.animationState) {
      return;
    }

    const framePixels = renderTransformAnimationPixels(
      this.animationState,
      phase,
      this.animationFramePixels ?? undefined
    );
    const imageDataPixels =
      framePixels.buffer instanceof ArrayBuffer ? framePixels : new Uint8ClampedArray(framePixels);
    this.resultContext.putImageData(
      new ImageData(imageDataPixels as Uint8ClampedArray<ArrayBuffer>, this.animationState.width, this.animationState.height),
      0,
      0
    );

    this.overlayContext.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    for (const particle of resolveAccentParticlesFrame(this.animationState, phase)) {
      this.overlayContext.save();
      this.overlayContext.globalAlpha = particle.alpha;
      this.overlayContext.fillStyle = particle.color;
      this.overlayContext.fillRect(
        Math.round(particle.x - particle.size / 2),
        Math.round(particle.y - particle.size / 2),
        particle.size,
        particle.size
      );
      this.overlayContext.restore();
    }
  }

  private handlePlaybackButton() {
    if (this.animationElapsedMs > 0) {
      this.replayAnimation();
      return;
    }

    this.playAnimation();
  }

  private playAnimation() {
    if (!this.activeTransform || this.reducedMotion) {
      this.syncButtons();
      return;
    }

    const preset = getPreset(this.activeTransform.metadata.presetId);
    const durationMs = preset.animationDurationMs;
    this.setState('animating', 'Animating the result image…');
    this.setResultMetaCopy('The source pixels are physically rearranging into the new image.');
    this.syncButtons();

    const step = (timestamp: number) => {
      if (!this.activeTransform || this.state !== 'animating') {
        return;
      }

      if (!this.animationStartedAt) {
        this.animationStartedAt = timestamp;
      }

      const elapsedMs = this.animationElapsedMs + (timestamp - this.animationStartedAt);
      const phase = clamp(elapsedMs / durationMs, 0, 1);
      this.renderAnimationFrame(phase);
      this.setProgress(
        phase,
        `Animating reconstruction… ${Math.round(phase * 100)}%`,
        `${this.activeTransform.metadata.outputWidth}×${this.activeTransform.metadata.outputHeight} working size`
      );

      if (phase >= 1) {
        this.animationElapsedMs = durationMs;
        this.animationFrameId = 0;
        this.renderCompleteResult();
        this.setState('complete', 'Animation complete.');
        this.setResultMetaCopy('Every source pixel has reached its final landing position.');
        this.syncButtons();
        return;
      }

      this.animationFrameId = window.requestAnimationFrame(step);
    };

    this.animationFrameId = window.requestAnimationFrame(step);
  }

  private pauseAnimation() {
    if (this.animationFrameId) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }

    if (this.state === 'animating') {
      if (this.animationStartedAt) {
        this.animationElapsedMs += performance.now() - this.animationStartedAt;
        this.animationStartedAt = 0;
      }
      this.setState('ready', 'Animation stopped. Press replay to run it again.');
      this.setResultMetaCopy('The current pass stopped. Replay restarts the full rearrangement from frame zero.');
    }
  }

  private replayAnimation() {
    if (!this.activeTransform || this.reducedMotion) {
      return;
    }

    this.pauseAnimation();
    this.resetResultCanvas();
    this.setProgress(0, 'Animation reset. Replaying from the beginning.');
    this.playAnimation();
  }

  private resetAll() {
    this.discardActiveRequest();
    this.sourceSelection = null;
    this.targetSelection = null;
    this.clearActiveDemo();
    this.syncSelectionLabels();
    this.invalidateComputedState('Load two images or start from a demo pair.');
  }

  private async swapSelections() {
    if (!this.sourceSelection || !this.targetSelection) {
      return;
    }

    const sourceSelection = this.sourceSelection;
    this.sourceSelection = this.targetSelection;
    this.targetSelection = sourceSelection;
    this.syncActiveDemo();
    this.syncSelectionLabels();
    await this.generateTransform();
  }

  private async selectionToBitmap(selection: ImageSelection): Promise<ImageBitmap> {
    if (selection.kind === 'file' && selection.file) {
      return createImageBitmap(selection.file);
    }

    if (selection.kind === 'demo' && selection.url) {
      const response = await fetch(selection.url);
      if (!response.ok) {
        throw new Error(`Unable to load demo asset: ${selection.label}`);
      }
      const blob = await response.blob();
      return createImageBitmap(blob);
    }

    throw new Error('The selected image could not be decoded.');
  }

  private prepareBitmapsOnMainThread(sourceBitmap: ImageBitmap, targetBitmap: ImageBitmap, maxDimension: number) {
    const outputSize = resolveOutputDimensions(targetBitmap.width, targetBitmap.height, maxDimension);
    const source = this.rasterizeBitmap(sourceBitmap, outputSize.width, outputSize.height);
    const target = this.rasterizeBitmap(targetBitmap, outputSize.width, outputSize.height);

    return {
      source: {
        width: source.width,
        height: source.height,
        pixels: source.pixels.buffer,
        originalWidth: sourceBitmap.width,
        originalHeight: sourceBitmap.height,
        scaled: sourceBitmap.width !== outputSize.width || sourceBitmap.height !== outputSize.height
      },
      target: {
        width: target.width,
        height: target.height,
        pixels: target.pixels.buffer,
        originalWidth: targetBitmap.width,
        originalHeight: targetBitmap.height,
        scaled: targetBitmap.width !== outputSize.width || targetBitmap.height !== outputSize.height
      }
    };
  }

  private rasterizeBitmap(bitmap: ImageBitmap, width: number, height: number) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Unable to create a canvas for image preparation.');
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.clearRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);

    return {
      width,
      height,
      pixels: imageData.data
    };
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const transformRoot = document.getElementById('utilitiesApp');
  if (transformRoot) {
    try {
      new UtilitiesApp(transformRoot).init();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Utilities failed to initialize.';
      const statusText = document.getElementById('transformStatusText');
      if (statusText) {
        statusText.textContent = message;
      }
      transformRoot.dataset.transformStatusMessage = message;
    }
  }

  const audioFourierRoot = document.getElementById('audioFourierApp');
  if (audioFourierRoot) {
    try {
      new AudioFourierController(audioFourierRoot).init();
    } catch (error) {
      const statusText = document.getElementById('audioFourierStatusText');
      if (statusText) {
        statusText.textContent = error instanceof Error ? error.message : 'Audio Fourier utility failed to initialize.';
      }
    }
  }

  const deathCalculatorRoot = document.getElementById('deathCalculatorApp');
  if (deathCalculatorRoot) {
    try {
      new DeathCalculatorController(deathCalculatorRoot).init();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Death Calculator failed to initialize.';
      const statusText = document.getElementById('deathStatusText');
      if (statusText) {
        statusText.textContent = message;
      }
      deathCalculatorRoot.dataset.deathStatusMessage = message;
    }
  }

  const vmRoot = document.getElementById('retroVmApp');
  if (vmRoot) {
    try {
      new RetroVmController(vmRoot).init();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Retro VM failed to initialize.';
      const statusText = document.getElementById('retroVmStatusText');
      if (statusText) {
        statusText.textContent = message;
      }
      vmRoot.dataset.vmStatusMessage = message;
    }
  }
});
