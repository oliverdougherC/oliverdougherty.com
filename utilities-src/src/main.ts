import { getPreset } from './presets';
import { buildTransformRenderPlan } from './transformRenderPlan';
import {
  createTransformAnimationState,
  renderTransformAnimationPixels,
  resolveAccentParticlesFrame,
  type TransformAnimationState
} from './transformAnimation';
import { resolveOutputDimensions, transformPreparedImages } from './transformCore';
import type { PreparedImageTransfer, TransformMetadata, TransformPresetId } from './types';
import type { WorkerRequest, WorkerResponse } from './workerTypes';

type SelectionKind = 'source' | 'target';
type StateKind = 'idle' | 'processing' | 'ready' | 'animating' | 'complete' | 'error';

interface ImageSelection {
  kind: 'file' | 'demo';
  label: string;
  file?: File;
  url?: string;
}

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

const DEMOS: Record<string, { source: ImageSelection; target: ImageSelection }> = {
  'pattern-face': {
    source: { kind: 'demo', label: 'Pattern', url: '../../assets/utilities/pattern.png' },
    target: { kind: 'demo', label: 'Face', url: '../../assets/utilities/face.png' }
  },
  'source-target': {
    source: { kind: 'demo', label: 'Contrast', url: '../../assets/utilities/source.png' },
    target: { kind: 'demo', label: 'Gradient', url: '../../assets/utilities/target.png' }
  },
  'face-pattern': {
    source: { kind: 'demo', label: 'Face', url: '../../assets/utilities/face.png' },
    target: { kind: 'demo', label: 'Pattern', url: '../../assets/utilities/pattern.png' }
  }
};

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
  private readonly replayButton: HTMLButtonElement;
  private readonly statusChip: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly progressText: HTMLElement;
  private readonly progressMeta: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly sourceSelectionLabel: HTMLElement;
  private readonly targetSelectionLabel: HTMLElement;
  private readonly sourceMeta: HTMLElement;
  private readonly targetMeta: HTMLElement;
  private readonly resultMeta: HTMLElement;
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

  private sourceSelection: ImageSelection | null = null;
  private targetSelection: ImageSelection | null = null;
  private worker: Worker | null = null;
  private activeRequestId = 0;
  private activeTransform: ActiveTransform | null = null;
  private animationState: TransformAnimationState | null = null;
  private animationFramePixels: Uint8ClampedArray | null = null;
  private finalResultImageData: ImageData | null = null;
  private animationFrameId = 0;
  private animationStartedAt = 0;
  private animationElapsedMs = 0;
  private state: StateKind = 'idle';

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
    this.replayButton = this.requireElement('transformReplayBtn');
    this.statusChip = this.requireElement('transformStatusChip');
    this.statusText = this.requireElement('transformStatusText');
    this.progressText = this.requireElement('transformProgressText');
    this.progressMeta = this.requireElement('transformProgressMeta');
    this.progressBar = this.requireElement('transformProgressBar');
    this.progressFill = this.requireElement('transformProgressFill');
    this.sourceSelectionLabel = this.requireElement('transformSourceSelection');
    this.targetSelectionLabel = this.requireElement('transformTargetSelection');
    this.sourceMeta = this.requireElement('transformSourceMeta');
    this.targetMeta = this.requireElement('transformTargetMeta');
    this.resultMeta = this.requireElement('transformResultMeta');
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
    this.playButton.addEventListener('click', () => this.playAnimation());
    this.pauseButton.addEventListener('click', () => this.pauseAnimation());
    this.replayButton.addEventListener('click', () => this.replayAnimation());
    this.presetSelect.addEventListener('change', () => {
      const preset = getPreset(this.selectedPreset);
      this.progressMeta.textContent = `${preset.label} preset · up to ${preset.maxDimension}px working size`;
    });

    this.demoButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const demoKey = button.dataset.demoKey;
        if (!demoKey || !(demoKey in DEMOS)) {
          return;
        }
        this.applyDemo(demoKey);
        void this.generateTransform();
      });
    });

    this.bindDropzone(this.sourceDropzone, 'source');
    this.bindDropzone(this.targetDropzone, 'target');
    this.syncSelectionLabels();
    this.syncButtons();
    this.applyDemo('pattern-face');
    void this.generateTransform();
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

    this.clearActiveDemo();
    this.syncSelectionLabels();
  }

  private applyDemo(demoKey: string) {
    const demo = DEMOS[demoKey];
    this.sourceSelection = demo.source;
    this.targetSelection = demo.target;
    this.syncSelectionLabels();
    this.demoButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.demoKey === demoKey);
    });
  }

  private clearActiveDemo() {
    this.demoButtons.forEach((button) => button.classList.remove('active'));
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

    this.generateButton.disabled = !hasBothSelections || isProcessing;
    this.swapButton.disabled = !hasBothSelections || isProcessing;
    this.resetButton.disabled = isProcessing && !hasResult;
    this.playButton.disabled = !hasResult || isProcessing || isAnimating || this.reducedMotion;
    this.pauseButton.disabled = !hasResult || !isAnimating;
    this.replayButton.disabled = !hasResult || isProcessing;
  }

  private setState(state: StateKind, text: string) {
    this.state = state;
    this.statusText.textContent = text;
    this.statusChip.textContent = state === 'ready' ? 'Ready' : state === 'complete' ? 'Complete' : state[0].toUpperCase() + state.slice(1);
    this.statusChip.className = `utility-status-chip utility-status-chip--${state}`;
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

  private async generateTransform() {
    if (!this.sourceSelection || !this.targetSelection) {
      this.setState('error', 'Choose both a source image and a target image.');
      this.setProgress(0, 'Two images are required before generating a transform.');
      return;
    }

    this.cancelActiveRequest();
    this.pauseAnimation();
    this.activeTransform = null;
    this.animationState = null;
    this.animationFramePixels = null;
    this.finalResultImageData = null;
    this.updateCanvasPlaceholder(this.resultPlaceholder, true);
    this.resultMeta.textContent = 'Generating transform…';
    this.outputSize.textContent = '—';
    this.pixelCount.textContent = '—';
    this.duration.textContent = '—';
    this.clearResultSurfaces();

    const requestId = ++this.activeRequestId;
    const preset = getPreset(this.selectedPreset);
    this.setState('processing', 'Preparing images and matching pixels…');
    this.setProgress(0.02, 'Loading image data…', `${preset.label} preset · up to ${preset.maxDimension}px working size`);

    try {
      const [sourceBitmap, targetBitmap] = await Promise.all([
        this.selectionToBitmap(this.sourceSelection),
        this.selectionToBitmap(this.targetSelection)
      ]);

      if (typeof Worker === 'undefined') {
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

      worker.postMessage(request, [prepared.source.pixels, prepared.target.pixels]);
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : 'Unable to load the selected images.');
      this.setProgress(0, 'Image preparation failed.', 'Try different files or a demo pair.');
    }
  }

  private async runOnMainThread(requestId: number, sourceBitmap: ImageBitmap, targetBitmap: ImageBitmap) {
    const preset = getPreset(this.selectedPreset);
    try {
      const prepared = this.prepareBitmapsOnMainThread(sourceBitmap, targetBitmap, preset.maxDimension);
      sourceBitmap.close();
      targetBitmap.close();

      const startedAt = performance.now();
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
          onProgress: (completed, total) => {
            this.handleWorkerMessage({
              type: 'progress',
              requestId,
              stage: 'matching',
              progress: completed / total,
              message: `Matching pixels… ${completed}/${total}`
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
        processingMs: performance.now() - startedAt
      };

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
    } catch (error) {
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
    return this.worker;
  }

  private cancelActiveRequest() {
    if (this.worker && this.activeRequestId > 0) {
      const request: WorkerRequest = {
        type: 'cancel',
        requestId: this.activeRequestId
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
      this.setState('error', message.message);
      this.setProgress(0, message.message, 'Try a different image pair or preset.');
      return;
    }

    if (message.type === 'cancelled') {
      this.setState('idle', 'Transform cancelled.');
      this.setProgress(0, 'Transform cancelled.');
      return;
    }

    const transform: ActiveTransform = {
      metadata: message.metadata,
      source: this.inflateTransfer(message.source),
      target: this.inflateTransfer(message.target),
      assignment: new Uint32Array(asArrayBuffer(message.assignment))
    };

    this.activeTransform = transform;
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
    const renderPlan = buildTransformRenderPlan(
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
      this.setProgress(1, 'Transform complete.', `${transform.metadata.outputWidth}×${transform.metadata.outputHeight} working size`);
      this.resultMeta.textContent = 'Final result rendered immediately for reduced motion.';
    } else {
      this.setState('ready', 'Transform ready. Press play or replay to run the animation.');
      this.setProgress(0, 'Transform ready to animate.', `${transform.metadata.outputWidth}×${transform.metadata.outputHeight} working size`);
      this.resultMeta.textContent = 'Pixels from the source image shift into their assigned landing positions.';
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

  private playAnimation() {
    if (!this.activeTransform || this.reducedMotion) {
      this.syncButtons();
      return;
    }

    const preset = getPreset(this.activeTransform.metadata.presetId);
    const durationMs = preset.animationDurationMs;
    this.setState('animating', 'Animating the result image…');
    this.resultMeta.textContent = 'The source pixels are physically rearranging into the new image.';
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
        this.renderCompleteResult();
        this.setState('complete', 'Animation complete.');
        this.resultMeta.textContent = 'Every source pixel has reached its final landing position.';
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
      this.setState('ready', 'Animation paused. Resume or replay at any time.');
    }
  }

  private replayAnimation() {
    if (!this.activeTransform || this.reducedMotion) {
      return;
    }

    this.pauseAnimation();
    this.resetResultCanvas();
    this.setProgress(0, 'Animation reset. Press play to run it again.');
    this.playAnimation();
  }

  private resetAll() {
    this.cancelActiveRequest();
    this.pauseAnimation();
    this.activeTransform = null;
    this.animationState = null;
    this.animationFramePixels = null;
    this.finalResultImageData = null;
    this.sourceSelection = null;
    this.targetSelection = null;
    this.sourceContext.clearRect(0, 0, this.sourceCanvas.width, this.sourceCanvas.height);
    this.targetContext.clearRect(0, 0, this.targetCanvas.width, this.targetCanvas.height);
    this.clearResultSurfaces();
    this.updateCanvasPlaceholder(this.sourcePlaceholder, true);
    this.updateCanvasPlaceholder(this.targetPlaceholder, true);
    this.updateCanvasPlaceholder(this.resultPlaceholder, true);
    this.sourceMeta.textContent = 'Waiting for an image.';
    this.targetMeta.textContent = 'Waiting for an image.';
    this.resultMeta.textContent = 'Generate a transform to begin the animation.';
    this.outputSize.textContent = '—';
    this.pixelCount.textContent = '—';
    this.duration.textContent = '—';
    this.clearActiveDemo();
    this.syncSelectionLabels();
    const preset = getPreset(this.selectedPreset);
    this.setState('idle', 'Load two images or start from a demo pair.');
    this.setProgress(0, 'Ready for input.', `${preset.label} preset · up to ${preset.maxDimension}px working size`);
  }

  private async swapSelections() {
    if (!this.sourceSelection || !this.targetSelection) {
      return;
    }

    const sourceSelection = this.sourceSelection;
    this.sourceSelection = this.targetSelection;
    this.targetSelection = sourceSelection;
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
  const root = document.getElementById('utilitiesApp');
  if (!root) {
    return;
  }

  try {
    new UtilitiesApp(root).init();
  } catch (error) {
    const statusText = document.getElementById('transformStatusText');
    if (statusText) {
      statusText.textContent = error instanceof Error ? error.message : 'Utilities failed to initialize.';
    }
  }
});
