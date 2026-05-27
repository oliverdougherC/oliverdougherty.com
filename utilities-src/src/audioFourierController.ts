import {
  AUDIO_FOURIER_PRESETS,
  BUILT_IN_AUDIO_PRESETS,
  DEFAULT_BUILT_IN_AUDIO_PRESET_ID,
  getAudioFourierPreset,
  isBuiltInAudioPresetId,
  type AudioFourierPresetId,
  type BuiltInAudioPresetId
} from './audioPresets';
import { clamp } from './math';
import {
  mapSliderValueToEnergyPercent,
  resolveEnergyBandGains,
  resolveEnergyMakeupGain,
  resolveEnvelopeViewportRange,
  resolveHighEnergyVisualAmplitude,
  writeSmoothedEnvelopeAmplitudes
} from './audioFourierCore';
import { resolveAudioPlaybackButtonState } from './audioFourierUiState';
import { createAudioWaveRenderer, type AudioWaveRenderer } from './audioFourierWaveRenderer';
import type { AudioFourierSourceTransfer, AudioFourierSuccessMessage, AudioFourierWorkerRequest, AudioFourierWorkerResponse } from './audioFourierWorkerTypes';
import { arrayBufferLikeToArrayBuffer, sliceArrayBufferView } from './bufferUtils';

type AudioFourierState = 'idle' | 'processing' | 'ready' | 'animating' | 'complete' | 'error';

let moduleWorkerSupport: boolean | null = null;

interface AudioFourierSelection {
  kind: 'preset' | 'file';
  label: string;
  presetId?: BuiltInAudioPresetId;
  file?: File;
}

function buildDefaultAudioSelection(): AudioFourierSelection {
  const preset = BUILT_IN_AUDIO_PRESETS[DEFAULT_BUILT_IN_AUDIO_PRESET_ID];
  return {
    kind: 'preset',
    label: preset.label,
    presetId: preset.id
  };
}

function supportsModuleWorkers() {
  if (moduleWorkerSupport !== null) {
    return moduleWorkerSupport;
  }

  try {
    const blobUrl = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
    const worker = new Worker(blobUrl, { type: 'module' });
    worker.terminate();
    URL.revokeObjectURL(blobUrl);
    moduleWorkerSupport = true;
  } catch (error) {
    console.warn('[AudioFourier] Module worker support check failed:', error);
    moduleWorkerSupport = false;
  }
  return moduleWorkerSupport;
}

interface ActiveBandNode {
  source: AudioBufferSourceNode;
  gain: GainNode;
  disconnected: boolean;
}

interface ActiveAudioFourier {
  metadata: AudioFourierSuccessMessage['metadata'];
  bandSamples: Float32Array;
  originalEnvelopeMin: Float32Array;
  originalEnvelopeMax: Float32Array;
  bandEnvelopeMin: Float32Array;
  bandEnvelopeMax: Float32Array;
  bandEndComponentCounts: Uint32Array;
  bandEnergyFractions: Float32Array;
  componentFrequencies: Float32Array;
  componentAmplitudes: Float32Array;
  componentPhases: Float32Array;
  bandGains: Float32Array;
  energyPercent: number;
}

function formatSeconds(value: number) {
  if (value >= 30) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.round(value % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)}s`;
}

function formatFrequency(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${value.toFixed(1)} Hz`;
}

const INITIAL_SLIDER_VALUE = 50;
const PLAYBACK_FADE_SECONDS = 0.1;
const PLAYBACK_START_DELAY_SECONDS = 0.035;
const PLAYBACK_PROGRESS_UPDATE_MS = 100;
const FULL_ENERGY_VISUAL_THRESHOLD = 0.999;
const GAIN_RAMP_TIME_CONSTANT = 0.015;
const MASTER_GAIN_RAMP_TIME_CONSTANT = 0.02;
const VISUAL_CLOCK_RECONCILE_SECONDS = 0.08;
const VISUAL_CLOCK_DAMPING_FACTOR = 0.08;
const COMPONENT_WAVE_MAX_POINTS = 960;

export function encodeAudioFourierBandGainsCacheKey(gains: Float32Array) {
  return Array.from(gains, (gain) => Number.isFinite(gain) ? gain.toFixed(6) : String(gain)).join(',');
}

export function shouldDebugAudioFourierWarnings(hostname?: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
}

function logAudioFourierWarning(message: string, error: unknown) {
  if (!shouldDebugAudioFourierWarnings(globalThis.location?.hostname)) {
    return;
  }
  console.warn(`[AudioFourier] ${message}`, error);
}

export class AudioFourierController {
  private readonly reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  private reducedMotion = this.reducedMotionQuery.matches;
  private readonly viewportSeconds = 2;
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly qualitySelect: HTMLSelectElement;
  private readonly generateButton: HTMLButtonElement;
  private readonly playPauseButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly componentSlider: HTMLInputElement;
  private readonly componentReadout: HTMLElement;
  private readonly signalStrengthMetric: HTMLElement;
  private readonly signalCountMetric: HTMLElement;
  private readonly componentMinLabel: HTMLElement;
  private readonly componentMaxLabel: HTMLElement;
  private readonly statusChip: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly progressText: HTMLElement;
  private readonly progressMeta: HTMLElement;
  private readonly progressBar: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly selectionLabel: HTMLElement;
  private readonly resultMeta: HTMLElement;
  private readonly sampleRateLabel: HTMLElement;
  private readonly componentCountLabel: HTMLElement;
  private readonly sourceDurationLabel: HTMLElement;
  private readonly durationLabel: HTMLElement;
  private readonly waveCanvas: HTMLCanvasElement;
  private readonly spectrumCanvas: HTMLCanvasElement;
  private readonly componentCanvas: HTMLCanvasElement;
  private readonly spectrumContext: CanvasRenderingContext2D;
  private readonly componentContext: CanvasRenderingContext2D;
  private readonly waveRenderer: AudioWaveRenderer;
  private readonly dropzone: HTMLElement;
  private readonly presetButtons: HTMLButtonElement[];

  private selection: AudioFourierSelection = buildDefaultAudioSelection();
  private worker: Worker | null = null;
  private workerVersion = 0;
  private activeRequestId = 0;
  private activeWorkerRequestId = 0;
  private activeResult: ActiveAudioFourier | null = null;
  private audioContext: AudioContext | null = null;
  private bandBuffers: AudioBuffer[] = [];
  private activeBandNodes: ActiveBandNode[] = [];
  private audioContextBlocked = false;
  private activeMasterGain: GainNode | null = null;
  private masterGainControlReadyAt = 0;
  private playbackStartedAt = 0;
  private playbackElapsedSeconds = 0;
  private visualPlaybackElapsedSeconds = 0;
  private visualPlaybackUpdatedAt = 0;
  private animationFrameId = 0;
  private visualOriginalRawScratch = new Float32Array(0);
  private visualMixRawScratch = new Float32Array(0);
  private visualOriginalFrameScratch = new Float32Array(0);
  private visualMixFrameScratch = new Float32Array(0);
  private visualRevision = 0;
  private lastPlaybackProgressAt = 0;
  private deferredWaveRenderTimeoutId = 0;
  private state: AudioFourierState = 'idle';
  private destroyed = false;
  private sliderRafPending = false;
  private resizeFrameId = 0;
  private resizeObserver: ResizeObserver | null = null;
  private activeComponentsCacheKey = '';
  private activeComponentsCacheValue = 0;
  private readonly eventController = new AbortController();
  private readonly reducedMotionChangeHandler = this.onReducedMotionChange.bind(this);
  private readonly spectrumBackgroundCanvas: HTMLCanvasElement;
  private readonly componentBackgroundCanvas: HTMLCanvasElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.input = this.requireElement('audioFourierInput', HTMLInputElement);
    this.qualitySelect = this.requireElement('audioFourierQuality', HTMLSelectElement);
    this.generateButton = this.requireElement('audioFourierGenerateBtn', HTMLButtonElement);
    this.playPauseButton = this.requireElement('audioFourierPlayBtn', HTMLButtonElement);
    this.resetButton = this.requireElement('audioFourierResetBtn', HTMLButtonElement);
    this.componentSlider = this.requireElement('audioFourierComponentSlider', HTMLInputElement);
    this.componentReadout = this.requireElement('audioFourierComponentReadout');
    this.signalStrengthMetric = this.requireElement('audioFourierSignalStrengthMetric');
    this.signalCountMetric = this.requireElement('audioFourierSignalCountMetric');
    this.componentMinLabel = this.requireElement('audioFourierComponentMin');
    this.componentMaxLabel = this.requireElement('audioFourierComponentMax');
    this.statusChip = this.requireElement('audioFourierStatusChip');
    this.statusText = this.requireElement('audioFourierStatusText');
    this.progressText = this.requireElement('audioFourierProgressText');
    this.progressMeta = this.requireElement('audioFourierProgressMeta');
    this.progressBar = this.requireElement('audioFourierProgressBar');
    this.progressFill = this.requireElement('audioFourierProgressFill');
    this.selectionLabel = this.requireElement('audioFourierSelection');
    this.resultMeta = this.requireElement('audioFourierResultMeta');
    this.sampleRateLabel = this.requireElement('audioFourierSampleRate');
    this.componentCountLabel = this.requireElement('audioFourierComponentCount');
    this.sourceDurationLabel = this.requireElement('audioFourierSourceDuration');
    this.durationLabel = this.requireElement('audioFourierDuration');
    this.waveCanvas = this.requireElement('audioFourierWaveCanvas', HTMLCanvasElement);
    this.spectrumCanvas = this.requireElement('audioFourierSpectrumCanvas', HTMLCanvasElement);
    this.componentCanvas = this.requireElement('audioFourierComponentCanvas', HTMLCanvasElement);
    this.dropzone = this.requireElement('audioFourierDropzone');
    this.presetButtons = Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-audio-preset]'));
    this.waveRenderer = createAudioWaveRenderer(this.waveCanvas);
    this.root.dataset.audioWaveRenderer = this.waveRenderer.kind;
    this.spectrumContext = this.getContext(this.spectrumCanvas);
    this.componentContext = this.getContext(this.componentCanvas);
    this.spectrumBackgroundCanvas = this.buildBackgroundCanvas(this.spectrumCanvas);
    this.componentBackgroundCanvas = this.buildBackgroundCanvas(this.componentCanvas);

    this.reducedMotionQuery.addEventListener('change', this.reducedMotionChangeHandler, {
      signal: this.eventController.signal
    });
  }

  init() {
    const { signal } = this.eventController;
    this.input.addEventListener('change', () => this.handleFileSelection(this.input.files?.[0] ?? null), { signal });
    this.generateButton.addEventListener('click', () => {
      this.generate().catch((error) => this.handleGenerateFailure(error));
    }, { signal });
    this.playPauseButton.addEventListener('click', () => {
      this.handlePlayPauseClick().catch((error) => this.handleGenerateFailure(error));
    }, { signal });
    this.resetButton.addEventListener('click', () => this.resetAll(), { signal });
    this.qualitySelect.addEventListener('change', () => this.invalidateComputedState('Quality changed. Generate again to rebuild the audio transform.'), { signal });
    this.componentSlider.addEventListener('input', () => this.handleSliderInput(), { signal });
    this.bindDropzone();

    this.root.addEventListener('utility-deactivate', () => this.pausePlayback(), { signal });
    window.addEventListener('hashchange', () => {
      if (window.location.hash !== '#audio-fourier') {
        this.pausePlayback();
      }
    }, { signal });
    window.addEventListener('pagehide', () => this.pausePlayback(), { signal });
    document.addEventListener('utility-activate', (event) => {
      const stage = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-utility-id]') : null;
      if (stage?.dataset.utilityId && stage.dataset.utilityId !== 'audio-fourier') {
        this.pausePlayback();
      }
    }, { signal });

    this.presetButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const presetId = button.dataset.audioPreset;
        if (!presetId || !isBuiltInAudioPresetId(presetId)) {
          return;
        }
        this.applyBuiltInPreset(presetId);
      }, { signal });
    });

    this.componentSlider.disabled = true;
    this.componentSlider.min = '0';
    this.componentSlider.max = '100';
    this.componentSlider.value = String(INITIAL_SLIDER_VALUE);
    this.componentMinLabel.textContent = 'Sparse';
    this.componentMaxLabel.textContent = 'Full proxy';
    this.componentReadout.textContent = 'Generate first';
    this.signalStrengthMetric.textContent = '--';
    this.signalCountMetric.textContent = '--';
    this.syncSliderProgress();
    this.syncSelection();
    this.installCanvasResizeObserver();
    this.resizeCanvases();
    this.drawEmptyState();
  }

  private bindDropzone() {
    const { signal } = this.eventController;
    const preventDefaults = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    (['dragenter', 'dragover'] as const).forEach((eventName) => {
      this.dropzone.addEventListener(eventName, (event: DragEvent) => {
        preventDefaults(event);
        this.dropzone.classList.add('drag-active');
      }, { signal });
    });

    (['dragleave', 'drop'] as const).forEach((eventName) => {
      this.dropzone.addEventListener(eventName, (event: DragEvent) => {
        preventDefaults(event);
        this.dropzone.classList.remove('drag-active');
      }, { signal });
    });

    this.dropzone.addEventListener('drop', (event: DragEvent) => {
      this.handleFileSelection(event.dataTransfer?.files?.[0] ?? null);
    }, { signal });
  }

  private installCanvasResizeObserver() {
    if (typeof ResizeObserver === 'undefined') {
      // Fallback only covers window resize, not container layout changes (e.g., sidebar collapse, tab switch).
      window.addEventListener('resize', () => this.queueCanvasResize(), { signal: this.eventController.signal });
      return;
    }

    this.resizeObserver = new ResizeObserver(() => this.queueCanvasResize());
    this.resizeObserver.observe(this.waveCanvas);
    this.resizeObserver.observe(this.spectrumCanvas);
    this.resizeObserver.observe(this.componentCanvas);
  }

  private queueCanvasResize() {
    if (this.resizeFrameId) {
      return;
    }

    this.resizeFrameId = window.requestAnimationFrame(() => {
      this.resizeFrameId = 0;
      if (this.resizeCanvases()) {
        if (this.activeResult) {
          this.renderCurrentViewport();
        } else {
          this.drawEmptyState();
        }
      }
    });
  }

  private resizeCanvases() {
    const resizedWave = this.waveRenderer.resize();
    const resizedSpectrum = this.resizeCanvasToDisplaySize(this.spectrumCanvas, this.spectrumBackgroundCanvas);
    const resizedComponent = this.resizeCanvasToDisplaySize(this.componentCanvas, this.componentBackgroundCanvas);
    return resizedWave || resizedSpectrum || resizedComponent;
  }

  private resizeCanvasToDisplaySize(canvas: HTMLCanvasElement, background: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round((rect.width || canvas.clientWidth || canvas.width) * dpr));
    const height = Math.max(1, Math.round((rect.height || canvas.clientHeight || canvas.height) * dpr));
    if (canvas.width === width && canvas.height === height) {
      return false;
    }

    canvas.width = width;
    canvas.height = height;
    background.width = width;
    background.height = height;
    const context = this.getContext(background);
    context.fillStyle = '#000000';
    context.fillRect(0, 0, width, height);
    return true;
  }

  private get selectedQuality(): AudioFourierPresetId {
    return this.qualitySelect.value in AUDIO_FOURIER_PRESETS
      ? this.qualitySelect.value as AudioFourierPresetId
      : 'balanced';
  }

  private requireElement(id: string): HTMLElement;
  private requireElement<T extends HTMLElement>(id: string, expected: new () => T): T;
  private requireElement<T extends HTMLElement>(id: string, expected?: new () => T): HTMLElement | T {
    const el = document.getElementById(id);
    if (!el) {
      throw new Error(`Missing required element: ${id}`);
    }
    if (expected && !(el instanceof expected)) {
      throw new Error(`Element ${id} is not ${expected.name}`);
    }
    return el as T;
  }

  private getContext(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to acquire audio canvas context.');
    }
    return context;
  }

  private buildBackgroundCanvas(sourceCanvas: HTMLCanvasElement): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const context = this.getContext(canvas);
    context.fillStyle = '#000000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }

  private getAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  private handleFileSelection(file: File | null) {
    if (!file) {
      return;
    }

    this.selection = {
      kind: 'file',
      label: file.name,
      file
    };
    this.input.value = '';
    this.clearActivePresetButton();
    this.syncSelection();
    this.invalidateComputedState('Audio file selected. Generate to build a full-song proxy.');
  }

  private applyBuiltInPreset(presetId: BuiltInAudioPresetId) {
    const preset = BUILT_IN_AUDIO_PRESETS[presetId];
    this.selection = {
      kind: 'preset',
      label: preset.label,
      presetId
    };
    this.syncSelection();
    this.invalidateComputedState('Song preset selected. Generate to inspect its Fourier energy.');
  }

  private clearActivePresetButton() {
    this.presetButtons.forEach((button) => button.classList.remove('active'));
  }

  private syncSelection() {
    this.selectionLabel.textContent = this.selection.label;
    this.presetButtons.forEach((button) => {
      button.classList.toggle(
        'active',
        this.selection.kind === 'preset' && button.dataset.audioPreset === this.selection.presetId
      );
    });
    this.syncButtons();
  }

  private syncButtons() {
    const hasResult = Boolean(this.activeResult);
    const isProcessing = this.state === 'processing';
    const isPlaying = this.state === 'animating';
    this.generateButton.disabled = isProcessing;
    this.qualitySelect.disabled = isProcessing;
    this.componentSlider.disabled = !hasResult || isProcessing;
    this.playPauseButton.disabled = !hasResult || isProcessing;
    const playbackButton = resolveAudioPlaybackButtonState({
      hasResult,
      isProcessing,
      isPlaying,
      isComplete: this.state === 'complete'
    });
    this.playPauseButton.textContent = playbackButton.icon;
    this.playPauseButton.setAttribute('aria-label', playbackButton.label);
    this.playPauseButton.title = playbackButton.label;
  }

  private onReducedMotionChange() {
    const prev = this.reducedMotion;
    this.reducedMotion = this.reducedMotionQuery.matches;
    if (prev !== this.reducedMotion) {
      this.syncButtons();
    }
  }
  private setState(state: AudioFourierState, text: string) {
    this.state = state;
    this.statusText.textContent = text;
    this.statusChip.textContent = state === 'animating' ? 'Playing' : state === 'ready' ? 'Ready' : state[0].toUpperCase() + state.slice(1);
    this.statusChip.className = `utility-status-chip utility-status-chip--${state}`;
    this.root.dataset.audioState = state;
    window.dispatchEvent(new CustomEvent('utilities-load-state', {
      detail: {
        source: 'audio-fourier',
        active: state === 'processing' || state === 'animating'
      }
    }));
    this.syncButtons();
  }

  private setProgress(progress: number, text: string, meta?: string) {
    const percent = clamp(Math.round(progress * 100), 0, 100);
    this.progressText.textContent = text;
    if (meta) {
      this.progressMeta.textContent = meta;
    }
    this.progressFill.style.width = `${percent}%`;
    this.progressBar.setAttribute('aria-valuenow', String(percent));
  }

  private clearDiagnostics() {
    delete this.root.dataset.audioLastRequestId;
    delete this.root.dataset.audioTotalMs;
    delete this.root.dataset.audioProxyMs;
    delete this.root.dataset.audioAnalysisMs;
    delete this.root.dataset.audioBandMs;
    delete this.root.dataset.audioComponentCount;
    delete this.root.dataset.audioSampleRate;
    delete this.root.dataset.audioProxyDuration;
    delete this.root.dataset.audioBandCount;
  }

  private syncDiagnostics(result: ActiveAudioFourier, requestId: number) {
    this.root.dataset.audioLastRequestId = String(requestId);
    this.root.dataset.audioTotalMs = result.metadata.timingsMs.total.toFixed(2);
    this.root.dataset.audioProxyMs = result.metadata.timingsMs.proxy.toFixed(2);
    this.root.dataset.audioAnalysisMs = result.metadata.timingsMs.analysis.toFixed(2);
    this.root.dataset.audioBandMs = result.metadata.timingsMs.bands.toFixed(2);
    this.root.dataset.audioComponentCount = String(result.metadata.componentCount);
    this.root.dataset.audioSampleRate = result.metadata.proxySampleRate.toFixed(2);
    this.root.dataset.audioProxyDuration = result.metadata.proxyDurationSeconds.toFixed(2);
    this.root.dataset.audioBandCount = String(result.metadata.bandCount);
  }

  private resetVisualScratch() {
    this.visualOriginalRawScratch = new Float32Array(0);
    this.visualMixRawScratch = new Float32Array(0);
    this.visualOriginalFrameScratch = new Float32Array(0);
    this.visualMixFrameScratch = new Float32Array(0);
  }

  private invalidateComputedState(statusText: string) {
    this.stopPlayback(false);
    this.abandonActiveComputation();
    this.activeResult = null;
    this.bandBuffers = [];
    this.activeMasterGain = null;
    this.resetVisualScratch();
    this.visualRevision = 0;
    this.playbackElapsedSeconds = 0;
    this.visualPlaybackElapsedSeconds = 0;
    this.clearDiagnostics();
    this.componentSlider.disabled = true;
    this.componentSlider.value = String(INITIAL_SLIDER_VALUE);
    this.componentReadout.textContent = 'Generate first';
    this.signalStrengthMetric.textContent = '--';
    this.signalCountMetric.textContent = '--';
    this.syncSliderProgress();
    this.sampleRateLabel.textContent = '—';
    this.componentCountLabel.textContent = '—';
    this.sourceDurationLabel.textContent = '—';
    this.durationLabel.textContent = '—';
    this.resultMeta.textContent = '';
    const preset = getAudioFourierPreset(this.selectedQuality);
    this.setState('idle', statusText);
    this.setProgress(0, 'Ready for audio.', `${preset.label} · full-song proxy at ${preset.proxySampleRate} Hz`);
    this.drawEmptyState();
  }

  private abandonActiveComputation() {
    this.activeWorkerRequestId = 0;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.workerVersion += 1;
    }
  }

  private async generate() {
    this.stopPlayback(false);
    this.activeResult = null;
    this.bandBuffers = [];
    this.activeMasterGain = null;
    this.resetVisualScratch();
    this.visualRevision = 0;
    this.playbackElapsedSeconds = 0;
    this.visualPlaybackElapsedSeconds = 0;
    this.clearDiagnostics();
    this.drawEmptyState();

    const requestId = ++this.activeRequestId;
    const preset = getAudioFourierPreset(this.selectedQuality);
    this.setState('processing', 'Preparing full-song proxy for Fourier analysis...');
    this.setProgress(0.02, 'Loading audio samples...', `${preset.label} · ${preset.proxySampleRate} Hz proxy`);

    try {
      await this.getAudioContext().resume();
    } catch (error) {
      // Some browsers still require a second explicit Play click after async analysis.
      console.warn('[AudioFourier] AudioContext resume was blocked before analysis started.', error);
      logAudioFourierWarning('AudioContext resume was blocked before analysis started.', error);
      this.audioContextBlocked = true;
      this.playPauseButton.title = 'Audio blocked by browser — click to unlock';
      this.setProgress(
        0.02,
        'Loading audio samples...',
        'Browser blocked audio unlock. Press Play after generation if autoplay is unavailable.'
      );
    }

    try {
      const source = await this.resolveAudioSource();
      if (requestId !== this.activeRequestId) {
        return;
      }

      const worker = this.getWorker();
      const transfer = source.channelBuffers.slice();
      // The channelBuffers are transferred (not copied) to the worker via the transfer array.
      // After postMessage returns, the Float32Array backing buffers are detached and no longer
      // accessible from the main thread. This avoids a costly deep copy of the sample data.
      const request: AudioFourierWorkerRequest = {
        type: 'analyze-audio-fourier',
        requestId,
        presetId: preset.id,
        source
      };
      this.activeWorkerRequestId = requestId;
      worker.postMessage(request, transfer);
    } catch (error) {
      if (requestId !== this.activeRequestId) {
        return;
      }
      this.setState('error', error instanceof Error ? error.message : 'Unable to prepare this audio file.');
      this.setProgress(0, 'Audio preparation failed.', 'Try a browser-supported audio file or a built-in song preset.');
    }
  }

  private async resolveAudioSource(): Promise<AudioFourierSourceTransfer> {
    if (this.selection.kind === 'preset' && this.selection.presetId) {
      const preset = BUILT_IN_AUDIO_PRESETS[this.selection.presetId];
      const response = await fetch(preset.url, { mode: 'same-origin' });
      if (!response.ok) {
        throw new Error(`Unable to load built-in song: ${preset.label}`);
      }
      const decoded = await this.decodeAudioData(await response.arrayBuffer());
      return this.audioBufferToSourceTransfer(decoded, preset.label, 'preset', preset.id);
    }

    if (!this.selection.file) {
      throw new Error('Choose an audio file or a built-in song preset first.');
    }

    if (!this.selection.file.type.startsWith('audio/')) {
      throw new Error('Selected file is not a browser-supported audio file.');
    }

    const arrayBuffer = await this.selection.file.arrayBuffer();
    const decoded = await this.decodeAudioData(arrayBuffer);
    return this.audioBufferToSourceTransfer(decoded, this.selection.file.name, 'file');
  }

  private async decodeAudioData(arrayBuffer: ArrayBuffer) {
    try {
      return await this.getAudioContext().decodeAudioData(arrayBuffer.slice(0));
    } catch (error) {
      throw new Error('Unable to decode this audio file in the browser.', { cause: error });
    }
  }

  private audioBufferToSourceTransfer(
    decoded: AudioBuffer,
    label: string,
    sourceKind: 'preset' | 'file',
    builtInPresetId?: BuiltInAudioPresetId
  ): AudioFourierSourceTransfer {
    const channels = Array.from(
      { length: decoded.numberOfChannels },
      (_value, channelIndex) => new Float32Array(decoded.getChannelData(channelIndex))
    );
    return this.audioChannelsToSourceTransfer(channels, decoded.sampleRate, label, sourceKind, builtInPresetId);
  }

  private audioChannelsToSourceTransfer(
    channels: Float32Array[],
    sampleRate: number,
    label: string,
    sourceKind: 'preset' | 'file',
    builtInPresetId?: BuiltInAudioPresetId
  ): AudioFourierSourceTransfer {
    return {
      sampleRate,
      channelBuffers: channels.map((channel) => sliceArrayBufferView(channel)),
      label,
      sourceKind,
      builtInPresetId
    };
  }

  private getWorker() {
    if (this.worker) {
      return this.worker;
    }

    if (!supportsModuleWorkers()) {
      throw new Error('This browser does not support module workers required for audio analysis.');
    }

    this.worker = new Worker(new URL('./audioFourier.worker.ts', import.meta.url), {
      type: 'module'
    });
    const workerVersion = ++this.workerVersion;
    this.worker.addEventListener('message', (event: MessageEvent<AudioFourierWorkerResponse>) => {
      if (workerVersion !== this.workerVersion) {
        return;
      }
      this.handleWorkerMessage(event.data);
    });
    this.worker.addEventListener('error', (event) => {
      if (workerVersion !== this.workerVersion) {
        return;
      }
      event.preventDefault();
      this.handleWorkerFailure();
    });
    this.worker.addEventListener('messageerror', () => {
      if (workerVersion !== this.workerVersion) {
        return;
      }
      this.handleWorkerFailure();
    });
    return this.worker;
  }

  private handleGenerateFailure(error: unknown) {
    console.error('[AudioFourier] Generate failed.', error);
    this.setState('error', error instanceof Error ? error.message : 'Audio generation failed.');
    this.setProgress(0, 'Audio generation failed.', 'Try a built-in song preset, a shorter file, or the Fast quality preset.');
  }

  private handleWorkerFailure() {
    this.activeWorkerRequestId = 0;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.workerVersion += 1;
    }
    this.setState('error', 'Audio worker unavailable. Press Generate to retry.');
    this.setProgress(0, 'Worker failure stopped the audio analysis.', 'Retry starts a fresh worker without reloading the page.');
  }

  private handleWorkerMessage(message: AudioFourierWorkerResponse) {
    if (message.requestId !== this.activeRequestId) {
      return;
    }

    if (message.type === 'audio-fourier-progress') {
      this.setState('processing', message.message);
      this.setProgress(message.progress, message.message);
      return;
    }

    if (message.type === 'audio-fourier-error') {
      this.activeWorkerRequestId = 0;
      this.clearDiagnostics();
      this.setState('error', message.message);
      this.setProgress(0, message.message, 'Try a built-in song preset, a shorter file, or the Fast quality preset.');
      return;
    }

    if (message.type === 'audio-fourier-cancelled') {
      this.activeWorkerRequestId = 0;
      this.clearDiagnostics();
      this.setState('idle', 'Audio Fourier analysis cancelled.');
      this.setProgress(0, 'Analysis cancelled.');
      return;
    }

    this.activeWorkerRequestId = 0;
    this.applySuccess(message);
  }

  private applySuccess(message: AudioFourierSuccessMessage) {
    const sliderMaxValue = this.resolveSliderMaxValue();
    const sliderValue = Math.min(INITIAL_SLIDER_VALUE, sliderMaxValue);
    const energyPercent = mapSliderValueToEnergyPercent(sliderValue, sliderMaxValue);
    const bandEnergyFractions = new Float32Array(arrayBufferLikeToArrayBuffer(message.bandEnergyFractions));
    const result: ActiveAudioFourier = {
      metadata: message.metadata,
      bandSamples: new Float32Array(arrayBufferLikeToArrayBuffer(message.bandSamples)),
      originalEnvelopeMin: new Float32Array(arrayBufferLikeToArrayBuffer(message.originalEnvelopeMin)),
      originalEnvelopeMax: new Float32Array(arrayBufferLikeToArrayBuffer(message.originalEnvelopeMax)),
      bandEnvelopeMin: new Float32Array(arrayBufferLikeToArrayBuffer(message.bandEnvelopeMin)),
      bandEnvelopeMax: new Float32Array(arrayBufferLikeToArrayBuffer(message.bandEnvelopeMax)),
      bandEndComponentCounts: new Uint32Array(arrayBufferLikeToArrayBuffer(message.bandEndComponentCounts)),
      bandEnergyFractions,
      componentFrequencies: new Float32Array(arrayBufferLikeToArrayBuffer(message.componentFrequencies)),
      componentAmplitudes: new Float32Array(arrayBufferLikeToArrayBuffer(message.componentAmplitudes)),
      componentPhases: new Float32Array(arrayBufferLikeToArrayBuffer(message.componentPhases)),
      bandGains: resolveEnergyBandGains(energyPercent, bandEnergyFractions),
      energyPercent
    };

    this.activeResult = result;
    this.bandBuffers = [];
    this.resetVisualScratch();
    this.visualRevision = 0;
    this.playbackElapsedSeconds = 0;
    this.visualPlaybackElapsedSeconds = 0;
    this.syncDiagnostics(result, message.requestId);
    this.configureSlider();
    this.sampleRateLabel.textContent = `${result.metadata.proxySampleRate.toFixed(0)} Hz proxy`;
    this.componentCountLabel.textContent = result.metadata.componentCount.toLocaleString();
    this.sourceDurationLabel.textContent = `${formatSeconds(result.metadata.sourceDurationSeconds)} source`;
    this.durationLabel.textContent = `Analysis ${result.metadata.timingsMs.total.toFixed(0)} ms`;
    this.renderCurrentViewport();
    this.setState('ready', 'Fourier proxy ready. Press Play to start audio.');
    this.syncEnergyReadout();
    this.resultMeta.textContent = '';
    this.setProgress(1, 'Fourier proxy ready.');
    void this.attemptAutoPlay(message.requestId);
  }

  private configureSlider() {
    if (!this.activeResult) {
      return;
    }

    const sliderMaxValue = this.resolveSliderMaxValue();
    this.componentSlider.disabled = false;
    this.componentSlider.min = '0';
    this.componentSlider.max = String(sliderMaxValue);
    this.componentSlider.step = '1';
    this.componentSlider.value = String(Math.min(INITIAL_SLIDER_VALUE, sliderMaxValue));
    this.componentMinLabel.textContent = 'Sparse';
    this.componentMaxLabel.textContent = 'Full proxy';
    this.syncSliderProgress();
  }

  private resolveSliderMaxValue(value = Number(this.componentSlider.max)) {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 100;
  }

  private syncSliderProgress() {
    const sliderMaxValue = this.resolveSliderMaxValue();
    const sliderValue = clamp(Number(this.componentSlider.value), 0, sliderMaxValue);
    const progress = sliderMaxValue > 0 ? sliderValue / sliderMaxValue : 0;
    this.componentSlider.style.setProperty('--audio-slider-progress', `${progress * 100}%`);
  }

  private handleSliderInput() {
    if (!this.activeResult) {
      return;
    }

    const sliderMaxValue = this.resolveSliderMaxValue();
    const sliderValue = clamp(Number(this.componentSlider.value), 0, sliderMaxValue);
    this.componentSlider.value = String(sliderValue);
    this.syncSliderProgress();
    this.activeResult.energyPercent = mapSliderValueToEnergyPercent(
      sliderValue,
      sliderMaxValue
    );
    this.activeResult.bandGains = resolveEnergyBandGains(this.activeResult.energyPercent, this.activeResult.bandEnergyFractions);
    this.activeComponentsCacheKey = '';
    this.updateLiveBandGains();
    this.syncEnergyReadout();

    if (this.state === 'animating') {
      if (!this.sliderRafPending) {
        this.sliderRafPending = true;
        window.requestAnimationFrame(() => {
          this.sliderRafPending = false;
          this.renderWaveViewport(true);
          this.drawSpectrumFrame();
          this.drawComponentFrame();
        });
      }
      return;
    }

    if (!this.sliderRafPending) {
      this.sliderRafPending = true;
      window.requestAnimationFrame(() => {
        this.sliderRafPending = false;
        this.drawSpectrumFrame();
        this.drawComponentFrame();
        this.queueDeferredWaveRender();
      });
    }
  }

  private syncEnergyReadout() {
    if (!this.activeResult) {
      return;
    }

    const energyPercent = Math.round(this.activeResult.energyPercent * 100);
    const activeComponents = this.resolveApproximateActiveComponents();
    const total = this.activeResult.metadata.componentCount;
    this.componentReadout.textContent = `${energyPercent}% signal energy · ${activeComponents.toLocaleString()} / ${total.toLocaleString()} components`;
    this.signalStrengthMetric.textContent = `${energyPercent}%`;
    this.signalCountMetric.textContent = `${activeComponents.toLocaleString()} / ${total.toLocaleString()}`;
  }

  private resolveApproximateActiveComponents() {
    if (!this.activeResult) {
      return 0;
    }
    const cacheKey = encodeAudioFourierBandGainsCacheKey(this.activeResult.bandGains);
    if (cacheKey === this.activeComponentsCacheKey) {
      return this.activeComponentsCacheValue;
    }

    let previousComponentCount = 0;
    for (let bandIndex = 0; bandIndex < this.activeResult.bandGains.length; bandIndex += 1) {
      const gain = this.activeResult.bandGains[bandIndex];
      const endComponentCount = this.activeResult.bandEndComponentCounts[bandIndex];
      if (gain < 1) {
        this.activeComponentsCacheKey = cacheKey;
        this.activeComponentsCacheValue = Math.round(previousComponentCount + (endComponentCount - previousComponentCount) * gain);
        return this.activeComponentsCacheValue;
      }
      previousComponentCount = endComponentCount;
    }

    this.activeComponentsCacheKey = cacheKey;
    this.activeComponentsCacheValue = this.activeResult.metadata.componentCount;
    return this.activeComponentsCacheValue;
  }

  private ensureVisualScratch(pointCount: number) {
    if (this.visualOriginalRawScratch.length >= pointCount) {
      return;
    }

    this.visualOriginalRawScratch = new Float32Array(pointCount);
    this.visualMixRawScratch = new Float32Array(pointCount);
    this.visualOriginalFrameScratch = new Float32Array(pointCount);
    this.visualMixFrameScratch = new Float32Array(pointCount);
  }

  private queueDeferredWaveRender(delayMs = 80) {
    if (this.deferredWaveRenderTimeoutId) {
      window.clearTimeout(this.deferredWaveRenderTimeoutId);
    }

    this.deferredWaveRenderTimeoutId = window.setTimeout(() => {
      this.deferredWaveRenderTimeoutId = 0;
      if (!this.activeResult || this.state === 'processing' || this.state === 'error') {
        return;
      }
      this.renderWaveViewport(this.state === 'animating');
    }, delayMs);
  }

  private clearDeferredWaveRender() {
    if (!this.deferredWaveRenderTimeoutId) {
      return;
    }

    window.clearTimeout(this.deferredWaveRenderTimeoutId);
    this.deferredWaveRenderTimeoutId = 0;
  }

  private resolveVisibleMixedAmplitude(bucketIndex: number) {
    if (!this.activeResult) {
      return 0;
    }

    let mixedMin = 0;
    let mixedMax = 0;
    const bucketCount = this.activeResult.metadata.envelopeBucketCount;
    for (let bandIndex = 0; bandIndex < this.activeResult.bandGains.length; bandIndex += 1) {
      const gain = Math.max(0, this.activeResult.bandGains[bandIndex]);
      if (gain === 0) {
        continue;
      }
      const envelopeIndex = bandIndex * bucketCount + bucketIndex;
      mixedMin += (this.activeResult.bandEnvelopeMin[envelopeIndex] ?? 0) * gain;
      mixedMax += (this.activeResult.bandEnvelopeMax[envelopeIndex] ?? 0) * gain;
    }

    return Math.max(Math.abs(mixedMin), Math.abs(mixedMax));
  }

  private ensureBandBuffers() {
    if (!this.activeResult || this.bandBuffers.length > 0) {
      return;
    }

    const context = this.getAudioContext();
    const sampleCount = this.activeResult.metadata.proxySampleCount;
    for (let bandIndex = 0; bandIndex < this.activeResult.metadata.bandCount; bandIndex += 1) {
      const buffer = context.createBuffer(1, sampleCount, this.activeResult.metadata.proxySampleRate);
      const bandSlice = new Float32Array(this.activeResult.bandSamples.subarray(bandIndex * sampleCount, (bandIndex + 1) * sampleCount));
      buffer.copyToChannel(
        bandSlice,
        0
      );
      this.bandBuffers.push(buffer);
    }
  }

  /**
   * Attempt to autoplay after generation completes.
   * Intentionally voided at call site — browsers block autoplay until user gesture.
   */
  private async attemptAutoPlay(requestId: number) {
    if (requestId !== this.activeRequestId || !this.activeResult || this.state !== 'ready') {
      return;
    }

    try {
      await this.playPlayback();
    } catch (error) {
      logAudioFourierWarning('Autoplay was blocked after Fourier analysis completed.', error);
      if (requestId !== this.activeRequestId || !this.activeResult) {
        return;
      }
      this.stopPlayback(false);
      this.renderCurrentViewport();
      this.setState('ready', 'Fourier proxy ready. Press Play to start audio.');
      this.resultMeta.textContent = '';
    }
  }

  private async handlePlayPauseClick() {
    if (this.state === 'animating') {
      this.pausePlayback();
      return;
    }

    if (!this.activeResult) {
      return;
    }

    if (
      this.state === 'complete' ||
      this.playbackElapsedSeconds >= this.activeResult.metadata.proxyDurationSeconds * FULL_ENERGY_VISUAL_THRESHOLD
    ) {
      this.playbackElapsedSeconds = 0;
    }

    await this.playPlayback();
  }

  private async playPlayback() {
    if (!this.activeResult) {
      this.syncButtons();
      return;
    }

    const activeResult = this.activeResult;
    const context = this.getAudioContext();
    await context.resume();
    this.audioContextBlocked = false;
    this.ensureBandBuffers();
    const offset = clamp(this.playbackElapsedSeconds, 0, activeResult.metadata.proxyDurationSeconds);
    const startedAt = context.currentTime + PLAYBACK_START_DELAY_SECONDS;
    const masterGainValue = resolveEnergyMakeupGain(this.activeResult.energyPercent);
    const masterGain = context.createGain();
    masterGain.gain.value = 0;
    masterGain.gain.setValueAtTime(0, startedAt);
    masterGain.gain.linearRampToValueAtTime(masterGainValue, startedAt + PLAYBACK_FADE_SECONDS);
    masterGain.connect(context.destination);
    this.activeMasterGain = masterGain;
    this.masterGainControlReadyAt = startedAt + PLAYBACK_FADE_SECONDS;
    this.activeBandNodes = this.bandBuffers.map((buffer, index) => {
      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = activeResult.bandGains[index];
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(masterGain);
      source.start(startedAt, offset);
      return { source, gain, disconnected: false };
    });
    if (this.activeBandNodes.length !== activeResult.bandGains.length) {
      this.stopPlayback(false);
      throw new Error('Audio band buffer count does not match the active gain count.');
    }

    const firstNode = this.activeBandNodes[0];
    if (firstNode) {
      firstNode.source.onended = () => {
        if (this.state !== 'animating') {
          return;
        }
        if (this.destroyed) {
          return;
        }
        this.playbackElapsedSeconds = this.activeResult?.metadata.proxyDurationSeconds ?? 0;
        this.visualPlaybackElapsedSeconds = this.playbackElapsedSeconds;
        this.activeBandNodes = [];
        this.setState('complete', 'Playback complete.');
        this.resultMeta.textContent = '';
        this.stopAnimationFrame();
        this.syncButtons();
      };
    }

    this.playbackStartedAt = startedAt - offset;
    this.visualPlaybackElapsedSeconds = offset;
    this.visualPlaybackUpdatedAt = 0;
    this.lastPlaybackProgressAt = 0;
    this.setState('animating', 'Playing selected Fourier energy mix...');
    this.tickPlayback();
  }

  private pausePlayback() {
    if (!this.activeResult || this.state !== 'animating') {
      return;
    }

    const context = this.getAudioContext();
    this.playbackElapsedSeconds = clamp(context.currentTime - this.playbackStartedAt, 0, this.activeResult.metadata.proxyDurationSeconds);
    this.visualPlaybackElapsedSeconds = this.playbackElapsedSeconds;
    this.stopPlayback(false);
    this.setState('ready', 'Playback paused.');
    this.drawSpectrumFrame();
    this.drawComponentFrame();
    this.queueDeferredWaveRender(0);
  }

  private stopPlayback(resetElapsed: boolean) {
    this.stopAnimationFrame();
    this.clearDeferredWaveRender();
    for (const node of this.activeBandNodes) {
      node.source.onended = null;
      try {
        node.source.stop();
      } catch (error) {
        // Stopping an already-ended one-shot source is harmless, but log unexpected failures.
        console.warn('[AudioFourier] stopPlayback: node.source.stop() failed:', error);
      }
      if (!node.disconnected) {
        node.source.disconnect();
        node.gain.disconnect();
        node.disconnected = true;
      }
    }
    this.activeBandNodes = [];
    if (this.activeMasterGain) {
      this.activeMasterGain.disconnect();
      this.activeMasterGain = null;
    }
    if (resetElapsed) {
      this.playbackElapsedSeconds = 0;
      this.visualPlaybackElapsedSeconds = 0;
    }
    this.visualPlaybackUpdatedAt = 0;
  }

  private updateLiveBandGains() {
    if (!this.activeResult || this.activeBandNodes.length === 0) {
      return;
    }

    const context = this.getAudioContext();
    for (let index = 0; index < this.activeBandNodes.length; index += 1) {
      this.activeBandNodes[index].gain.gain.setTargetAtTime(this.activeResult.bandGains[index], context.currentTime, GAIN_RAMP_TIME_CONSTANT);
    }
    if (this.activeMasterGain) {
      const updateTime = Math.max(context.currentTime, this.masterGainControlReadyAt);
      const targetGain = resolveEnergyMakeupGain(this.activeResult.energyPercent);
      this.activeMasterGain.gain.cancelScheduledValues(updateTime);
      this.activeMasterGain.gain.linearRampToValueAtTime(targetGain, updateTime + MASTER_GAIN_RAMP_TIME_CONSTANT);
    }
  }

  private stopAnimationFrame() {
    if (this.animationFrameId) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
  }

  private tickPlayback() {
    const step = (timestamp: number) => {
      if (!this.activeResult || this.state !== 'animating') {
        return;
      }

      const context = this.getAudioContext();
      this.playbackElapsedSeconds = clamp(context.currentTime - this.playbackStartedAt, 0, this.activeResult.metadata.proxyDurationSeconds);
      if (!this.visualPlaybackUpdatedAt) {
        this.visualPlaybackUpdatedAt = timestamp;
        this.visualPlaybackElapsedSeconds = this.playbackElapsedSeconds;
      } else {
        const frameDeltaSeconds = Math.max(0, (timestamp - this.visualPlaybackUpdatedAt) / 1000);
        this.visualPlaybackUpdatedAt = timestamp;
        this.visualPlaybackElapsedSeconds = clamp(
          this.visualPlaybackElapsedSeconds + frameDeltaSeconds,
          0,
          this.activeResult.metadata.proxyDurationSeconds
        );
        const drift = this.playbackElapsedSeconds - this.visualPlaybackElapsedSeconds;
        if (Math.abs(drift) > VISUAL_CLOCK_RECONCILE_SECONDS) {
          this.visualPlaybackElapsedSeconds = this.playbackElapsedSeconds;
        } else {
          this.visualPlaybackElapsedSeconds = clamp(
            this.visualPlaybackElapsedSeconds + drift * VISUAL_CLOCK_DAMPING_FACTOR,
            0,
            this.activeResult.metadata.proxyDurationSeconds
          );
        }
      }
      this.renderWaveViewport(true);
      if (!this.lastPlaybackProgressAt || timestamp - this.lastPlaybackProgressAt >= PLAYBACK_PROGRESS_UPDATE_MS) {
        this.lastPlaybackProgressAt = timestamp;
        this.progressMeta.textContent = `${formatSeconds(this.playbackElapsedSeconds)} / ${formatSeconds(this.activeResult.metadata.proxyDurationSeconds)}`;
      }
      this.animationFrameId = window.requestAnimationFrame(step);
    };

    this.stopAnimationFrame();
    this.animationFrameId = window.requestAnimationFrame(step);
  }

  private resetAll() {
    this.stopPlayback(true);
    this.abandonActiveComputation();
    this.selection = buildDefaultAudioSelection();
    this.activeResult = null;
    this.bandBuffers = [];
    this.resetVisualScratch();
    this.visualRevision = 0;
    this.clearDiagnostics();
    this.syncSelection();
    this.invalidateComputedState('Choose an audio file or start from a built-in song preset.');
  }

  private drawEmptyState() {
    this.waveRenderer.setEnvelopeData(null);
    this.waveRenderer.drawEmptyState('Waveform will appear here');
    this.clearCanvas(this.spectrumCanvas, this.spectrumContext);
    this.clearCanvas(this.componentCanvas, this.componentContext);
    this.drawCenteredLabel(this.spectrumCanvas, this.spectrumContext, 'Energy bands will appear here');
    this.drawCenteredLabel(this.componentCanvas, this.componentContext, 'Active signal-energy readout');
  }

  private clearCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
    const background =
      canvas === this.spectrumCanvas ? this.spectrumBackgroundCanvas :
      canvas === this.componentCanvas ? this.componentBackgroundCanvas :
      null;

    if (background) {
      context.drawImage(background, 0, 0);
      return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  private drawCenteredLabel(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, label: string) {
    context.save();
    context.fillStyle = 'rgba(235, 244, 239, 0.55)';
    context.font = '16px Inter, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, canvas.width / 2, canvas.height / 2);
    context.restore();
  }

  private renderWaveViewport(livePlayback = false) {
    if (!this.activeResult) {
      return;
    }

    const result = this.activeResult;
    const currentSeconds = livePlayback ? this.visualPlaybackElapsedSeconds : this.playbackElapsedSeconds;
    const range = resolveEnvelopeViewportRange(
      currentSeconds,
      result.metadata.proxyDurationSeconds,
      result.metadata.proxySampleRate,
      this.viewportSeconds,
      result.metadata.envelopeBucketSampleCount
    );
    const visualPointCount = Math.max(1, range.lastBucketIndex - range.firstBucketIndex);
    const isFullEnergy = result.energyPercent >= FULL_ENERGY_VISUAL_THRESHOLD;
    this.ensureVisualScratch(visualPointCount);

    for (let pointIndex = 0; pointIndex < visualPointCount; pointIndex += 1) {
      const bucketIndex = range.firstBucketIndex + pointIndex;
      const originalAmplitude = Math.max(
        Math.abs(result.originalEnvelopeMin[bucketIndex] ?? 0),
        Math.abs(result.originalEnvelopeMax[bucketIndex] ?? 0)
      );
      const mixedAmplitude = isFullEnergy
        ? originalAmplitude
        : this.resolveVisibleMixedAmplitude(bucketIndex);
      this.visualOriginalRawScratch[pointIndex] = originalAmplitude;
      this.visualMixRawScratch[pointIndex] = resolveHighEnergyVisualAmplitude(
        originalAmplitude,
        mixedAmplitude,
        result.energyPercent
      );
    }

    writeSmoothedEnvelopeAmplitudes(this.visualOriginalRawScratch, this.visualOriginalFrameScratch, visualPointCount);
    writeSmoothedEnvelopeAmplitudes(this.visualMixRawScratch, this.visualMixFrameScratch, visualPointCount);
    this.waveRenderer.setEnvelopeData({
      originalAmplitudes: this.visualOriginalFrameScratch,
      reconstructedAmplitudes: this.visualMixFrameScratch,
      bucketCount: visualPointCount,
      bucketSampleCount: result.metadata.envelopeBucketSampleCount,
      revision: this.visualRevision += 1
    });

    const viewportLocalStartSample = range.startSample - range.firstBucketIndex * result.metadata.envelopeBucketSampleCount;
    const playheadX = livePlayback
      ? clamp((currentSeconds * result.metadata.proxySampleRate - range.startSample) / range.viewportSampleCount * this.waveCanvas.width, 0, this.waveCanvas.width)
      : null;

    this.waveRenderer.renderFrame({
      firstBucketIndex: 0,
      pointCount: visualPointCount,
      startSample: viewportLocalStartSample,
      viewportSampleCount: range.viewportSampleCount,
      isFullEnergy,
      playheadX,
      livePlayback
    });
  }

  private renderCurrentViewport() {
    this.renderWaveViewport();
    this.drawSpectrumFrame();
    this.drawComponentFrame();
  }

  private drawSpectrumFrame() {
    if (!this.activeResult) {
      return;
    }

    const context = this.spectrumContext;
    const canvas = this.spectrumCanvas;
    this.clearCanvas(canvas, context);
    const barCount = this.activeResult.metadata.bandCount;
    const gap = 3;
    const barWidth = Math.max(3, (canvas.width - gap * (barCount - 1)) / barCount);

    for (let index = 0; index < barCount; index += 1) {
      const previousEnergy = index > 0 ? this.activeResult.bandEnergyFractions[index - 1] : 0;
      const bandEnergy = Math.max(0, this.activeResult.bandEnergyFractions[index] - previousEnergy);
      const height = Math.max(2, bandEnergy * barCount * (canvas.height - 36));
      const x = index * (barWidth + gap);
      const y = canvas.height - height;
      const gain = this.activeResult.bandGains[index];
      context.fillStyle = gain > 0 ? `rgba(255, 255, 255, ${0.3 + gain * 0.7})` : 'rgba(255, 255, 255, 0.15)';
      context.fillRect(x, y, barWidth, height);
    }
  }

  private drawComponentFrame() {
    if (!this.activeResult) {
      return;
    }

    const context = this.componentContext;
    const canvas = this.componentCanvas;
    this.clearCanvas(canvas, context);
    const activeComponents = this.resolveApproximateActiveComponents();
    if (activeComponents === 0) {
      context.save();
      context.fillStyle = 'rgba(255, 255, 255, 0.55)';
      context.font = '16px Inter, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText('No active components', canvas.width / 2, canvas.height / 2);
      context.restore();
      return;
    }
    const componentIndex = clamp(activeComponents - 1, 0, this.activeResult.componentFrequencies.length - 1);
    const frequency = this.activeResult.componentFrequencies[componentIndex];
    const amplitude = this.activeResult.componentAmplitudes[componentIndex];
    const phase = this.activeResult.componentPhases[componentIndex];
    const cycles = clamp(frequency / Math.max(1, this.activeResult.metadata.proxySampleRate) * 48, 1, 18);

    context.save();
    context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    context.lineWidth = 3;
    context.shadowColor = 'rgba(255, 255, 255, 0.5)';
    context.shadowBlur = 14;
    context.beginPath();
    const xStep = Math.max(1, Math.ceil(canvas.width / COMPONENT_WAVE_MAX_POINTS));
    for (let x = 0; x < canvas.width; x += xStep) {
      const progress = x / canvas.width;
      const y = canvas.height * 0.58 - Math.sin(progress * Math.PI * 2 * cycles + phase) * canvas.height * 0.22;
      if (x === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
    context.shadowBlur = 0;
    context.fillStyle = 'rgba(255, 255, 255, 0.92)';
    context.font = '18px Inter, sans-serif';
    context.fillText(`${Math.round(this.activeResult.energyPercent * 100)}% signal energy`, 22, 34);
    context.font = '14px JetBrains Mono, monospace';
    context.fillStyle = 'rgba(255, 255, 255, 0.72)';
    context.fillText(`${activeComponents.toLocaleString()} components · ${formatFrequency(frequency)} · amp ${amplitude.toFixed(4)} · phase ${phase.toFixed(2)}`, 22, 58);
    context.restore();
  }

  public destroy() {
    this.destroyed = true;
    this.eventController.abort();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeFrameId) {
      window.cancelAnimationFrame(this.resizeFrameId);
      this.resizeFrameId = 0;
    }
    this.clearDeferredWaveRender();
    this.stopPlayback(true);
    this.abandonActiveComputation();
    this.audioContext?.close();
    this.audioContext = null;
    this.bandBuffers = [];
    this.activeMasterGain = null;
    this.visualRevision = 0;
    this.waveRenderer.dispose();
    this.stopAnimationFrame();
    this.sliderRafPending = false;
    this.setState('idle', 'Destroyed.');
  }
}
