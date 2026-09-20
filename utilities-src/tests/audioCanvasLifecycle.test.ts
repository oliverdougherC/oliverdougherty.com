/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { AudioFourierController } from '../src/audioFourierController';

describe('production audio canvas lifecycle', () => {
  let controller: AudioFourierController;
  let resize: ResizeObserverCallback;
  let visible: boolean;
  let supportVisible: boolean;
  let width: number;
  const context = new Proxy({}, { get: (_target, key) => key === 'measureText' ? () => ({ width: 10 }) : vi.fn() });

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = readFileSync('pages/utilities/index.html', 'utf8');
    visible = false;
    supportVisible = false;
    width = 80;
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {} disconnect() {}
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind: string) => kind === '2d' ? context as CanvasRenderingContext2D : null);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLCanvasElement) {
      const shown = visible && (this.id === 'audioFourierWaveCanvas' || supportVisible);
      return { width: shown ? width : 0, height: shown ? 30 : 0 } as DOMRect;
    });
  });
  afterEach(() => { controller?.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each([1, 2, 3])('keeps hidden initialization, resize callbacks, and return bounded at DPR %i', (dpr) => {
    vi.stubGlobal('devicePixelRatio', dpr);
    controller = new AudioFourierController(document.getElementById('audioFourierApp')!);
    controller.init();
    const wave = document.getElementById('audioFourierWaveCanvas') as HTMLCanvasElement;
    const support = document.getElementById('audioFourierSpectrumCanvas') as HTMLCanvasElement;
    const initial = [wave.width, wave.height, support.width, support.height];
    const notify = () => { resize([], {} as ResizeObserver); vi.advanceTimersByTime(20); };
    for (let i = 0; i < 15; i++) notify();
    expect([wave.width, wave.height, support.width, support.height]).toEqual(initial);
    visible = true;
    for (let i = 0; i < 12; i++) { width = 80 + i; notify(); }
    expect(wave.width).toBe(91 * Math.min(dpr, 2));
    expect(support.width).toBe(initial[2]);
    document.getElementById('audioFourierApp')!.dispatchEvent(new Event('utility-deactivate'));
    visible = false;
    for (let i = 0; i < 12; i++) notify();
    expect(wave.width).toBe(91 * Math.min(dpr, 2));
    visible = true; supportVisible = true; width = 100; notify();
    expect(wave.width).toBe(100 * Math.min(dpr, 2));
    expect(support.width).toBe(100 * dpr);
    for (let i = 0; i < 12; i++) notify();
    expect(support.width).toBe(100 * dpr);
    width = 1_000_000; notify();
    expect(support.width).toBeLessThanOrEqual(4096);
    expect(support.width * support.height).toBeLessThanOrEqual(1_000_000);
    expect(wave.width).toBeLessThanOrEqual(8192);
    expect(wave.width * wave.height).toBeLessThanOrEqual(750_000);
    width = 80; notify();
    expect(support.width).toBe(80 * dpr);
  });
});
