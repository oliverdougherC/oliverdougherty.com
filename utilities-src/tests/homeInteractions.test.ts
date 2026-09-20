import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

describe('homepage excursion lifecycle', () => {
  let dom: JSDOM;
  let frames: Map<number, FrameRequestCallback>;
  let pending: Array<{ resolve: () => void; reject: () => void }>;
  let source: { volume: number; currentTime: number; paused: boolean; pause: () => void };
  let hidden: boolean;
  let motion: { matches: boolean; addEventListener: (_: string, cb: () => void) => void };
  let motionChange: () => void;
  let now: number;
  beforeEach(() => {
    dom = new JSDOM('<span class="excursion-trigger" data-audio="excerpt.mp3">excursions</span>', { runScripts: 'outside-only' });
    frames = new Map(); pending = []; hidden = false; now = 0;
    let id = 0;
    dom.window.requestAnimationFrame = (cb) => { frames.set(++id, cb); return id; };
    dom.window.cancelAnimationFrame = (key) => { frames.delete(key); };
    Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
    dom.window.performance.now = () => now;
    motion = { matches: false, addEventListener: (_, cb) => { motionChange = cb; } };
    dom.window.matchMedia = (() => motion) as unknown as typeof dom.window.matchMedia;
    dom.window.Audio = class {
      volume = 0; currentTime = 0; duration = 20; paused = true;
      constructor() { source = this; }
      addEventListener() {}
      pause() { this.paused = true; }
      play() { return new Promise<void>((resolve, reject) => pending.push({ resolve: () => { this.paused = false; resolve(); }, reject: () => reject(new Error('blocked')) })); }
    } as unknown as typeof dom.window.Audio;
    dom.window.eval(readFileSync('js/home-interactions.js', 'utf8'));
  });
  afterEach(() => dom.window.close());
  const enter = () => dom.window.document.querySelector('.excursion-trigger')!.dispatchEvent(new dom.window.Event('mouseenter'));
  const leave = () => dom.window.document.querySelector('.excursion-trigger')!.dispatchEvent(new dom.window.Event('mouseleave'));
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const tick = (time: number) => { now = time; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb(time)); };
  const stopped = () => {
    expect(source.paused).toBe(true); expect(source.volume).toBe(0); expect(source.currentTime).toBe(0);
    expect(frames.size).toBe(0); expect(dom.window.document.documentElement.classList.contains('is-musical')).toBe(false);
  };
  it('invalidates a pending play when the pointer leaves', async () => {
    enter(); leave(); pending[0].resolve(); await flush(); stopped();
  });
  it.each(['fade-in', 'fade-out', 'pagehide'])('immediately stops %s without depending on future frames', async (phase) => {
    enter(); pending[0].resolve(); await flush(); tick(300);
    if (phase === 'fade-out') leave();
    if (phase === 'pagehide') dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    else { hidden = true; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); }
    stopped();
    hidden = false; dom.window.dispatchEvent(new dom.window.Event('pageshow')); stopped();
  });
  it('does not restart after late hidden-page play completion', async () => {
    enter(); hidden = true; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    pending[0].resolve(); await flush(); stopped();
  });
  it('recovers from autoplay rejection and repeated entry/exit', async () => {
    enter(); pending[0].reject(); await flush(); stopped();
    for (let i = 1; i < 4; i++) { enter(); pending[i].resolve(); await flush(); tick(now + 300); leave(); tick(now + 1600); stopped(); }
  });
  it('does not let an older play completion cancel a newer entry', async () => {
    enter(); leave(); enter(); pending[1].resolve(); await flush();
    pending[0].resolve(); await flush();
    expect(source.paused).toBe(false); expect(frames.size).toBe(2);
    dom.window.dispatchEvent(new dom.window.Event('pagehide')); stopped();
  });
  it('never starts the animated cursor when reduced motion is initially enabled', async () => {
    motion.matches = true; enter(); pending[0].resolve(); await flush();
    expect(source.paused).toBe(false); expect(frames.size).toBe(1);
    expect(dom.window.document.documentElement.classList.contains('is-musical')).toBe(false);
    leave(); tick(1600); stopped();
  });
  it('uses the native cursor when reduced motion changes during playback', async () => {
    enter(); pending[0].resolve(); await flush();
    expect(frames.size).toBe(2);
    motion.matches = true; motionChange();
    expect(frames.size).toBe(1);
    expect(dom.window.document.documentElement.classList.contains('is-musical')).toBe(false);
    motion.matches = false; motionChange(); expect(frames.size).toBe(2);
    dom.window.dispatchEvent(new dom.window.Event('pagehide')); stopped();
  });
});
