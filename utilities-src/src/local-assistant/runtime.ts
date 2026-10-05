import type { Wllama as NativeRuntime } from '../../local-assistant-runtime/dist/index.js';
import { allocateContext, architecture, contextTiers, MODEL, MODEL_URL, SAMPLING } from './model';
import { downloadModel } from './download';
import type { AssistantMessage, ModelInfo, Observation, Runtime } from './types';

interface Adapter { limits: { maxBufferSize: number }; isFallbackAdapter?: boolean }
interface Gpu { requestAdapter(options: { powerPreference: string }): Promise<Adapter | null> }
interface NativeChunk {
  choices: Array<{ delta: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string }>;
  timings?: { prompt_ms: number; predicted_per_second: number; predicted_n: number };
  prompt_progress?: { total: number; processed: number; cache: number; time_ms: number };
  observatory?: {
    layers?: Observation['layers']; prompt_tokens?: Observation['promptTokens']; token?: Observation['token'];
    candidates?: Observation['candidates']; generated?: number; context_used?: number; pass?: number; layer_backend?: string;
    attention?: Array<{ layer: number; query_position: number; key_count: number; head_count: number; entries: Array<{ position: number; weight: number }>; coverage?: number }>;
    layer_changes?: Array<{ layer: number; input_rms: number; delta_rms: number; relative_delta: number }>;
    lens?: Observation['lens'];
  };
}
/** Generation owns one slot; all model work executes in wllama's dedicated worker. */
export class AssistantRuntime implements Runtime {
  private engine: NativeRuntime | null = null;
  private loadingEngine: NativeRuntime | null = null;
  private info: ModelInfo | null = null;
  private disposed = false;
  private slow = false;

  async load(signal: AbortSignal, progress: (loaded: number, total: number | null, phase: string) => void): Promise<ModelInfo> {
    const gpu = (navigator as Navigator & { gpu?: Gpu }).gpu;
    if (!gpu || !('Suspending' in WebAssembly)) {
      throw new DOMException('This experiment requires WebGPU and WebAssembly JSPI. Try a current Chromium browser.', 'NotSupportedError');
    }
    let adapter: Adapter | null;
    try { adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }); }
    catch { throw new Error('The browser could not open a GPU adapter. Close other GPU-heavy tabs and retry.'); }
    signal.throwIfAborted();
    if (!adapter || adapter.isFallbackAdapter) throw new DOMException('This experiment requires a hardware WebGPU adapter.', 'NotSupportedError');
    const tiers = contextTiers(adapter.limits.maxBufferSize, (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
    // The constructor's cache manager is never used; loadModel(Blob[]) bypasses it.
    const { Wllama } = await import('../../local-assistant-runtime/dist/index.js');
    const wasm = new URL('../../local-assistant-runtime/dist/wllama.wasm', import.meta.url).href;
    signal.throwIfAborted();
    const blob = await downloadModel(MODEL_URL, MODEL.bytes, signal, progress);
    signal.throwIfAborted();
    const stopLoading = () => { const runtime = this.loadingEngine; if (runtime) void this.release(runtime); };
    signal.addEventListener('abort', stopLoading, { once: true });
    let offloaded = false;
    let nativeFailure = '';
    const log = (...args: unknown[]) => {
      const message = args.map(String).join(' ');
      const match = /offloaded\s+(\d+)\/(\d+)\s+layers/i.exec(message);
      if (match && Number(match[1]) > 0 && match[1] === match[2]) offloaded = true;
      if (/error|failed|out of memory|allocat.*fail/i.test(message)) nativeFailure = message.slice(0, 240);
    };
    try {
      const loaded = await allocateContext(tiers, () => {
        offloaded = false;
        nativeFailure = '';
        const runtime: NativeRuntime = new Wllama({ default: wasm }, { logger: { debug: log, log, warn: log, error: log } });
        runtime.setCompat(null); // No remote compatibility code or silent CPU path.
        this.loadingEngine = runtime;
        return runtime;
      }, async (runtime, context) => {
        progress(MODEL.bytes, MODEL.bytes, `Allocating ${context.toLocaleString()} token context`);
        try {
          await runtime.loadModel([blob], {
            n_ctx: context, n_gpu_layers: 99999, n_parallel: 1, n_threads: 1,
            n_batch: 256, n_ubatch: 64, jinja: true, reasoning: true,
            reasoning_format: 'deepseek', ctx_shift: false, cache_idle_slots: false,
            observatory: true,
          });
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : String(error)} ${nativeFailure}`.trim());
        }
        if (!offloaded) throw new Error('The runtime could not confirm GPU execution. This experiment does not use a CPU fallback.');
      }, runtime => this.release(runtime), signal);
      this.engine = loaded.runtime;
      this.engine.setSlowMode(this.slow);
      if (this.disposed) { await this.dispose(); throw new DOMException('Cancelled', 'AbortError'); }
      const metadata = this.engine.getModelMetadata();
      this.info = { name: MODEL.name, context: loaded.context,
        layers: architecture(metadata.meta, metadata.hparams.nLayer), backend: 'WebGPU' };
      return this.info;
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      signal.removeEventListener('abort', stopLoading);
      this.loadingEngine = null;
    }
  }

  async generate(messages: AssistantMessage[], thinking: boolean, signal: AbortSignal,
    update: (content: string, reasoning: string, observation: Observation) => void): Promise<void> {
    const engine = this.engine;
    if (!engine || !this.info) throw new Error('Load the model before sending a message.');
    signal.throwIfAborted();
    let content = '', reasoning = '';
    let lastTokenIds: number[] = [];
    let looping = false;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const options = {
        messages: messages.map(({ role, content: text }) => ({ role, content: text })),
        stream: true as const, abortSignal: abort.signal, max_tokens: -1,
        ...SAMPLING, chat_template_kwargs: { enable_thinking: thinking },
        cache_prompt: false, return_tokens: true, logprobs: true, top_logprobs: 8,
        post_sampling_probs: true, timings_per_token: true, return_progress: true,
        onData: (chunk: NativeChunk) => {
          if (signal.aborted || this.disposed) return;
          const choice = chunk.choices[0];
          content += choice?.delta?.content ?? '';
          reasoning += choice?.delta?.reasoning_content ?? '';
          const event = chunk.observatory;
          const observation: Observation = {};
          if (event?.token) {
            // Each sampled token owns its snapshot. Missing measurements must not
            // inherit values from an earlier pass through session state merging.
            observation.attention = event.attention?.map(reading => ({
              layer: reading.layer, queryPosition: reading.query_position,
              keyCount: reading.key_count, headCount: reading.head_count,
              entries: reading.entries, coverage: reading.coverage,
            }));
            observation.layerChanges = event.layer_changes?.map(reading => ({
              layer: reading.layer, inputRms: reading.input_rms,
              deltaRms: reading.delta_rms, relativeDelta: reading.relative_delta,
            }));
            observation.lens = event.lens;
            observation.candidates = event.candidates;
            observation.layers = event.layers;
            observation.pass = event.pass;
          }
          if (event?.layers) observation.layers = event.layers;
          if (event?.prompt_tokens) observation.promptTokens = event.prompt_tokens;
          if (event?.token) observation.token = event.token;
          if (event?.candidates) observation.candidates = event.candidates;
          if (event?.context_used !== undefined) observation.contextUsed = event.context_used;
          if (event?.pass !== undefined) observation.pass = event.pass;
          if (event?.layer_backend) observation.layerBackend = event.layer_backend;
          if (chunk.prompt_progress) {
            const progress = chunk.prompt_progress;
            observation.stage = 'prefill';
            observation.promptProcessed = progress.processed;
            observation.promptTotal = progress.total;
            observation.promptMs = progress.time_ms;
            observation.contextUsed = progress.processed;
          }
          if (event?.token && event.generated !== undefined) {
            observation.stage = 'decode';
            observation.generated = event.generated;
          }
          if (chunk.timings) {
            observation.promptMs = chunk.timings.prompt_ms;
            if (chunk.timings.predicted_per_second > 0) observation.tokensPerSecond = chunk.timings.predicted_per_second;
            // Native begin/progress events must not invent a generated token.
            if (choice?.finish_reason && chunk.timings.predicted_n > 0) observation.generated = chunk.timings.predicted_n;
          }
          update(content, reasoning, observation);
          if (event?.token) {
            lastTokenIds.push(event.token.id);
            lastTokenIds = lastTokenIds.slice(-192);
            if (isRepeatingTokenLoop(lastTokenIds)) {
              looping = true;
              abort.abort();
            }
          }
        },
      };
      await engine.createChatCompletion(options);
    } catch (error) {
      if (looping) throw new Error('Stopped a repeating token loop. Start a new chat or try a different prompt.');
      if (/context (?:is )?full|context.*exceed|exceed.*context|n_ctx.*(?:exceed|full)/i.test(String(error))) {
        throw new Error('The context is full. Start a new chat to continue.');
      }
      throw error;
    } finally { signal.removeEventListener('abort', onAbort); }
  }

  setSlowMode(slow: boolean): void {
    this.slow = slow;
    this.engine?.setSlowMode(slow);
  }

  async reset(): Promise<void> { await this.engine?.resetConversation(); }
  async dispose(): Promise<void> {
    this.disposed = true;
    const runtimes = new Set([this.engine, this.loadingEngine]);
    this.engine = null;
    this.loadingEngine = null;
    this.info = null;
    for (const runtime of runtimes) if (runtime) await this.release(runtime);
  }
  private async release(runtime: NativeRuntime): Promise<void> {
    // Terminating the owner worker releases its WebGPU device even after a failed allocation.
    await runtime.exit();
  }
}
export const createAssistantRuntime = (): Runtime => new AssistantRuntime();

/** Conservative exact suffix cycles of several lengths, with bounded memory/work. */
export function isRepeatingTokenLoop(tokens: readonly number[]): boolean {
  for (let period = 1; period <= 32; period++) {
    const count = Math.max(32, period * 6);
    if (tokens.length < count) continue;
    const start = tokens.length - count;
    let matches = true;
    for (let i = start + period; i < tokens.length; i++) {
      if (tokens[i] !== tokens[i - period]) { matches = false; break; }
    }
    if (matches) return true;
  }
  return false;
}
