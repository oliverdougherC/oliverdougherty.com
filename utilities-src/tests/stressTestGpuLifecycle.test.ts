/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAdaptiveGpuStress } from '@utilities/stressTestGpu';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function gpuFixture() {
  const completions: ReturnType<typeof deferred<void>>[] = [];
  const lost = deferred<{ reason: string; message: string }>();
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), draw: vi.fn(), end: vi.fn() };
  const context = { configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture: () => ({ createView: vi.fn() }) };
  const buffer = { destroy: vi.fn() };
  const device = {
    limits: { maxStorageBufferBindingSize: 1024 * 1024, maxComputeWorkgroupsPerDimension: 64 },
    queue: { submit: vi.fn(), writeBuffer: vi.fn(), onSubmittedWorkDone: vi.fn(() => {
      const completion = deferred<void>();
      completions.push(completion);
      return completion.promise;
    }) },
    createShaderModule: vi.fn(), createComputePipeline: () => ({ getBindGroupLayout: vi.fn() }),
    createRenderPipeline: () => ({ getBindGroupLayout: vi.fn() }), createBuffer: () => buffer,
    createBindGroup: vi.fn(), createCommandEncoder: () => ({ beginComputePass: () => pass,
      beginRenderPass: () => pass, finish: vi.fn() }),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null as { message: string } | null),
    lost: lost.promise, destroy: vi.fn()
  };
  const adapter = { info: { description: 'Test adapter' }, requestDevice: vi.fn(async () => device) };
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: {
    requestAdapter: vi.fn(async () => adapter), getPreferredCanvasFormat: () => 'bgra8unorm'
  } });
  const contexts: HTMLCanvasElement[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string) {
    contexts.push(this);
    return type === 'webgpu' ? context : null;
  } as HTMLCanvasElement['getContext']);
  const callbacks = { onFrame: vi.fn(), onWorkloadLevel: vi.fn(), onCanvasActive: vi.fn(),
    onAsyncError: vi.fn(), onCanvasReplace: vi.fn() };
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  return { canvas, callbacks, device, adapter, completions, lost, context, buffer, pass, contexts };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'gpu'); document.body.innerHTML = '';
});

describe('GPU completion and lifecycle', () => {
  it('keeps two batches queued and immediately replaces completed work without a timer gap', async () => {
    const test = gpuFixture();
    const handle = await startAdaptiveGpuStress(test.canvas, test.callbacks);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.device.queue.submit).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(test.device.queue.submit).toHaveBeenCalledTimes(2);
    expect(test.callbacks.onFrame).not.toHaveBeenCalled();
    test.completions[0].resolve();
    await Promise.resolve();
    expect(test.device.queue.submit).toHaveBeenCalledTimes(3);
    expect(test.callbacks.onFrame).toHaveBeenCalledTimes(1);
    test.completions[1].resolve();
    await Promise.resolve();
    expect(test.device.queue.submit).toHaveBeenCalledTimes(4);
    handle!.stop();
    test.completions[2].resolve();
    test.completions[3].resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.device.queue.submit).toHaveBeenCalledTimes(4);
    expect(test.callbacks.onFrame).toHaveBeenCalledTimes(2);
    expect(test.device.destroy).toHaveBeenCalledTimes(1);
    expect(test.context.unconfigure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains outstanding batches before resizing the canvas, then fills both slots', async () => {
    const test = gpuFixture();
    let width = 400;
    vi.spyOn(test.canvas, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 300 } as DOMRect));
    const handle = await startAdaptiveGpuStress(test.canvas, test.callbacks);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.canvas.width).toBe(400);
    width = 600;
    test.completions[0].resolve();
    await Promise.resolve();
    expect(test.canvas.width).toBe(400);
    expect(test.device.queue.submit).toHaveBeenCalledTimes(2);
    test.completions[1].resolve();
    await Promise.resolve();
    expect(test.canvas.width).toBe(600);
    expect(test.device.queue.submit).toHaveBeenCalledTimes(4);
    handle!.stop();
  });

  it('stops stalled work and ignores its late completions', async () => {
    const test = gpuFixture();
    await startAdaptiveGpuStress(test.canvas, test.callbacks);
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.callbacks.onAsyncError).toHaveBeenCalledWith('GPU stopped responding.');
    expect(test.device.destroy).toHaveBeenCalledTimes(1);
    for (const completion of test.completions) completion.resolve();
    await Promise.resolve();
    expect(test.device.queue.submit).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending completions and releases resources after device loss', async () => {
    const test = gpuFixture();
    await startAdaptiveGpuStress(test.canvas, test.callbacks);
    await vi.advanceTimersByTimeAsync(0);
    test.lost.resolve({ reason: 'unknown', message: 'Adapter disconnected' });
    await Promise.resolve();
    expect(test.device.destroy).toHaveBeenCalledTimes(1);
    expect(test.callbacks.onAsyncError).toHaveBeenCalledWith(expect.stringContaining('Adapter disconnected'));
    for (const completion of test.completions) completion.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.callbacks.onFrame).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls through validation failures using a fresh canvas for each backend', async () => {
    const test = gpuFixture();
    test.device.popErrorScope.mockResolvedValue({ message: 'invalid pipeline' });
    expect(await startAdaptiveGpuStress(test.canvas, test.callbacks)).toBeNull();
    expect(test.device.destroy).toHaveBeenCalledTimes(1);
    expect(test.callbacks.onCanvasReplace).toHaveBeenCalledTimes(2);
    expect(new Set(test.contexts).size).toBe(3);
    expect(test.canvas.isConnected).toBe(false);
    expect(document.querySelector('canvas')).toBe(test.contexts[2]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not replace the canvas or start work when startup is aborted', async () => {
    const test = gpuFixture();
    const pending = deferred<typeof test.device>();
    test.adapter.requestDevice.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const start = startAdaptiveGpuStress(test.canvas, test.callbacks, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    pending.resolve(test.device);
    expect(await start).toBeNull();
    expect(test.device.destroy).toHaveBeenCalledTimes(1);
    expect(test.callbacks.onCanvasReplace).not.toHaveBeenCalled();
    expect(test.device.queue.submit).not.toHaveBeenCalled();
    expect(test.canvas.isConnected).toBe(true);
  });

  it('handles motion, interaction, and active cancellation without leaving queued work', async () => {
    const test = gpuFixture();
    const controller = new AbortController();
    const handle = await startAdaptiveGpuStress(test.canvas, test.callbacks, { signal: controller.signal });
    handle!.setPointer!(2, -2);
    handle!.setReducedMotion!(true);
    await vi.advanceTimersByTimeAsync(0);
    const uniform = test.device.queue.writeBuffer.mock.calls[0][2] as Float32Array;
    expect(uniform[0]).toBe(0);
    expect(uniform[4]).toBe(1);
    expect(uniform[5]).toBe(-1);
    expect(handle!.getDiagnostics!().adapter).toBe('Test adapter');
    controller.abort();
    handle!.stop();
    expect(test.device.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function webGlFixture() {
  Reflect.deleteProperty(navigator, 'gpu');
  let sequence = 0;
  const completed = new Set<WebGLSync>();
  const fences: WebGLSync[] = [];
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    MAX_VIEWPORT_DIMS: 5, MAX_RENDERBUFFER_SIZE: 6, WAIT_FAILED: 7,
    TIMEOUT_EXPIRED: 8, CONDITION_SATISFIED: 9, HIGH_FLOAT: 10,
    ARRAY_BUFFER: 11, STATIC_DRAW: 12, FLOAT: 13, BLEND: 14, ONE: 15,
    COLOR_BUFFER_BIT: 16, TRIANGLES: 17, SYNC_GPU_COMMANDS_COMPLETE: 18,
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderPrecisionFormat: () => ({ precision: 23 }),
    createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: () => true, createBuffer: () => ({}), bindBuffer: vi.fn(), bufferData: vi.fn(),
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    getParameter: (parameter: number) => parameter === 5 ? new Int32Array([128, 128]) : 128,
    getExtension: () => null, viewport: vi.fn(), useProgram: vi.fn(), enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(), uniform2f: vi.fn(), uniform4f: vi.fn(), enable: vi.fn(), blendFunc: vi.fn(),
    clearColor: vi.fn(), clear: vi.fn(), drawArrays: vi.fn(), isContextLost: () => false,
    fenceSync: vi.fn(() => {
      const fence = { sequence: sequence++ } as WebGLSync;
      fences.push(fence);
      return fence;
    }),
    clientWaitSync: vi.fn((fence: WebGLSync): number => completed.has(fence) ? 9 : 8),
    flush: vi.fn(), finish: vi.fn(), deleteSync: vi.fn(), deleteShader: vi.fn(),
    deleteProgram: vi.fn(), deleteBuffer: vi.fn()
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
    type === 'webgl2' ? gl : null) as HTMLCanvasElement['getContext']);
  const callbacks = { onFrame: vi.fn(), onWorkloadLevel: vi.fn(), onCanvasActive: vi.fn(), onAsyncError: vi.fn() };
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ width: 128, height: 128 } as DOMRect);
  return { gl, completed, fences, canvas, callbacks };
}

describe('WebGL 2 bounded completion pipeline', () => {
  it('keeps two real GPU batches in flight and refills each retired fence', async () => {
    const test = webGlFixture();
    const handle = await startAdaptiveGpuStress(test.canvas, test.callbacks);
    await vi.advanceTimersByTimeAsync(0);
    expect(handle!.backend).toBe('webgl2-fragment');
    expect(test.gl.fenceSync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(test.gl.fenceSync).toHaveBeenCalledTimes(2);
    test.completed.add(test.fences[0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.gl.fenceSync).toHaveBeenCalledTimes(3);
    expect(test.gl.deleteSync).toHaveBeenCalledWith(test.fences[0]);
    expect(test.gl.finish).not.toHaveBeenCalled();
    expect(test.callbacks.onFrame).toHaveBeenCalledTimes(1);
    handle!.stop();
    expect(test.gl.deleteSync).toHaveBeenCalledTimes(3);
    test.completed.add(test.fences[1]);
    test.completed.add(test.fences[2]);
    await vi.advanceTimersByTimeAsync(100);
    expect(test.gl.fenceSync).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases all in-flight fences and stops replenishing after context loss', async () => {
    const test = webGlFixture();
    await startAdaptiveGpuStress(test.canvas, test.callbacks);
    await vi.advanceTimersByTimeAsync(0);
    test.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(test.gl.deleteSync).toHaveBeenCalledTimes(2);
    expect(test.callbacks.onAsyncError).toHaveBeenCalledWith(expect.stringContaining('context lost'));
    await vi.advanceTimersByTimeAsync(100);
    expect(test.gl.fenceSync).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up when a fence reports a completion-tracking error', async () => {
    const test = webGlFixture();
    await startAdaptiveGpuStress(test.canvas, test.callbacks);
    await vi.advanceTimersByTimeAsync(0);
    test.gl.clientWaitSync.mockReturnValue(test.gl.WAIT_FAILED);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.callbacks.onAsyncError).toHaveBeenCalledWith('GPU completion tracking failed.');
    expect(test.gl.deleteSync).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
