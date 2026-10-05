import type { AssistantState, Runtime } from './types';

interface RuntimeHandle {
  runtime: Runtime;
  task: Promise<void>;
  loaded: boolean;
}

/** Models are released after five minutes without interaction, or five minutes away. */
export const ASSISTANT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export class AssistantSession {
  private current: AssistantState = {
    phase: 'idle', active: false, thinking: true, slow: false, entered: false, messages: [],
    info: null, observation: {}, loaded: 0, total: null, status: 'Ready to load the local model.'
  };
  private listeners = new Set<(state: AssistantState) => void>();
  private handle: RuntimeHandle | null = null;
  private controller: AbortController | null = null;
  private version = 0;
  private destroyed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private factory: () => Runtime, private options: { idleTimeoutMs?: number } = {}) {}

  get state(): AssistantState { return this.current; }

  subscribe(listener: (state: AssistantState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => { this.listeners.delete(listener); };
  }

  touchActivity(): void { this.touch(); }

  private publish(patch: Partial<AssistantState>): void {
    if (this.destroyed) return;
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener(this.current);
  }

  private cancel(): number {
    const controller = this.controller;
    this.controller = null;
    const version = ++this.version;
    // Abort listeners can synchronously emit a final progress/token callback.
    controller?.abort();
    return version;
  }

  private valid(handle: RuntimeHandle, version: number): boolean {
    return !this.destroyed && this.handle === handle && this.version === version;
  }

  private clearTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private touch(): void {
    this.clearTimer();
    if (!this.handle?.loaded || this.current.phase === 'generating' || this.destroyed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const handle = this.handle;
      this.cancel();
      this.handle = null;
      this.publish({ phase: 'idle', entered: false, info: null, observation: {}, loaded: 0, total: null, status: 'Model unloaded after five minutes idle. Return to reload.' });
      if (handle) void this.release(handle);
    }, this.options.idleTimeoutMs ?? ASSISTANT_IDLE_TIMEOUT_MS);
  }

  private async release(handle: RuntimeHandle): Promise<void> {
    // Dispose must terminate a worker even if its aborted task never settles.
    await handle.runtime.dispose().catch(() => {});
  }

  private failure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const unsupported = error instanceof Error && error.name === 'NotSupportedError';
    this.publish({ phase: unsupported ? 'unsupported' : 'error', status: message || 'The local model failed. Try again.' });
    this.touch();
  }

  async activate(): Promise<void> {
    if (this.destroyed) return;
    this.publish({ active: true });
    this.touch();
    if (this.handle) {
      await this.handle.task;
      return;
    }
    const version = this.cancel();
    const controller = this.controller = new AbortController();
    this.publish({ phase: 'loading', entered: false, info: null, loaded: 0, total: null, status: 'Preparing local inference…' });
    let handle: RuntimeHandle;
    try {
      handle = { runtime: this.factory(), task: Promise.resolve(), loaded: false };
    } catch (error) {
      this.failure(error);
      return;
    }
    this.handle = handle;
    handle.runtime.setSlowMode?.(this.current.slow);
    handle.task = (async () => {
      try {
        const info = await handle.runtime.load(controller.signal, (loaded, total, status) => {
          if (this.valid(handle, version)) this.publish({ loaded, total, status });
        });
        if (!this.valid(handle, version)) return;
        handle.loaded = true;
        this.controller = null;
        this.publish({ phase: 'ready', info, status: 'Model ready. Enter chat when you are ready.' });
        this.touch();
      } catch (error) {
        if (!this.valid(handle, version)) return;
        this.handle = null;
        // Avoid awaiting this task from within itself.
        void handle.runtime.dispose().catch(() => {});
        this.failure(error);
      }
    })();
    await handle.task;
  }

  deactivate(): void {
    if (this.destroyed) return;
    this.publish({ active: false });
    if (this.current.phase === 'loading') {
      const handle = this.handle;
      this.cancel();
      this.handle = null;
      this.publish({ phase: 'idle', loaded: 0, total: null, status: 'Loading paused. Return to reload the model.' });
      if (handle) void this.release(handle);
    } else {
      this.stop();
    }
    this.touch();
  }

  enterChat(): void {
    if (this.current.phase === 'ready' && this.current.active) {
      this.publish({ entered: true });
      this.touch();
    }
  }

  setThinking(thinking: boolean): void {
    if (this.current.phase === 'generating') return;
    this.publish({ thinking });
    this.touch();
  }

  setSlow(slow: boolean): void {
    this.handle?.runtime.setSlowMode?.(slow);
    this.publish({ slow });
    this.touch();
  }

  async send(text: string): Promise<void> {
    const content = text.trim();
    if (!content || this.destroyed || !this.current.active || this.current.phase === 'generating') return;
    if (!this.handle?.loaded) await this.activate();
    const handle = this.handle;
    if (!handle?.loaded || !this.current.active || this.destroyed || this.state.phase === 'generating') return;
    const version = this.cancel();
    const controller = this.controller = new AbortController();
    const messages = [...this.current.messages, { role: 'user' as const, content }];
    const thinking = this.current.thinking;
    this.clearTimer();
    this.publish({ phase: 'generating', entered: true, messages: [...messages, { role: 'assistant', content: '', reasoning: '' }], observation: { stage: 'prefill', promptProcessed: 0 }, status: 'Generating locally…' });
    const previous = handle.task;
    handle.task = (async () => {
      await previous;
      if (!this.valid(handle, version)) return;
      try {
        await handle.runtime.generate(messages, thinking, controller.signal, (answer, reasoning, observation) => {
          if (!this.valid(handle, version)) return;
          this.publish({ messages: [...messages, { role: 'assistant', content: answer, reasoning }], observation: { ...this.current.observation, ...observation } });
        });
        if (!this.valid(handle, version)) return;
        this.controller = null;
        this.publish({ phase: 'ready', status: 'Ready for your next message.' });
        this.touch();
      } catch (error) {
        if (this.valid(handle, version)) this.failure(error);
      }
    })();
    await handle.task;
  }

  stop(): void {
    if (this.current.phase !== 'generating') return;
    this.cancel();
    this.publish({ phase: 'ready', status: 'Generation stopped.' });
    this.touch();
  }

  async reset(): Promise<void> {
    if (this.destroyed) return;
    this.clearTimer();
    const version = this.cancel();
    const handle = this.handle;
    this.publish({ messages: [], observation: {}, status: 'Conversation reset.', phase: handle?.loaded ? 'ready' : this.current.phase });
    if (!handle?.loaded) {
      if (handle) {
        this.handle = null;
        this.publish({ phase: 'idle', loaded: 0, total: null });
        void this.release(handle);
      }
      return;
    }
    const previous = handle.task;
    handle.task = (async () => {
      await previous;
      // A new send may already be queued; it must still see a reset runtime.
      if (this.destroyed || this.handle !== handle) return;
      try {
        await handle.runtime.reset();
        if (this.valid(handle, version)) this.touch();
      } catch (error) {
        if (this.destroyed || this.handle !== handle) return;
        this.cancel();
        this.handle = null;
        this.publish({ info: null });
        void handle.runtime.dispose().catch(() => {});
        this.failure(error);
      }
    })();
    await handle.task;
  }

  async retry(): Promise<void> {
    if (this.destroyed) return;
    const handle = this.handle;
    this.cancel();
    this.clearTimer();
    this.handle = null;
    if (handle) await this.release(handle);
    if (!this.destroyed && this.current.active) await this.activate();
  }

  /** Release GPU resources on pagehide without destroying bfcache-restorable state. */
  async unload(): Promise<void> {
    if (this.destroyed) return;
    const handle = this.handle;
    this.cancel();
    this.clearTimer();
    this.handle = null;
    this.publish({ phase: 'idle', entered: false, info: null, observation: {}, loaded: 0, total: null, status: 'Model unloaded. Return to reload.' });
    if (handle) await this.release(handle);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancel();
    this.clearTimer();
    this.listeners.clear();
    const handle = this.handle;
    this.handle = null;
    if (handle) await this.release(handle);
  }
}
