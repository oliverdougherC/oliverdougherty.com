import { clamp } from './math';

export interface AudioWaveEnvelopeData {
  originalAmplitudes: Float32Array;
  reconstructedAmplitudes: Float32Array;
  bucketCount: number;
  bucketSampleCount: number;
  revision: number;
}

export interface AudioWaveRenderFrame {
  firstBucketIndex: number;
  pointCount: number;
  startSample: number;
  viewportSampleCount: number;
  isFullEnergy: boolean;
  playheadX: number | null;
  livePlayback: boolean;
}

export interface AudioWaveRenderer {
  readonly kind: 'webgl' | 'canvas2d';
  resize(): boolean;
  setEnvelopeData(data: AudioWaveEnvelopeData | null): void;
  renderFrame(frame: AudioWaveRenderFrame): void;
  drawEmptyState(label: string): void;
  clear(): void;
  dispose(): void;
}

const WEBGL_MAX_WAVE_BACKING_PIXELS = 4_000_000;
const CANVAS_MAX_WAVE_BACKING_PIXELS = 750_000;
const MAX_WAVE_DPR = 2;
const WEBGL_MIN_WAVE_SCALE = 1;
const CANVAS_MIN_WAVE_SCALE = 0.3;
const WAVE_Y_SCALE = 0.84;

export function resolveAudioWaveCanvasScale(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio = window.devicePixelRatio || 1,
  maxBackingPixels = WEBGL_MAX_WAVE_BACKING_PIXELS,
  minScale = WEBGL_MIN_WAVE_SCALE
) {
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  const baseScale = Math.max(1, Math.min(MAX_WAVE_DPR, devicePixelRatio || 1));
  const areaScale = Math.sqrt(maxBackingPixels / Math.max(1, width * height));
  return Math.max(minScale, Math.min(baseScale, areaScale));
}

function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement, maxBackingPixels: number, minScale: number) {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = rect.width || canvas.clientWidth || canvas.width;
  const cssHeight = rect.height || canvas.clientHeight || canvas.height;
  const scale = resolveAudioWaveCanvasScale(cssWidth, cssHeight, window.devicePixelRatio || 1, maxBackingPixels, minScale);
  const width = Math.max(1, Math.round(cssWidth * scale));
  const height = Math.max(1, Math.round(cssHeight * scale));
  if (canvas.width === width && canvas.height === height) {
    return false;
  }
  canvas.width = width;
  canvas.height = height;
  return true;
}

class Canvas2dAudioWaveRenderer implements AudioWaveRenderer {
  readonly kind = 'canvas2d' as const;
  private readonly context: CanvasRenderingContext2D;
  private data: AudioWaveEnvelopeData | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to acquire audio waveform canvas context.');
    }
    this.context = context;
  }

  resize() {
    return resizeCanvasToDisplaySize(this.canvas, CANVAS_MAX_WAVE_BACKING_PIXELS, CANVAS_MIN_WAVE_SCALE);
  }

  setEnvelopeData(data: AudioWaveEnvelopeData | null) {
    this.data = data;
  }

  renderFrame(frame: AudioWaveRenderFrame) {
    if (!this.data) {
      this.clear();
      return;
    }

    const pointCount = Math.max(0, Math.min(frame.pointCount, this.data.bucketCount - frame.firstBucketIndex));
    this.clear();
    if (pointCount <= 0) {
      return;
    }

    if (!frame.isFullEnergy) {
      this.drawEnvelope(
        this.data.originalAmplitudes,
        pointCount,
        frame,
        'rgba(255, 255, 255, 0.35)',
        'rgba(255, 255, 255, 0.45)',
        1.5,
        false
      );
    }
    this.drawEnvelope(
      this.data.reconstructedAmplitudes,
      pointCount,
      frame,
      'rgba(255, 255, 255, 0.18)',
      'rgba(255, 255, 255, 0.92)',
      frame.livePlayback ? 1.5 : 2.5,
      !frame.livePlayback
    );
    if (frame.playheadX !== null) {
      this.drawPlayhead(frame.playheadX, frame.livePlayback);
    }
  }

  drawEmptyState(label: string) {
    this.clear();
    this.context.save();
    this.context.fillStyle = 'rgba(235, 244, 239, 0.55)';
    this.context.font = '16px Inter, sans-serif';
    this.context.textAlign = 'center';
    this.context.textBaseline = 'middle';
    this.context.fillText(label, this.canvas.width / 2, this.canvas.height / 2);
    this.context.restore();
  }

  clear() {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.fillStyle = '#000000';
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose() {
    this.data = null;
  }

  private drawEnvelope(
    amplitudes: Float32Array,
    pointCount: number,
    frame: AudioWaveRenderFrame,
    fillColor: string,
    strokeColor: string,
    lineWidth: number,
    glow: boolean
  ) {
    const centerY = this.canvas.height / 2;
    const scaleY = this.canvas.height * 0.42;
    const { firstBucketIndex, startSample, viewportSampleCount } = frame;
    const bucketSampleCount = this.data?.bucketSampleCount ?? 1;
    const stride = frame.livePlayback ? Math.max(1, Math.ceil(pointCount / 180)) : 1;
    const lastPointIndex = pointCount - 1;

    this.context.save();
    this.context.fillStyle = fillColor;
    this.context.strokeStyle = strokeColor;
    this.context.lineWidth = lineWidth;
    this.context.lineCap = 'round';
    this.context.lineJoin = 'round';
    this.context.shadowColor = glow ? strokeColor : 'transparent';
    this.context.shadowBlur = glow && lineWidth > 2 ? 16 : 0;
    this.context.beginPath();
    for (let index = 0; index < pointCount; index += stride) {
      const bucketIndex = firstBucketIndex + index;
      const x = this.resolveBucketX(bucketIndex, startSample, viewportSampleCount, bucketSampleCount);
      const y = centerY - amplitudes[bucketIndex] * scaleY;
      if (index === 0) {
        this.context.moveTo(x, y);
      } else {
        this.context.lineTo(x, y);
      }
    }
    if (lastPointIndex % stride !== 0) {
      const bucketIndex = firstBucketIndex + lastPointIndex;
      const x = this.resolveBucketX(bucketIndex, startSample, viewportSampleCount, bucketSampleCount);
      const y = centerY - amplitudes[bucketIndex] * scaleY;
      this.context.lineTo(x, y);
    }
    for (let index = lastPointIndex; index >= 0; index -= stride) {
      const bucketIndex = firstBucketIndex + index;
      const x = this.resolveBucketX(bucketIndex, startSample, viewportSampleCount, bucketSampleCount);
      const y = centerY + amplitudes[bucketIndex] * scaleY;
      this.context.lineTo(x, y);
    }
    this.context.closePath();
    this.context.fill();

    for (const side of [-1, 1]) {
      this.context.beginPath();
      for (let index = 0; index < pointCount; index += stride) {
        const bucketIndex = firstBucketIndex + index;
        const x = this.resolveBucketX(bucketIndex, startSample, viewportSampleCount, bucketSampleCount);
        const y = centerY + side * amplitudes[bucketIndex] * scaleY;
        if (index === 0) {
          this.context.moveTo(x, y);
        } else {
          this.context.lineTo(x, y);
        }
      }
      if (lastPointIndex % stride !== 0) {
        const bucketIndex = firstBucketIndex + lastPointIndex;
        const x = this.resolveBucketX(bucketIndex, startSample, viewportSampleCount, bucketSampleCount);
        const y = centerY + side * amplitudes[bucketIndex] * scaleY;
        this.context.lineTo(x, y);
      }
      this.context.stroke();
    }
    this.context.restore();
  }

  private drawPlayhead(x: number, livePlayback: boolean) {
    const clampedX = clamp(x, 0, this.canvas.width);
    this.context.save();
    this.context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    this.context.lineWidth = livePlayback ? 1.5 : 2;
    this.context.shadowColor = livePlayback ? 'transparent' : 'rgba(255, 255, 255, 0.6)';
    this.context.shadowBlur = livePlayback ? 0 : 8;
    this.context.beginPath();
    this.context.moveTo(clampedX, 0);
    this.context.lineTo(clampedX, this.canvas.height);
    this.context.stroke();
    this.context.restore();
  }

  private resolveBucketX(bucketIndex: number, startSample: number, viewportSampleCount: number, bucketSampleCount: number) {
    const bucketStartSample = bucketIndex * bucketSampleCount;
    return (bucketStartSample - startSample) / viewportSampleCount * this.canvas.width;
  }
}

class WebGlAudioWaveRenderer implements AudioWaveRenderer {
  readonly kind = 'webgl' as const;
  private readonly gl: WebGLRenderingContext;
  private readonly envelopeProgram: WebGLProgram;
  private readonly solidProgram: WebGLProgram;
  private readonly textureProgram: WebGLProgram;
  private readonly originalBuffer: WebGLBuffer;
  private readonly reconstructedBuffer: WebGLBuffer;
  private readonly playheadBuffer: WebGLBuffer;
  private readonly textureBuffer: WebGLBuffer;
  private data: AudioWaveEnvelopeData | null = null;
  private uploadedRevision = -1;
  private contextLost = false;
  private readonly cleanupCallbacks: Array<() => void> = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = (
      canvas.getContext('webgl2', {
        alpha: false,
        antialias: true,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false
      }) ??
      canvas.getContext('webgl', {
        alpha: false,
        antialias: true,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false
      }) ??
      canvas.getContext('experimental-webgl', {
        alpha: false,
        antialias: true,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false
      })
    ) as WebGLRenderingContext | null;
    if (!gl) {
      throw new Error('WebGL waveform renderer unavailable.');
    }

    this.gl = gl;
    this.envelopeProgram = this.createProgram(ENVELOPE_VERTEX_SHADER, ENVELOPE_FRAGMENT_SHADER);
    this.solidProgram = this.createProgram(SOLID_VERTEX_SHADER, SOLID_FRAGMENT_SHADER);
    this.textureProgram = this.createProgram(TEXTURE_VERTEX_SHADER, TEXTURE_FRAGMENT_SHADER);
    this.originalBuffer = this.requireBuffer();
    this.reconstructedBuffer = this.requireBuffer();
    this.playheadBuffer = this.requireBuffer();
    this.textureBuffer = this.requireBuffer();
    this.installContextHandlers();
  }

  resize() {
    return resizeCanvasToDisplaySize(this.canvas, WEBGL_MAX_WAVE_BACKING_PIXELS, WEBGL_MIN_WAVE_SCALE);
  }

  setEnvelopeData(data: AudioWaveEnvelopeData | null) {
    this.data = data;
    if (!data) {
      this.uploadedRevision = -1;
    }
  }

  renderFrame(frame: AudioWaveRenderFrame) {
    if (!this.data || this.contextLost) {
      this.clear();
      return;
    }

    this.ensureUploaded();
    const pointCount = Math.max(0, Math.min(frame.pointCount, this.data.bucketCount - frame.firstBucketIndex));
    this.clear();
    if (pointCount <= 0) {
      return;
    }

    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.gl.useProgram(this.envelopeProgram);
    this.setEnvelopeUniforms(frame);
    if (!frame.isFullEnergy) {
      this.drawEnvelopeBuffer(
        this.originalBuffer,
        frame.firstBucketIndex,
        pointCount,
        [1, 1, 1, 0.32]
      );
    }
    if (!frame.livePlayback) {
      this.drawEnvelopeBuffer(
        this.reconstructedBuffer,
        frame.firstBucketIndex,
        pointCount,
        [1, 1, 1, 0.12]
      );
    }
    this.drawEnvelopeBuffer(
      this.reconstructedBuffer,
      frame.firstBucketIndex,
      pointCount,
      [1, 1, 1, 0.72]
    );
    if (frame.playheadX !== null) {
      this.drawPlayhead(frame.playheadX, frame.livePlayback);
    }
  }

  drawEmptyState(label: string) {
    this.clear();
    const fallback = document.createElement('canvas');
    fallback.width = this.canvas.width;
    fallback.height = this.canvas.height;
    const context = fallback.getContext('2d');
    if (!context) {
      return;
    }
    context.fillStyle = 'rgba(235, 244, 239, 0.55)';
    context.font = '16px Inter, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, fallback.width / 2, fallback.height / 2);
    const texture = this.gl.createTexture();
    if (!texture) {
      return;
    }
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, fallback);
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.gl.useProgram(this.textureProgram);
    const vertices = new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      -1, 1, 0, 0,
      1, -1, 1, 1,
      1, 1, 1, 0
    ]);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.textureBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STREAM_DRAW);
    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
    const positionLocation = this.gl.getAttribLocation(this.textureProgram, 'a_position');
    const texCoordLocation = this.gl.getAttribLocation(this.textureProgram, 'a_texCoord');
    this.gl.enableVertexAttribArray(positionLocation);
    this.gl.vertexAttribPointer(positionLocation, 2, this.gl.FLOAT, false, stride, 0);
    this.gl.enableVertexAttribArray(texCoordLocation);
    this.gl.vertexAttribPointer(texCoordLocation, 2, this.gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    this.gl.deleteTexture(texture);
  }

  clear() {
    if (this.contextLost) {
      return;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.clearColor(0, 0, 0, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  dispose() {
    this.cleanupCallbacks.splice(0).forEach((callback) => callback());
    this.gl.deleteBuffer(this.originalBuffer);
    this.gl.deleteBuffer(this.reconstructedBuffer);
    this.gl.deleteBuffer(this.playheadBuffer);
    this.gl.deleteBuffer(this.textureBuffer);
    this.gl.deleteProgram(this.envelopeProgram);
    this.gl.deleteProgram(this.solidProgram);
    this.gl.deleteProgram(this.textureProgram);
    this.data = null;
  }

  private ensureUploaded() {
    if (!this.data || this.uploadedRevision === this.data.revision) {
      return;
    }
    this.uploadEnvelope(this.originalBuffer, this.data.originalAmplitudes, this.data.bucketCount);
    this.uploadEnvelope(this.reconstructedBuffer, this.data.reconstructedAmplitudes, this.data.bucketCount);
    this.uploadedRevision = this.data.revision;
  }

  private uploadEnvelope(buffer: WebGLBuffer, amplitudes: Float32Array, bucketCount: number) {
    const vertices = new Float32Array(bucketCount * 2 * 3);
    for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
      const amplitude = Math.max(0, amplitudes[bucketIndex] || 0);
      const vertexOffset = bucketIndex * 6;
      vertices[vertexOffset] = bucketIndex;
      vertices[vertexOffset + 1] = 1;
      vertices[vertexOffset + 2] = amplitude;
      vertices[vertexOffset + 3] = bucketIndex;
      vertices[vertexOffset + 4] = -1;
      vertices[vertexOffset + 5] = amplitude;
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.DYNAMIC_DRAW);
  }

  private drawEnvelopeBuffer(buffer: WebGLBuffer, firstBucketIndex: number, pointCount: number, color: [number, number, number, number]) {
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    const stride = 3 * Float32Array.BYTES_PER_ELEMENT;
    this.enableEnvelopeAttribute('a_bucket', 1, stride, 0);
    this.enableEnvelopeAttribute('a_side', 1, stride, Float32Array.BYTES_PER_ELEMENT);
    this.enableEnvelopeAttribute('a_amplitude', 1, stride, Float32Array.BYTES_PER_ELEMENT * 2);
    const colorLocation = this.gl.getUniformLocation(this.envelopeProgram, 'u_color');
    this.gl.uniform4fv(colorLocation, color);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, firstBucketIndex * 2, pointCount * 2);
  }

  private setEnvelopeUniforms(frame: AudioWaveRenderFrame) {
    this.gl.uniform1f(this.requireUniform(this.envelopeProgram, 'u_startSample'), frame.startSample);
    this.gl.uniform1f(this.requireUniform(this.envelopeProgram, 'u_viewportSampleCount'), frame.viewportSampleCount);
    this.gl.uniform1f(this.requireUniform(this.envelopeProgram, 'u_bucketSampleCount'), this.data?.bucketSampleCount ?? 1);
    this.gl.uniform1f(this.requireUniform(this.envelopeProgram, 'u_yScale'), WAVE_Y_SCALE);
  }

  private drawPlayhead(x: number, livePlayback: boolean) {
    const width = Math.max(1, this.canvas.width);
    const xNdc = clamp(x / width, 0, 1) * 2 - 1;
    const halfWidth = Math.max(1.25 / width * 2, livePlayback ? 0.0015 : 0.0025);
    const vertices = new Float32Array([
      xNdc - halfWidth, -1,
      xNdc + halfWidth, -1,
      xNdc - halfWidth, 1,
      xNdc - halfWidth, 1,
      xNdc + halfWidth, -1,
      xNdc + halfWidth, 1
    ]);

    this.gl.useProgram(this.solidProgram);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.playheadBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STREAM_DRAW);
    const positionLocation = this.gl.getAttribLocation(this.solidProgram, 'a_position');
    this.gl.enableVertexAttribArray(positionLocation);
    this.gl.vertexAttribPointer(positionLocation, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.uniform4fv(
      this.requireUniform(this.solidProgram, 'u_color'),
      livePlayback ? [1, 1, 1, 0.9] : [1, 1, 1, 1]
    );
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
  }

  private enableEnvelopeAttribute(name: string, size: number, stride: number, offset: number) {
    const location = this.gl.getAttribLocation(this.envelopeProgram, name);
    if (location < 0) {
      throw new Error(`Missing waveform shader attribute: ${name}`);
    }
    this.gl.enableVertexAttribArray(location);
    this.gl.vertexAttribPointer(location, size, this.gl.FLOAT, false, stride, offset);
  }

  private createProgram(vertexSource: string, fragmentSource: string) {
    const vertexShader = this.createShader(this.gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this.createShader(this.gl.FRAGMENT_SHADER, fragmentSource);
    const program = this.gl.createProgram();
    if (!program) {
      throw new Error('Unable to create waveform shader program.');
    }
    this.gl.attachShader(program, vertexShader);
    this.gl.attachShader(program, fragmentShader);
    this.gl.linkProgram(program);
    this.gl.deleteShader(vertexShader);
    this.gl.deleteShader(fragmentShader);
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      const message = this.gl.getProgramInfoLog(program) || 'Unable to link waveform shader program.';
      this.gl.deleteProgram(program);
      throw new Error(message);
    }
    return program;
  }

  private createShader(type: number, source: string) {
    const shader = this.gl.createShader(type);
    if (!shader) {
      throw new Error('Unable to create waveform shader.');
    }
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const message = this.gl.getShaderInfoLog(shader) || 'Unable to compile waveform shader.';
      this.gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  private requireBuffer() {
    const buffer = this.gl.createBuffer();
    if (!buffer) {
      throw new Error('Unable to create waveform buffer.');
    }
    return buffer;
  }

  private requireUniform(program: WebGLProgram, name: string) {
    const location = this.gl.getUniformLocation(program, name);
    if (!location) {
      throw new Error(`Missing waveform shader uniform: ${name}`);
    }
    return location;
  }

  private installContextHandlers() {
    const handleLost = (event: Event) => {
      event.preventDefault();
      this.contextLost = true;
    };
    const handleRestored = () => {
      this.contextLost = false;
      this.uploadedRevision = -1;
    };
    this.canvas.addEventListener('webglcontextlost', handleLost);
    this.canvas.addEventListener('webglcontextrestored', handleRestored);
    this.cleanupCallbacks.push(() => {
      this.canvas.removeEventListener('webglcontextlost', handleLost);
      this.canvas.removeEventListener('webglcontextrestored', handleRestored);
    });
  }
}

export function createAudioWaveRenderer(canvas: HTMLCanvasElement): AudioWaveRenderer {
  if (shouldSkipWebGlRenderer()) {
    return new Canvas2dAudioWaveRenderer(canvas);
  }

  try {
    return new WebGlAudioWaveRenderer(canvas);
  } catch (_error) {
    return new Canvas2dAudioWaveRenderer(canvas);
  }
}

function shouldSkipWebGlRenderer() {
  const probeCanvas = document.createElement('canvas');
  const gl = (
    probeCanvas.getContext('webgl2', { powerPreference: 'high-performance' }) ??
    probeCanvas.getContext('webgl', { powerPreference: 'high-performance' }) ??
    probeCanvas.getContext('experimental-webgl', { powerPreference: 'high-performance' })
  ) as WebGLRenderingContext | null;
  if (!gl) {
    return true;
  }

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '')
    : '';
  return /swiftshader|software|llvmpipe/i.test(renderer);
}

const ENVELOPE_VERTEX_SHADER = `
attribute float a_bucket;
attribute float a_side;
attribute float a_amplitude;

uniform float u_startSample;
uniform float u_viewportSampleCount;
uniform float u_bucketSampleCount;
uniform float u_yScale;

void main() {
  float x = ((a_bucket * u_bucketSampleCount - u_startSample) / u_viewportSampleCount) * 2.0 - 1.0;
  float y = a_side * a_amplitude * u_yScale;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const ENVELOPE_FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 u_color;

void main() {
  gl_FragColor = u_color;
}
`;

const SOLID_VERTEX_SHADER = `
attribute vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const SOLID_FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 u_color;

void main() {
  gl_FragColor = u_color;
}
`;

const TEXTURE_VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
  v_texCoord = a_texCoord;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const TEXTURE_FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_texture;
varying vec2 v_texCoord;

void main() {
  gl_FragColor = texture2D(u_texture, v_texCoord);
}
`;
