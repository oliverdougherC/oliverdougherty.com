/** Immutable text-only provenance. No vision projector is requested. */
export const MODEL = Object.freeze({
  name: 'Qwen3.5-2B',
  quantization: 'Q4_K_M',
  upstream: 'Qwen/Qwen3.5-2B',
  upstreamRevision: '15852e8c16360a2fea060d615a32b45270f8a8fc',
  source: 'unsloth/Qwen3.5-2B-GGUF',
  revision: 'f6d5376be1edb4d416d56da11e5397a961aca8ae',
  file: 'Qwen3.5-2B-Q4_K_M.gguf',
  bytes: 1_280_835_840,
  sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223',
  license: 'Apache-2.0',
});
export const MODEL_URL = `https://huggingface.co/${MODEL.source}/resolve/${MODEL.revision}/${MODEL.file}`;
export const CONTEXT_TIERS = [65536, 32768, 16384, 8192, 4096, 2048] as const;
export const SAMPLING = Object.freeze({ temperature: 0.6, top_k: 20, top_p: 0.95, min_p: 0, penalty_repeat: 1 });

/** Adapter limits are allocation hints, never a measurement of available VRAM. */
export function contextTiers(maxBufferSize: number, deviceMemory?: number): number[] {
  const initial = maxBufferSize >= 2 ** 31 ? 65536
    : maxBufferSize >= 2 ** 30 && (deviceMemory ?? 8) >= 8 ? 32768
    : maxBufferSize >= 2 ** 29 ? 8192 : 4096;
  return CONTEXT_TIERS.filter(tier => tier <= initial);
}

export async function allocateContext<T>(tiers: number[], create: () => T,
  allocate: (runtime: T, context: number) => Promise<void>, dispose: (runtime: T) => Promise<void>,
  signal: AbortSignal, retryable: (error: unknown) => boolean = isAllocationError): Promise<{ runtime: T; context: number }> {
  let last: unknown = new Error('No supported context size.');
  for (const context of tiers) {
    signal.throwIfAborted();
    const runtime = create();
    try {
      await allocate(runtime, context);
      signal.throwIfAborted();
      return { runtime, context };
    } catch (error) {
      await dispose(runtime);
      signal.throwIfAborted();
      last = error;
      if (!retryable(error)) throw error;
    }
  }
  throw last;
}
export function isAllocationError(error: unknown): boolean {
  return /out of memory|allocation|allocat|memory access|memory limit|buffer.*size|insufficient|failed to create.*context|failed to initialize.*context/i.test(String(error));
}
export function architecture(meta: Record<string, string>, count: number): Array<'deltanet' | 'attention'> {
  if (meta['general.architecture'] !== 'qwen35') throw new Error('Unexpected model architecture. Please retry the model download.');
  const interval = Number(meta['qwen35.full_attention_interval']);
  if (!Number.isInteger(interval) || interval < 1 || !Number.isInteger(count) || count < 1 || count > 256) {
    throw new Error('The model does not report a supported hybrid block structure.');
  }
  return Array.from({ length: count }, (_, i) => (i + 1) % interval === 0 ? 'attention' : 'deltanet');
}
