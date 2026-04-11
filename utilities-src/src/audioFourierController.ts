import {
  buildGeneratedAudioPreset,
  GENERATED_AUDIO_PRESETS,
  getAudioFourierPreset,
  type AudioFourierPresetId,
  type GeneratedAudioPresetId
} from './audioPresets';
import { buildAudioFourierReconstruction } from './audioFourierCore';
import { prepareAudioSignal } from './audioSignal';
import { resolveAudioPlaybackButtonLabel } from './audioFourierUiState';
import type {
  AudioFourierSourceTransfer,
  AudioFourierSuccessMessage,
  AudioFourierWorkerRequest,
  AudioFourierWorkerResponse
} from './audioFourierWorkerTypes';

type AudioFourierState = 'idle' | 'processing' | 'ready' | 'animating' | 'complete' | 'error';

interface AudioFourierSelection {
  kind: 'preset' | 'file';
  label: string;
  presetId?: GeneratedAudioPresetId;
  file?: File;
}

interface ActiveAudioFourier {
  metadata: AudioFourierSuccessMessage['metadata'];
  visualFrames: Float32Array;
  finalFrame: Float32Array;
  playbackSamples: Float32Array;
  frameComponentCounts: Uint32Array;
  componentFrequencies: Float32Array;
  componentAmplitudes: Float32Array;
  componentPhases: Float32Array;
  componentEnergies: Float32Array;
}

function asArrayBuffer(buffer: ArrayBufferLike) {
  return buffer as ArrayBuffer;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatSeconds(value: number) {
  return `${value.toFixed(value >= 10 ? 1 : 2)}s`;
}

function formatFrequency(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${value.toFixed(1)} Hz`;
}

export class AudioFourierController {
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly qualitySelect: HTMLSelectElement;
  private readonly generateButton: HTMLButtonElement;
  private readonly playButton: HTMLButtonElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
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
  private readonly segmentLabel: HTMLElement;
  private readonly durationLabel: HTMLElement;
  private readonly waveCanvas: HTMLCanvasElement;
  private readonly spectrumCanvas: HTMLCanvasElement;
  private readonly componentCanvas: HTMLCanvasElement;
  private readonly waveContext: CanvasRenderingContext2D;
  private readonly spectrumContext: CanvasRenderingContext2D;
  private readonly componentContext: CanvasRenderingContext2D;
  private readonly dropzone: HTMLElement;
  private readonly presetButtons: HTMLButtonElement[];

  private selection: AudioFourierSelection = {
    kind: 'preset',
    label: GENERATED_AUDIO_PRESETS['harmonic-chord'].label,
    presetId: 'harmonic-chord'
  };
  private worker: Worker | null = null;
  private activeRequestId = 0;
  private activeWorkerRequestId = 0;
  private activeResult: ActiveAudioFourier | null = null;
  private audioContext: AudioContext | null = null;
  private activeAudioBuffer: AudioBuffer | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private playbackStartedAt = 0;
  private playbackElapsedSeconds = 0;
  private animationFrameId = 0;
  private state: AudioFourierState = 'idle';
  private workerUnavailable = false;
  private workerFallbackScheduled = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.input = this.requireElement('audioFourierInput');
    this.qualitySelect = this.requireElement('audioFourierQuality');
    this.generateButton = this.requireElement('audioFourierGenerateBtn');
    this.playButton = this.requireElement('audioFourierPlayBtn');
    this.pauseButton = this.requireElement('audioFourierPauseBtn');
    this.resetButton = this.requireElement('audioFourierResetBtn');
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
    this.segmentLabel = this.requireElement('audioFourierSegment');
    this.durationLabel = this.requireElement('audioFourierDuration');
    this.waveCanvas = this.requireElement('audioFourierWaveCanvas');
    this.spectrumCanvas = this.requireElement('audioFourierSpectrumCanvas');
    this.componentCanvas = this.requireElement('audioFourierComponentCanvas');
    this.dropzone = this.requireElement('audioFourierDropzone');
    this.presetButtons = Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-audio-preset]'));
    this.waveContext = this.getContext(this.waveCanvas);
    this.spectrumContext = this.getContext(this.spectrumCanvas);
    this.componentContext = this.getContext(this.componentCanvas);
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
    this.bindDropzone();

    this.presetButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const presetId = button.dataset.audioPreset as GeneratedAudioPresetId | undefined;
        if (!presetId || !(presetId in GENERATED_AUDIO_PRESETS)) {
          return;
        }
        this.applyGeneratedPreset(presetId);
      });
    });

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
    this.invalidateComputedState('Audio file selected. Generate to analyze the strongest segment.');
  }

  private applyGeneratedPreset(presetId: GeneratedAudioPresetId) {
    const preset = GENERATED_AUDIO_PRESETS[presetId];
    this.selection = {
      kind: 'preset',
      label: preset.label,
      presetId
    };
    this.syncSelection();
    this.invalidateComputedState('Generated preset selected. Generate to hear the Fourier reconstruction.');
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
    this.playButton.disabled = !hasResult || isProcessing || isPlaying || this.reducedMotion;
    this.pauseButton.disabled = !hasResult || !isPlaying;
    this.resetButton.disabled = isProcessing && !hasResult;
    this.playButton.textContent = resolveAudioPlaybackButtonLabel({
      hasResult,
      isProcessing,
      isPlaying,
      reducedMotion: this.reducedMotion,
      elapsedSeconds: this.playbackElapsedSeconds
    });
  }

  private setState(state: AudioFourierState, text: string) {
    this.state = state;
    this.statusText.textContent = text;
    this.statusChip.textContent = state === 'animating' ? 'Playing' : state === 'ready' ? 'Ready' : state[0].toUpperCase() + state.slice(1);
    this.statusChip.className = `utility-status-chip utility-status-chip--${state}`;
    this.root.dataset.audioState = state;
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
    delete this.root.dataset.audioFftMs;
    delete this.root.dataset.audioReconstructionMs;
    delete this.root.dataset.audioComponentCount;
    delete this.root.dataset.audioSampleRate;
  }

  private syncDiagnostics(result: ActiveAudioFourier, requestId: number) {
    this.root.dataset.audioLastRequestId = String(requestId);
    this.root.dataset.audioTotalMs = result.metadata.timingsMs.total.toFixed(2);
    this.root.dataset.audioFftMs = result.metadata.timingsMs.fft.toFixed(2);
    this.root.dataset.audioReconstructionMs = result.metadata.timingsMs.reconstruction.toFixed(2);
    this.root.dataset.audioComponentCount = String(result.metadata.componentCount);
    this.root.dataset.audioSampleRate = result.metadata.sampleRate.toFixed(2);
  }

  private invalidateComputedState(statusText: string) {
    this.stopPlayback(false);
    this.abandonActiveComputation();
    this.activeResult = null;
    this.activeAudioBuffer = null;
    this.playbackElapsedSeconds = 0;
    this.clearDiagnostics();
    this.sampleRateLabel.textContent = '—';
    this.componentCountLabel.textContent = '—';
    this.segmentLabel.textContent = '—';
    this.durationLabel.textContent = '—';
    this.resultMeta.textContent = 'Generate a Fourier transform to begin the reconstruction.';
    const preset = getAudioFourierPreset(this.selectedQuality);
    this.setState('idle', statusText);
    this.setProgress(0, 'Ready for audio.', `${preset.label} · ${preset.targetDurationSeconds}s target excerpt`);
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

  private async generate(options?: { forceMainThread?: boolean; retryMessage?: string }) {
    this.stopPlayback(false);
    this.activeResult = null;
    this.activeAudioBuffer = null;
    this.playbackElapsedSeconds = 0;
    this.clearDiagnostics();
    this.drawEmptyState();

    const requestId = ++this.activeRequestId;
    const preset = getAudioFourierPreset(this.selectedQuality);
    this.setState('processing', 'Preparing audio for Fourier analysis...');
    this.setProgress(0.02, options?.retryMessage ?? 'Loading audio samples...', `${preset.label} · exact additive reconstruction`);

    try {
      const source = await this.resolveAudioSource();
      if (requestId !== this.activeRequestId) {
        return;
      }

      if (options?.forceMainThread || this.workerUnavailable || typeof Worker === 'undefined') {
        await this.runOnMainThread(requestId, source);
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
      this.setProgress(0, 'Audio preparation failed.', 'Try a browser-supported audio file or a generated preset.');
    }
  }

  private async resolveAudioSource(): Promise<AudioFourierSourceTransfer> {
    if (this.selection.kind === 'preset' && this.selection.presetId) {
      const generated = buildGeneratedAudioPreset(this.selection.presetId);
      return {
        sampleRate: generated.sampleRate,
        channelBuffers: generated.channels.map((channel) => asArrayBuffer(channel.buffer)),
        label: this.selection.label,
        sourceKind: 'preset',
        generatedPresetId: this.selection.presetId
      };
    }

    if (!this.selection.file) {
      throw new Error('Choose an audio file or a generated preset first.');
    }

    if (!this.selection.file.type.startsWith('audio/')) {
      throw new Error('Selected file is not a browser-supported audio file.');
    }

    const context = this.getAudioContext();
    const arrayBuffer = await this.selection.file.arrayBuffer();
    let decoded: AudioBuffer;
    try {
      decoded = await context.decodeAudioData(arrayBuffer.slice(0));
    } catch (_error) {
      throw new Error('Unable to decode this audio file in the browser.');
    }

    const channelBuffers: ArrayBuffer[] = [];
    for (let channelIndex = 0; channelIndex < decoded.numberOfChannels; channelIndex += 1) {
      channelBuffers.push(asArrayBuffer(new Float32Array(decoded.getChannelData(channelIndex)).buffer));
    }

    return {
      sampleRate: decoded.sampleRate,
      channelBuffers,
      label: this.selection.file.name,
      sourceKind: 'file'
    };
  }

  private async runOnMainThread(requestId: number, source: AudioFourierSourceTransfer) {
    const preset = getAudioFourierPreset(this.selectedQuality);
    if (preset.id !== 'fast') {
      throw new Error('Audio worker unavailable. Try the Fast preset or reload the page.');
    }

    const startedAt = performance.now();
    try {
      const channels = source.channelBuffers.map((buffer) => new Float32Array(buffer));
      const segmentStartedAt = performance.now();
      const prepared = prepareAudioSignal(
        {
          sampleRate: source.sampleRate,
          channels
        },
        preset
      );
      const segmentMs = performance.now() - segmentStartedAt;
      const reconstructionStartedAt = performance.now();
      let fftMs = 0;
      const reconstruction = buildAudioFourierReconstruction(
        prepared.samples,
        prepared.sampleRate,
        preset,
        (progress, message) => {
          if (fftMs === 0 && progress >= 0.18) {
            fftMs = performance.now() - reconstructionStartedAt;
          }
          this.handleWorkerMessage({
            type: 'audio-fourier-progress',
            requestId,
            progress,
            message
          });
        }
      );
      const reconstructionMs = performance.now() - reconstructionStartedAt;
      const finalFrame = reconstruction.visualFrames.slice(
        (preset.visualFrameCount - 1) * preset.displaySampleCount,
        preset.visualFrameCount * preset.displaySampleCount
      );

      this.handleWorkerMessage({
        type: 'audio-fourier-success',
        requestId,
        metadata: {
          presetId: preset.id,
          label: source.label,
          sourceKind: source.sourceKind,
          sourceDurationSeconds: prepared.sourceDurationSeconds,
          segmentStartSeconds: prepared.segment.startSample / source.sampleRate,
          segmentDurationSeconds: prepared.segment.durationSeconds,
          sampleRate: prepared.sampleRate,
          sampleCount: prepared.samples.length,
          componentCount: reconstruction.analysis.components.length,
          displaySampleCount: preset.displaySampleCount,
          visualFrameCount: preset.visualFrameCount,
          playbackDurationSeconds: reconstruction.playbackSamples.length / prepared.sampleRate,
          timingsMs: {
            segment: segmentMs,
            fft: fftMs,
            reconstruction: reconstructionMs,
            total: performance.now() - startedAt
          }
        },
        visualFrames: asArrayBuffer(reconstruction.visualFrames.buffer),
        finalFrame: asArrayBuffer(finalFrame.buffer),
        playbackSamples: asArrayBuffer(reconstruction.playbackSamples.buffer),
        frameComponentCounts: asArrayBuffer(reconstruction.frameComponentCounts.buffer),
        componentFrequencies: asArrayBuffer(reconstruction.componentFrequencies.buffer),
        componentAmplitudes: asArrayBuffer(reconstruction.componentAmplitudes.buffer),
        componentPhases: asArrayBuffer(reconstruction.componentPhases.buffer),
        componentEnergies: asArrayBuffer(reconstruction.componentEnergies.buffer)
      });
    } catch (error) {
      this.handleWorkerMessage({
        type: 'audio-fourier-error',
        requestId,
        message: error instanceof Error ? error.message : 'Unable to analyze this audio signal.'
      });
    }
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
      this.handleWorkerFailure('Audio worker unavailable. Retrying the Fast preset on the main thread...');
    });
    this.worker.addEventListener('messageerror', () => {
      this.handleWorkerFailure('Audio worker communication failed. Retrying the Fast preset on the main thread...');
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

    if (this.workerFallbackScheduled || this.state !== 'processing') {
      return;
    }

    if (this.selectedQuality !== 'fast') {
      this.setState('error', 'Audio worker unavailable. Switch to Fast and generate again.');
      this.setProgress(0, 'Worker fallback is limited to the Fast preset.', 'Detailed audio analysis needs the worker thread.');
      return;
    }

    this.workerFallbackScheduled = true;
    void this.generate({
      forceMainThread: true,
      retryMessage: message
    }).finally(() => {
      this.workerFallbackScheduled = false;
    });
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
      this.setProgress(0, message.message, 'Try a generated preset, a shorter file, or the Fast quality preset.');
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
    const result: ActiveAudioFourier = {
      metadata: message.metadata,
      visualFrames: new Float32Array(asArrayBuffer(message.visualFrames)),
      finalFrame: new Float32Array(asArrayBuffer(message.finalFrame)),
      playbackSamples: new Float32Array(asArrayBuffer(message.playbackSamples)),
      frameComponentCounts: new Uint32Array(asArrayBuffer(message.frameComponentCounts)),
      componentFrequencies: new Float32Array(asArrayBuffer(message.componentFrequencies)),
      componentAmplitudes: new Float32Array(asArrayBuffer(message.componentAmplitudes)),
      componentPhases: new Float32Array(asArrayBuffer(message.componentPhases)),
      componentEnergies: new Float32Array(asArrayBuffer(message.componentEnergies))
    };

    this.activeResult = result;
    this.activeAudioBuffer = null;
    this.playbackElapsedSeconds = 0;
    this.syncDiagnostics(result, message.requestId);
    this.sampleRateLabel.textContent = `${result.metadata.sampleRate.toFixed(0)} Hz`;
    this.componentCountLabel.textContent = result.metadata.componentCount.toLocaleString();
    this.segmentLabel.textContent = `${formatSeconds(result.metadata.segmentStartSeconds)} → ${formatSeconds(
      result.metadata.segmentStartSeconds + result.metadata.segmentDurationSeconds
    )}`;
    this.durationLabel.textContent = `${result.metadata.timingsMs.total.toFixed(0)} ms`;
    this.renderFrame(0);

    if (this.reducedMotion) {
      this.renderFrame(result.metadata.visualFrameCount - 1);
      this.setState('complete', 'Fourier reconstruction ready. Reduced motion is enabled, so the final signal is shown.');
      this.setProgress(
        1,
        'Audio transform complete.',
        `${result.metadata.componentCount.toLocaleString()} components · ${formatSeconds(result.metadata.playbackDurationSeconds)} excerpt`
      );
      this.resultMeta.textContent = 'Final reconstructed waveform rendered for reduced motion.';
      return;
    }

    this.setState('ready', 'Fourier reconstruction ready. Press play to hear components assemble.');
    this.setProgress(
      0,
      'Ready to play exact additive reconstruction.',
      `${result.metadata.componentCount.toLocaleString()} components · ${formatSeconds(result.metadata.playbackDurationSeconds)} excerpt`
    );
    this.resultMeta.textContent = 'The strongest frequency components will join one by one until the original excerpt returns.';
    void this.playFromBeginning().catch(() => {
      this.setState('ready', 'Fourier reconstruction ready. Press play to start audio.');
    });
  }

  private buildAudioBuffer() {
    if (!this.activeResult) {
      return null;
    }
    if (this.activeAudioBuffer) {
      return this.activeAudioBuffer;
    }

    const context = this.getAudioContext();
    const buffer = context.createBuffer(1, this.activeResult.playbackSamples.length, this.activeResult.metadata.sampleRate);
    buffer.copyToChannel(this.activeResult.playbackSamples as Float32Array<ArrayBuffer>, 0);
    this.activeAudioBuffer = buffer;
    return buffer;
  }

  private async handlePlaybackButton() {
    if (!this.activeResult) {
      return;
    }

    if (this.playbackElapsedSeconds > 0) {
      await this.playFromBeginning();
      return;
    }

    await this.playPlayback();
  }

  private async playFromBeginning() {
    this.stopPlayback(false);
    this.playbackElapsedSeconds = 0;
    this.renderFrame(0);
    await this.playPlayback();
  }

  private async playPlayback() {
    if (!this.activeResult || this.reducedMotion) {
      this.syncButtons();
      return;
    }

    const context = this.getAudioContext();
    await context.resume();
    const buffer = this.buildAudioBuffer();
    if (!buffer) {
      return;
    }

    const offset = this.playbackElapsedSeconds >= buffer.duration ? 0 : this.playbackElapsedSeconds;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (this.state !== 'animating') {
        return;
      }
      this.playbackElapsedSeconds = buffer.duration;
      this.activeSource = null;
      this.renderFrame(this.activeResult ? this.activeResult.metadata.visualFrameCount - 1 : 0);
      this.setState('complete', 'Audio reconstruction complete.');
      this.setProgress(1, 'Every selected Fourier component is now in the signal.');
      this.resultMeta.textContent = 'The additive reconstruction has reached the normalized original excerpt.';
      this.stopAnimationFrame();
      this.syncButtons();
    };

    this.activeSource = source;
    this.playbackStartedAt = context.currentTime - offset;
    source.start(0, offset);
    this.setState('animating', 'Playing additive Fourier reconstruction...');
    this.resultMeta.textContent = 'Frequency components are entering the audio stream in energy order.';
    this.tickPlayback();
  }

  private pausePlayback() {
    if (!this.activeResult || this.state !== 'animating') {
      return;
    }

    const context = this.getAudioContext();
    this.playbackElapsedSeconds = clamp(context.currentTime - this.playbackStartedAt, 0, this.activeResult.metadata.playbackDurationSeconds);
    this.stopPlayback(false);
    this.setState('ready', 'Playback paused. Press replay to hear it from the beginning.');
    this.resultMeta.textContent = 'Paused reconstruction. Replay starts the frequency build from zero.';
  }

  private stopPlayback(resetElapsed: boolean) {
    this.stopAnimationFrame();
    if (this.activeSource) {
      this.activeSource.onended = null;
      try {
        this.activeSource.stop();
      } catch (_error) {
        // Stopping an already-ended one-shot source is harmless.
      }
      this.activeSource.disconnect();
      this.activeSource = null;
    }
    if (resetElapsed) {
      this.playbackElapsedSeconds = 0;
    }
  }

  private stopAnimationFrame() {
    if (this.animationFrameId) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
  }

  private tickPlayback() {
    const step = () => {
      if (!this.activeResult || this.state !== 'animating') {
        return;
      }

      const context = this.getAudioContext();
      const elapsed = clamp(context.currentTime - this.playbackStartedAt, 0, this.activeResult.metadata.playbackDurationSeconds);
      this.playbackElapsedSeconds = elapsed;
      const phase = elapsed / this.activeResult.metadata.playbackDurationSeconds;
      const frameIndex = clamp(
        Math.floor(phase * (this.activeResult.metadata.visualFrameCount - 1)),
        0,
        this.activeResult.metadata.visualFrameCount - 1
      );
      this.renderFrame(frameIndex);
      this.setProgress(
        phase,
        `Adding Fourier components... ${Math.round(phase * 100)}%`,
        `${this.activeResult.frameComponentCounts[frameIndex].toLocaleString()} / ${this.activeResult.metadata.componentCount.toLocaleString()} components`
      );
      this.animationFrameId = window.requestAnimationFrame(step);
    };

    this.stopAnimationFrame();
    this.animationFrameId = window.requestAnimationFrame(step);
  }

  private resetAll() {
    this.stopPlayback(true);
    this.abandonActiveComputation();
    this.selection = {
      kind: 'preset',
      label: GENERATED_AUDIO_PRESETS['harmonic-chord'].label,
      presetId: 'harmonic-chord'
    };
    this.activeResult = null;
    this.activeAudioBuffer = null;
    this.clearDiagnostics();
    this.syncSelection();
    this.invalidateComputedState('Choose an audio file or start from a generated preset.');
  }

  private drawEmptyState() {
    this.clearCanvas(this.waveCanvas, this.waveContext);
    this.clearCanvas(this.spectrumCanvas, this.spectrumContext);
    this.clearCanvas(this.componentCanvas, this.componentContext);
    this.drawCenteredLabel(this.waveCanvas, this.waveContext, 'Waveform will draw here');
    this.drawCenteredLabel(this.spectrumCanvas, this.spectrumContext, 'Spectrum will appear here');
    this.drawCenteredLabel(this.componentCanvas, this.componentContext, 'Active component readout');
  }

  private clearCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, 'rgba(7, 16, 19, 0.96)');
    gradient.addColorStop(1, 'rgba(18, 11, 22, 0.98)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = 'rgba(128, 232, 214, 0.12)';
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

  private renderFrame(frameIndex: number) {
    if (!this.activeResult) {
      return;
    }

    const resolvedFrame = clamp(Math.round(frameIndex), 0, this.activeResult.metadata.visualFrameCount - 1);
    const offset = resolvedFrame * this.activeResult.metadata.displaySampleCount;
    const current = this.activeResult.visualFrames.subarray(offset, offset + this.activeResult.metadata.displaySampleCount);
    this.drawWaveFrame(current, this.activeResult.finalFrame);
    this.drawSpectrumFrame(resolvedFrame);
    this.drawComponentFrame(resolvedFrame);
  }

  private drawWaveFrame(current: Float32Array, finalFrame: Float32Array) {
    const context = this.waveContext;
    const canvas = this.waveCanvas;
    this.clearCanvas(canvas, context);
    this.drawWaveform(finalFrame, 'rgba(255, 206, 115, 0.35)', 2);
    this.drawWaveform(current, 'rgba(99, 241, 218, 0.95)', 3);
  }

  private drawWaveform(samples: Float32Array, color: string, lineWidth: number) {
    const context = this.waveContext;
    const canvas = this.waveCanvas;
    const centerY = canvas.height / 2;
    const scaleY = canvas.height * 0.42;

    context.save();
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.shadowColor = color;
    context.shadowBlur = lineWidth > 2 ? 16 : 0;
    context.beginPath();
    for (let index = 0; index < samples.length; index += 1) {
      const x = index / Math.max(1, samples.length - 1) * canvas.width;
      const y = centerY - samples[index] * scaleY;
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
    context.restore();
  }

  private drawSpectrumFrame(frameIndex: number) {
    if (!this.activeResult) {
      return;
    }

    const context = this.spectrumContext;
    const canvas = this.spectrumCanvas;
    this.clearCanvas(canvas, context);
    const barCount = Math.min(180, this.activeResult.componentAmplitudes.length);
    const activeCount = this.activeResult.frameComponentCounts[frameIndex];
    let maxAmplitude = 0;
    for (let index = 0; index < barCount; index += 1) {
      maxAmplitude = Math.max(maxAmplitude, this.activeResult.componentAmplitudes[index]);
    }
    const gap = 2;
    const barWidth = Math.max(2, (canvas.width - gap * (barCount - 1)) / barCount);

    for (let index = 0; index < barCount; index += 1) {
      const amplitude = this.activeResult.componentAmplitudes[index] / Math.max(0.0001, maxAmplitude);
      const height = Math.max(2, amplitude * (canvas.height - 34));
      const x = index * (barWidth + gap);
      const y = canvas.height - height - 18;
      context.fillStyle = index < activeCount ? 'rgba(245, 218, 113, 0.92)' : 'rgba(111, 133, 145, 0.26)';
      context.fillRect(x, y, barWidth, height);
    }
  }

  private drawComponentFrame(frameIndex: number) {
    if (!this.activeResult) {
      return;
    }

    const context = this.componentContext;
    const canvas = this.componentCanvas;
    this.clearCanvas(canvas, context);
    const activeCount = this.activeResult.frameComponentCounts[frameIndex];
    const componentIndex = clamp(activeCount - 1, 0, this.activeResult.componentFrequencies.length - 1);
    const frequency = this.activeResult.componentFrequencies[componentIndex];
    const amplitude = this.activeResult.componentAmplitudes[componentIndex];
    const phase = this.activeResult.componentPhases[componentIndex];
    const cycles = clamp(frequency / Math.max(1, this.activeResult.metadata.sampleRate) * 48, 1, 18);

    context.save();
    context.strokeStyle = 'rgba(255, 114, 167, 0.95)';
    context.lineWidth = 3;
    context.shadowColor = 'rgba(255, 114, 167, 0.7)';
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
    context.fillStyle = 'rgba(238, 246, 241, 0.92)';
    context.font = '18px Inter, sans-serif';
    context.fillText(`Component ${activeCount.toLocaleString()}`, 22, 34);
    context.font = '14px JetBrains Mono, monospace';
    context.fillStyle = 'rgba(238, 246, 241, 0.72)';
    context.fillText(`${formatFrequency(frequency)} · amp ${amplitude.toFixed(4)} · phase ${phase.toFixed(2)}`, 22, 58);
    context.restore();
  }
}
