import {
  BUILT_IN_AUDIO_PRESETS,
  DEFAULT_BUILT_IN_AUDIO_PRESET_ID,
  getAudioFourierPreset,
  type AudioFourierPresetId,
  type BuiltInAudioPresetId
} from './audioPresets';
import {
  mapSliderValueToEnergyPercent,
  mixEnergyBands,
  resolveEnergyBandGains,
  resolveEnergyMakeupGain
} from './audioFourierCore';
import { resolveAudioPlaybackButtonLabel } from './audioFourierUiState';
import type { AudioFourierSourceTransfer, AudioFourierSuccessMessage, AudioFourierWorkerRequest, AudioFourierWorkerResponse } from './audioFourierWorkerTypes';

type AudioFourierState = 'idle' | 'processing' | 'ready' | 'animating' | 'complete' | 'error';

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

interface ActiveBandNode {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

interface ActiveAudioFourier {
  metadata: AudioFourierSuccessMessage['metadata'];
  originalSamples: Float32Array;
  bandSamples: Float32Array;
  bandEndComponentCounts: Uint32Array;
  bandEnergyFractions: Float32Array;
  componentFrequencies: Float32Array;
  componentAmplitudes: Float32Array;
  componentPhases: Float32Array;
  bandGains: Float32Array;
  energyPercent: number;
}

function asArrayBuffer(buffer: ArrayBufferLike) {
  return buffer as ArrayBuffer;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatSeconds(value: number) {
  if (value >= 60) {
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
const MAX_VISUAL_POINTS = 1024;
const MIN_VISUAL_POINTS = 768;
const LIVE_MAX_VISUAL_POINTS = 384;
const LIVE_MIN_VISUAL_POINTS = 256;
const LIVE_ENVELOPE_SAMPLES_PER_POINT = 4;
const STATIC_ENVELOPE_SAMPLES_PER_POINT = 16;

export class AudioFourierController {
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly viewportSeconds = 2;
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly qualitySelect: HTMLSelectElement;
  private readonly generateButton: HTMLButtonElement;
  private readonly playButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly componentSlider: HTMLInputElement;
  private readonly componentReadout: HTMLElement;
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
  private readonly waveContext: CanvasRenderingContext2D;
  private readonly spectrumContext: CanvasRenderingContext2D;
  private readonly componentContext: CanvasRenderingContext2D;
  private readonly dropzone: HTMLElement;
  private readonly presetButtons: HTMLButtonElement[];

  private selection: AudioFourierSelection = buildDefaultAudioSelection();
  private worker: Worker | null = null;
  private activeRequestId = 0;
  private activeWorkerRequestId = 0;
  private activeResult: ActiveAudioFourier | null = null;
  private audioContext: AudioContext | null = null;
  private bandBuffers: AudioBuffer[] = [];
  private activeBandNodes: ActiveBandNode[] = [];
  private activeMasterGain: GainNode | null = null;
  private visualMixSamples = new Float32Array(0);
  private playbackStartedAt = 0;
  private playbackElapsedSeconds = 0;
  private animationFrameId = 0;
  private visualOriginalMinScratch = new Float32Array(MAX_VISUAL_POINTS);
  private visualOriginalMaxScratch = new Float32Array(MAX_VISUAL_POINTS);
  private visualMixMinScratch = new Float32Array(MAX_VISUAL_POINTS);
  private visualMixMaxScratch = new Float32Array(MAX_VISUAL_POINTS);
  private lastPlaybackProgressAt = 0;
  private lastLiveRenderAt = 0;
  private state: AudioFourierState = 'idle';
  private sliderRafPending = false;
  private readonly waveBackgroundCanvas: HTMLCanvasElement;
  private readonly spectrumBackgroundCanvas: HTMLCanvasElement;
  private readonly componentBackgroundCanvas: HTMLCanvasElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.input = this.requireElement('audioFourierInput');
    this.qualitySelect = this.requireElement('audioFourierQuality');
    this.generateButton = this.requireElement('audioFourierGenerateBtn');
    this.playButton = this.requireElement('audioFourierPlayBtn');
    this.pauseButton = this.requireElement('audioFourierPauseBtn');
    this.resetButton = this.requireElement('audioFourierResetBtn');
    this.componentSlider = this.requireElement('audioFourierComponentSlider');
    this.componentReadout = this.requireElement('audioFourierComponentReadout');
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
    this.waveCanvas = this.requireElement('audioFourierWaveCanvas');
    this.spectrumCanvas = this.requireElement('audioFourierSpectrumCanvas');
    this.componentCanvas = this.requireElement('audioFourierComponentCanvas');
    this.dropzone = this.requireElement('audioFourierDropzone');
    this.presetButtons = Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-audio-preset]'));
    this.waveContext = this.getContext(this.waveCanvas);
    this.spectrumContext = this.getContext(this.spectrumCanvas);
    this.componentContext = this.getContext(this.componentCanvas);
    this.waveBackgroundCanvas = this.buildBackgroundCanvas(this.waveCanvas);
    this.spectrumBackgroundCanvas = this.buildBackgroundCanvas(this.spectrumCanvas);
    this.componentBackgroundCanvas = this.buildBackgroundCanvas(this.componentCanvas);
  }

  init() {
    this.input.addEventListener('change', () => this.handleFileSelection(this.input.files?.[0] ?? null));
    this.generateButton.addEventListener('click', () => {
      void this.generate();
    });
    this.playButton.addEventListener('click', () => {
      void this.handlePlaybackButton();
    });
    this.pauseButton.addEventListener('click', () => this.pausePlayback());
    this.resetButton.addEventListener('click', () => this.resetAll());
    this.qualitySelect.addEventListener('change', () => this.invalidateComputedState('Quality changed. Generate again to rebuild the audio transform.'));
    this.componentSlider.addEventListener('input', () => this.handleSliderInput());
    this.bindDropzone();

    this.presetButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const presetId = button.dataset.audioPreset as BuiltInAudioPresetId | undefined;
        if (!presetId || !(presetId in BUILT_IN_AUDIO_PRESETS)) {
          return;
        }
        this.applyBuiltInPreset(presetId);
      });
    });

    this.componentSlider.disabled = true;
    this.componentSlider.min = '0';
    this.componentSlider.max = '100';
    this.componentSlider.value = String(INITIAL_SLIDER_VALUE);
    this.componentMinLabel.textContent = 'Sparse';
    this.componentMaxLabel.textContent = 'Full proxy';
    this.componentReadout.textContent = 'Generate first';
    this.syncSelection();
    this.drawEmptyState();
  }

  private bindDropzone() {
    const preventDefaults = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    ['dragenter', 'dragover'].forEach((eventName) => {
      this.dropzone.addEventListener(eventName, (event) => {
        preventDefaults(event as DragEvent);
        this.dropzone.classList.add('drag-active');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      this.dropzone.addEventListener(eventName, (event) => {
        preventDefaults(event as DragEvent);
        this.dropzone.classList.remove('drag-active');
      });
    });

    this.dropzone.addEventListener('drop', (event) => {
      const dragEvent = event as DragEvent;
      this.handleFileSelection(dragEvent.dataTransfer?.files?.[0] ?? null);
    });
  }

  private get selectedQuality(): AudioFourierPresetId {
    return this.qualitySelect.value as AudioFourierPresetId;
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
      throw new Error('Unable to acquire audio canvas context.');
    }
    return context;
  }

  private buildBackgroundCanvas(sourceCanvas: HTMLCanvasElement): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    context.lineWidth = 1;
    for (let x = 0; x <= canvas.width; x += canvas.width / 12) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, canvas.height);
      context.stroke();
    }
    for (let y = 0; y <= canvas.height; y += canvas.height / 6) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(canvas.width, y);
      context.stroke();
    }
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
    this.playButton.disabled = !hasResult || isProcessing || isPlaying || this.reducedMotion;
    this.pauseButton.disabled = !hasResult || !isPlaying;
    this.resetButton.disabled = isProcessing && !hasResult;
    this.playButton.textContent = resolveAudioPlaybackButtonLabel({
      hasResult,
      isProcessing,
      isPlaying,
      reducedMotion: this.reducedMotion,
      elapsedSeconds: this.playbackElapsedSeconds,
      isComplete: this.state === 'complete'
    });
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

  private invalidateComputedState(statusText: string) {
    this.stopPlayback(false);
    this.abandonActiveComputation();
    this.activeResult = null;
    this.bandBuffers = [];
    this.activeMasterGain = null;
    this.visualMixSamples = new Float32Array(0);
    this.playbackElapsedSeconds = 0;
    this.clearDiagnostics();
    this.componentSlider.disabled = true;
    this.componentSlider.value = String(INITIAL_SLIDER_VALUE);
    this.componentReadout.textContent = 'Generate first';
    this.sampleRateLabel.textContent = '—';
    this.componentCountLabel.textContent = '—';
    this.sourceDurationLabel.textContent = '—';
    this.durationLabel.textContent = '—';
    this.resultMeta.textContent = 'Generate a Fourier transform to begin the reconstruction.';
    const preset = getAudioFourierPreset(this.selectedQuality);
    this.setState('idle', statusText);
    this.setProgress(0, 'Ready for audio.', `${preset.label} · full-song proxy at ${preset.proxySampleRate} Hz`);
    this.drawEmptyState();
  }

  private abandonActiveComputation() {
    if (this.activeWorkerRequestId > 0 && this.worker) {
      const request: AudioFourierWorkerRequest = {
        type: 'cancel-audio-fourier',
        requestId: this.activeWorkerRequestId
      };
      this.worker.postMessage(request);
    }
    this.activeWorkerRequestId = 0;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  private async generate() {
    this.stopPlayback(false);
    this.activeResult = null;
    this.bandBuffers = [];
    this.activeMasterGain = null;
    this.visualMixSamples = new Float32Array(0);
    this.playbackElapsedSeconds = 0;
    this.clearDiagnostics();
    this.drawEmptyState();

    const requestId = ++this.activeRequestId;
    const preset = getAudioFourierPreset(this.selectedQuality);
    this.setState('processing', 'Preparing full-song proxy for Fourier analysis...');
    this.setProgress(0.02, 'Loading audio samples...', `${preset.label} · ${preset.proxySampleRate} Hz proxy`);

    try {
      await this.getAudioContext().resume();
    } catch (_error) {
      // Some browsers still require a second explicit Play click after async analysis.
    }

    try {
      const source = await this.resolveAudioSource();
      if (requestId !== this.activeRequestId) {
        return;
      }

      const worker = this.getWorker();
      const transfer = source.channelBuffers.slice();
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
      const response = await fetch(preset.url);
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
    } catch (_error) {
      throw new Error('Unable to decode this audio file in the browser.');
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
      channelBuffers: channels.map((channel) => asArrayBuffer(new Float32Array(channel).buffer)),
      label,
      sourceKind,
      builtInPresetId
    };
  }

  private getWorker() {
    if (this.worker) {
      return this.worker;
    }

    this.worker = new Worker(new URL('./audioFourier.worker.ts', import.meta.url), {
      type: 'module'
    });
    this.worker.addEventListener('message', (event: MessageEvent<AudioFourierWorkerResponse>) => {
      this.handleWorkerMessage(event.data);
    });
    this.worker.addEventListener('error', (event) => {
      event.preventDefault();
      this.handleWorkerFailure();
    });
    this.worker.addEventListener('messageerror', () => {
      this.handleWorkerFailure();
    });
    return this.worker;
  }

  private handleWorkerFailure() {
    this.activeWorkerRequestId = 0;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.setState('error', 'Audio worker unavailable. Reload the page and try again.');
    this.setProgress(0, 'Worker failure stopped the audio analysis.', 'Full-song Fourier rendering needs the worker thread.');
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
    const energyPercent = mapSliderValueToEnergyPercent(INITIAL_SLIDER_VALUE, 100);
    const bandEnergyFractions = new Float32Array(asArrayBuffer(message.bandEnergyFractions));
    const result: ActiveAudioFourier = {
      metadata: message.metadata,
      originalSamples: new Float32Array(asArrayBuffer(message.originalSamples)),
      bandSamples: new Float32Array(asArrayBuffer(message.bandSamples)),
      bandEndComponentCounts: new Uint32Array(asArrayBuffer(message.bandEndComponentCounts)),
      bandEnergyFractions,
      componentFrequencies: new Float32Array(asArrayBuffer(message.componentFrequencies)),
      componentAmplitudes: new Float32Array(asArrayBuffer(message.componentAmplitudes)),
      componentPhases: new Float32Array(asArrayBuffer(message.componentPhases)),
      bandGains: resolveEnergyBandGains(energyPercent, bandEnergyFractions),
      energyPercent
    };

    this.activeResult = result;
    this.bandBuffers = [];
    this.rebuildVisualMixSamples();
    this.playbackElapsedSeconds = 0;
    this.syncDiagnostics(result, message.requestId);
    this.configureSlider();
    this.sampleRateLabel.textContent = `${result.metadata.proxySampleRate.toFixed(0)} Hz proxy`;
    this.componentCountLabel.textContent = result.metadata.componentCount.toLocaleString();
    this.sourceDurationLabel.textContent = `${formatSeconds(result.metadata.sourceDurationSeconds)} source`;
    this.durationLabel.textContent = `${result.metadata.timingsMs.total.toFixed(0)} ms`;
    this.renderCurrentViewport();
    this.setState('ready', 'Fourier proxy ready. Playing at the auditory midpoint.');
    this.syncEnergyReadout();
    this.resultMeta.textContent = 'The viewport follows playback and shows the original trace against the reconstructed signal.';
    this.setProgress(1, 'Fourier proxy ready.');
    void this.playFromBeginning().catch(() => {
      this.setState('ready', 'Fourier proxy ready. Press Play to start audio.');
    });
  }

  private configureSlider() {
    this.componentSlider.disabled = false;
    this.componentSlider.min = '0';
    this.componentSlider.max = '100';
    this.componentSlider.step = '1';
    this.componentSlider.value = String(INITIAL_SLIDER_VALUE);
    this.componentMinLabel.textContent = 'Sparse';
    this.componentMaxLabel.textContent = 'Full proxy';
  }

  private handleSliderInput() {
    if (!this.activeResult) {
      return;
    }

    this.activeResult.energyPercent = mapSliderValueToEnergyPercent(
      Number(this.componentSlider.value),
      Number(this.componentSlider.max)
    );
    this.activeResult.bandGains = resolveEnergyBandGains(this.activeResult.energyPercent, this.activeResult.bandEnergyFractions);
    this.updateLiveBandGains();
    this.syncEnergyReadout();

    if (!this.sliderRafPending) {
      this.sliderRafPending = true;
      window.requestAnimationFrame(() => {
        this.sliderRafPending = false;
        this.rebuildVisualMixSamples();
        if (this.state === 'animating') {
          this.drawSpectrumFrame();
          this.drawComponentFrame();
          return;
        }
        this.renderCurrentViewport();
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
  }

  private resolveApproximateActiveComponents() {
    if (!this.activeResult) {
      return 0;
    }

    let previousComponentCount = 0;
    for (let bandIndex = 0; bandIndex < this.activeResult.bandGains.length; bandIndex += 1) {
      const gain = this.activeResult.bandGains[bandIndex];
      const endComponentCount = this.activeResult.bandEndComponentCounts[bandIndex];
      if (gain < 1) {
        return Math.round(previousComponentCount + (endComponentCount - previousComponentCount) * gain);
      }
      previousComponentCount = endComponentCount;
    }

    return this.activeResult.metadata.componentCount;
  }

  private rebuildVisualMixSamples() {
    if (!this.activeResult) {
      this.visualMixSamples = new Float32Array(0);
      return;
    }

    if (this.visualMixSamples.length !== this.activeResult.metadata.proxySampleCount) {
      this.visualMixSamples = new Float32Array(this.activeResult.metadata.proxySampleCount);
    }

    mixEnergyBands(
      this.activeResult.bandSamples,
      this.activeResult.metadata.proxySampleCount,
      this.activeResult.bandGains,
      this.visualMixSamples
    );
  }

  private ensureBandBuffers() {
    if (!this.activeResult || this.bandBuffers.length > 0) {
      return;
    }

    const context = this.getAudioContext();
    const sampleCount = this.activeResult.metadata.proxySampleCount;
    for (let bandIndex = 0; bandIndex < this.activeResult.metadata.bandCount; bandIndex += 1) {
      const buffer = context.createBuffer(1, sampleCount, this.activeResult.metadata.proxySampleRate);
      buffer.copyToChannel(
        this.activeResult.bandSamples.subarray(bandIndex * sampleCount, (bandIndex + 1) * sampleCount) as Float32Array<ArrayBuffer>,
        0
      );
      this.bandBuffers.push(buffer);
    }
  }

  private async handlePlaybackButton() {
    if (!this.activeResult) {
      return;
    }

    if (this.playbackElapsedSeconds >= this.activeResult.metadata.proxyDurationSeconds) {
      this.playbackElapsedSeconds = 0;
    }

    await this.playPlayback();
  }

  private async playFromBeginning() {
    this.stopPlayback(true);
    await this.playPlayback();
  }

  private async playPlayback() {
    if (!this.activeResult || this.reducedMotion) {
      this.syncButtons();
      return;
    }

    const context = this.getAudioContext();
    this.setState('animating', 'Playing selected Fourier energy mix...');
    await context.resume();
    this.ensureBandBuffers();

    const offset = clamp(this.playbackElapsedSeconds, 0, this.activeResult.metadata.proxyDurationSeconds);
    const startedAt = context.currentTime + PLAYBACK_START_DELAY_SECONDS;
    const masterGainValue = resolveEnergyMakeupGain(this.activeResult.energyPercent);
    const masterGain = context.createGain();
    masterGain.gain.value = 0;
    masterGain.gain.setValueAtTime(0, startedAt);
    masterGain.gain.linearRampToValueAtTime(masterGainValue, startedAt + PLAYBACK_FADE_SECONDS);
    masterGain.connect(context.destination);
    this.activeMasterGain = masterGain;
    this.activeBandNodes = this.bandBuffers.map((buffer, index) => {
      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = this.activeResult?.bandGains[index] ?? 0;
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(masterGain);
      source.start(startedAt, offset);
      return { source, gain };
    });

    const firstNode = this.activeBandNodes[0];
    if (firstNode) {
      firstNode.source.onended = () => {
        if (this.state !== 'animating') {
          return;
        }
        this.playbackElapsedSeconds = this.activeResult?.metadata.proxyDurationSeconds ?? 0;
        this.activeBandNodes = [];
        this.setState('complete', 'Playback complete.');
        this.resultMeta.textContent = 'Playback finished for the current signal-energy mix.';
        this.stopAnimationFrame();
        this.syncButtons();
      };
    }

    this.playbackStartedAt = startedAt - offset;
    this.lastPlaybackProgressAt = 0;
    this.tickPlayback();
  }

  private pausePlayback() {
    if (!this.activeResult || this.state !== 'animating') {
      return;
    }

    const context = this.getAudioContext();
    this.playbackElapsedSeconds = clamp(context.currentTime - this.playbackStartedAt, 0, this.activeResult.metadata.proxyDurationSeconds);
    this.stopPlayback(false);
    this.renderCurrentViewport();
    this.setState('ready', 'Playback paused.');
  }

  private stopPlayback(resetElapsed: boolean) {
    this.stopAnimationFrame();
    for (const node of this.activeBandNodes) {
      node.source.onended = null;
      try {
        node.source.stop();
      } catch (_error) {
        // Stopping an already-ended one-shot source is harmless.
      }
      node.source.disconnect();
      node.gain.disconnect();
    }
    this.activeBandNodes = [];
    if (this.activeMasterGain) {
      this.activeMasterGain.disconnect();
      this.activeMasterGain = null;
    }
    if (resetElapsed) {
      this.playbackElapsedSeconds = 0;
    }
  }

  private updateLiveBandGains() {
    if (!this.activeResult || this.activeBandNodes.length === 0) {
      return;
    }

    const context = this.getAudioContext();
    for (let index = 0; index < this.activeBandNodes.length; index += 1) {
      this.activeBandNodes[index].gain.gain.setTargetAtTime(this.activeResult.bandGains[index], context.currentTime, 0.015);
    }
    if (this.activeMasterGain) {
      this.activeMasterGain.gain.cancelScheduledValues(context.currentTime);
      this.activeMasterGain.gain.setTargetAtTime(resolveEnergyMakeupGain(this.activeResult.energyPercent), context.currentTime, 0.02);
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
      if (!this.lastLiveRenderAt || timestamp - this.lastLiveRenderAt >= 34) {
        this.lastLiveRenderAt = timestamp;
        this.renderWaveViewport(true);
      }
      if (!this.lastPlaybackProgressAt || timestamp - this.lastPlaybackProgressAt >= PLAYBACK_PROGRESS_UPDATE_MS) {
        this.lastPlaybackProgressAt = timestamp;
        this.progressMeta.textContent = `${formatSeconds(this.playbackElapsedSeconds)} / ${formatSeconds(this.activeResult.metadata.proxyDurationSeconds)}`;
      }
      this.animationFrameId = window.requestAnimationFrame(step);
    };

    this.stopAnimationFrame();
    this.lastLiveRenderAt = 0;
    this.animationFrameId = window.requestAnimationFrame(step);
  }

  private resetAll() {
    this.stopPlayback(true);
    this.abandonActiveComputation();
    this.selection = buildDefaultAudioSelection();
    this.activeResult = null;
    this.bandBuffers = [];
    this.visualMixSamples = new Float32Array(0);
    this.clearDiagnostics();
    this.syncSelection();
    this.invalidateComputedState('Choose an audio file or start from a built-in song preset.');
  }

  private drawEmptyState() {
    this.clearCanvas(this.waveCanvas, this.waveContext);
    this.clearCanvas(this.spectrumCanvas, this.spectrumContext);
    this.clearCanvas(this.componentCanvas, this.componentContext);
    this.drawCenteredLabel(this.waveCanvas, this.waveContext, 'Waveform viewport will draw here');
    this.drawCenteredLabel(this.spectrumCanvas, this.spectrumContext, 'Energy bands will appear here');
    this.drawCenteredLabel(this.componentCanvas, this.componentContext, 'Active signal-energy readout');
  }

  private clearCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
    const background =
      canvas === this.waveCanvas ? this.waveBackgroundCanvas :
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
    context.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    context.lineWidth = 1;
    for (let x = 0; x <= canvas.width; x += canvas.width / 12) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, canvas.height);
      context.stroke();
    }
    for (let y = 0; y <= canvas.height; y += canvas.height / 6) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(canvas.width, y);
      context.stroke();
    }
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

  private resolveVisualPointCount(viewportSampleCount: number, livePlayback: boolean) {
    const minimum = livePlayback ? LIVE_MIN_VISUAL_POINTS : MIN_VISUAL_POINTS;
    const maximum = livePlayback ? LIVE_MAX_VISUAL_POINTS : MAX_VISUAL_POINTS;
    if (viewportSampleCount <= minimum) {
      return viewportSampleCount;
    }

    const canvasBudget = Math.max(minimum, Math.min(maximum, Math.round(this.waveCanvas.width * (livePlayback ? 0.5 : 1.25))));
    return Math.min(viewportSampleCount, canvasBudget);
  }

  private readSampleAt(samples: Float32Array, samplePosition: number) {
    const leftIndex = clamp(Math.floor(samplePosition), 0, samples.length - 1);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const phase = clamp(samplePosition - leftIndex, 0, 1);
    return samples[leftIndex] + (samples[rightIndex] - samples[leftIndex]) * phase;
  }

  private renderWaveViewport(livePlayback = false) {
    if (!this.activeResult) {
      return;
    }

    const result = this.activeResult;
    const viewportSampleCount = Math.max(
      1,
      Math.min(result.metadata.proxySampleCount, Math.round(this.viewportSeconds * result.metadata.proxySampleRate))
    );
    const centerSample = clamp(
      this.playbackElapsedSeconds * result.metadata.proxySampleRate,
      0,
      Math.max(0, result.metadata.proxySampleCount - 1)
    );
    const startSample = clamp(
      centerSample - viewportSampleCount / 2,
      0,
      Math.max(0, result.metadata.proxySampleCount - viewportSampleCount)
    );
    const endSample = startSample + viewportSampleCount;

    const visualPointCount = this.resolveVisualPointCount(viewportSampleCount, livePlayback);

    const samplesPerPoint = Math.max(
      1,
      Math.min(
        livePlayback ? LIVE_ENVELOPE_SAMPLES_PER_POINT : STATIC_ENVELOPE_SAMPLES_PER_POINT,
        Math.ceil(viewportSampleCount / visualPointCount)
      )
    );
    const sampleStep = viewportSampleCount / visualPointCount;

    for (let pointIndex = 0; pointIndex < visualPointCount; pointIndex += 1) {
      const binStart = startSample + pointIndex * sampleStep;
      const binEnd = pointIndex + 1 === visualPointCount ? endSample : binStart + sampleStep;
      let originalMin = Number.POSITIVE_INFINITY;
      let originalMax = Number.NEGATIVE_INFINITY;
      let mixMin = Number.POSITIVE_INFINITY;
      let mixMax = Number.NEGATIVE_INFINITY;

      for (let envelopeIndex = 0; envelopeIndex < samplesPerPoint; envelopeIndex += 1) {
        const phase = (envelopeIndex + 0.5) / samplesPerPoint;
        let samplePosition: number;
        if (livePlayback) {
          samplePosition = clamp(
            Math.floor(binStart + (binEnd - binStart) * phase),
            0,
            result.metadata.proxySampleCount - 1
          );
        } else {
          samplePosition = clamp(binStart + (binEnd - binStart) * phase, 0, result.metadata.proxySampleCount - 1);
        }
        const original = result.originalSamples[samplePosition];
        const mixed = this.visualMixSamples[samplePosition];
        originalMin = Math.min(originalMin, original);
        originalMax = Math.max(originalMax, original);
        mixMin = Math.min(mixMin, mixed);
        mixMax = Math.max(mixMax, mixed);
      }

      this.visualOriginalMinScratch[pointIndex] = Number.isFinite(originalMin) ? originalMin : 0;
      this.visualOriginalMaxScratch[pointIndex] = Number.isFinite(originalMax) ? originalMax : 0;
      this.visualMixMinScratch[pointIndex] = Number.isFinite(mixMin) ? mixMin : 0;
      this.visualMixMaxScratch[pointIndex] = Number.isFinite(mixMax) ? mixMax : 0;
    }

    const makeupGain = resolveEnergyMakeupGain(result.energyPercent);
    for (let offset = 0; offset < visualPointCount; offset += 1) {
      this.visualMixMinScratch[offset] *= makeupGain;
      this.visualMixMaxScratch[offset] *= makeupGain;
    }

    this.drawWaveFrame(
      this.visualOriginalMinScratch,
      this.visualOriginalMaxScratch,
      this.visualMixMinScratch,
      this.visualMixMaxScratch,
      visualPointCount,
      startSample / result.metadata.proxySampleRate,
      endSample / result.metadata.proxySampleRate,
      livePlayback
    );
  }


  private renderCurrentViewport() {
    this.renderWaveViewport();
    this.drawSpectrumFrame();
    this.drawComponentFrame();
  }

  private drawWaveFrame(
    originalMin: Float32Array,
    originalMax: Float32Array,
    reconstructedMin: Float32Array,
    reconstructedMax: Float32Array,
    pointCount: number,
    startSeconds: number,
    endSeconds: number,
    livePlayback = false
  ) {
    this.clearCanvas(this.waveCanvas, this.waveContext);
    this.drawWaveformEnvelope(originalMin, originalMax, pointCount, 'rgba(255, 255, 255, 0.35)', 'rgba(255, 255, 255, 0.45)', 1.5, false);
    this.drawWaveformEnvelope(reconstructedMin, reconstructedMax, pointCount, 'rgba(255, 255, 255, 0.18)', 'rgba(255, 255, 255, 0.92)', 2.5, true);
    this.waveContext.save();
    this.waveContext.fillStyle = 'rgba(255, 255, 255, 0.72)';
    this.waveContext.font = '13px JetBrains Mono, monospace';
    this.waveContext.fillText(`${formatSeconds(startSeconds)} - ${formatSeconds(endSeconds)}`, 18, 28);
    this.waveContext.restore();
  }

  private drawWaveformEnvelope(
    minSamples: Float32Array,
    maxSamples: Float32Array,
    count: number,
    fillColor: string,
    strokeColor: string,
    lineWidth: number,
    glow = true
  ) {
    const context = this.waveContext;
    const canvas = this.waveCanvas;
    const centerY = canvas.height / 2;
    const scaleY = canvas.height * 0.42;
    const lastIndex = Math.max(1, count - 1);

    context.save();
    context.fillStyle = fillColor;
    context.strokeStyle = strokeColor;
    context.lineWidth = lineWidth;
    context.shadowColor = glow ? strokeColor : 'transparent';
    context.shadowBlur = glow && lineWidth > 2 ? 16 : 0;
    context.beginPath();
    for (let index = 0; index < count; index += 1) {
      const x = index / lastIndex * canvas.width;
      const y = centerY - maxSamples[index] * scaleY;
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    for (let index = count - 1; index >= 0; index -= 1) {
      const x = index / lastIndex * canvas.width;
      const y = centerY - minSamples[index] * scaleY;
      context.lineTo(x, y);
    }
    context.closePath();
    context.fill();

    context.beginPath();
    for (let index = 0; index < count; index += 1) {
      const x = index / lastIndex * canvas.width;
      const midpoint = (minSamples[index] + maxSamples[index]) / 2;
      const y = centerY - midpoint * scaleY;
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
    context.restore();
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
      const height = Math.max(2, this.activeResult.bandEnergyFractions[index] * (canvas.height - 36));
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
    for (let x = 0; x < canvas.width; x += 1) {
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
}
