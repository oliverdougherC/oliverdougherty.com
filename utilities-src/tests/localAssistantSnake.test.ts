/** @vitest-environment jsdom */
import { SnakeGame } from '../src/local-assistant/snake';

describe('loading-screen Snake', () => {
  let canvas: HTMLCanvasElement;
  let game: SnakeGame;
  let draw: ReturnType<typeof vi.fn>;
  let label: ReturnType<typeof vi.fn>;
  let resize: ResizeObserverCallback;
  let disconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    draw = vi.fn();
    label = vi.fn();
    disconnect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: draw, fillText: label } as unknown as CanvasRenderingContext2D);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    document.body.innerHTML = '<canvas></canvas><input>';
    canvas = document.querySelector('canvas')!;
  });
  afterEach(() => { game?.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  function key(value: string, target: HTMLElement = document.body): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  it('runs only while started and releases timers, observers, and keyboard handling', () => {
    game = new SnakeGame(canvas);
    expect(vi.getTimerCount()).toBe(0);
    game.start();
    game.start();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(120);
    expect(draw).toHaveBeenCalled();
    game.stop();
    expect(key('ArrowUp').defaultPrevented).toBe(false);
    const count = draw.mock.calls.length;
    vi.advanceTimersByTime(5000);
    resize([], {} as ResizeObserver);
    expect(draw.mock.calls).toHaveLength(count);
    game.start();
    expect(vi.getTimerCount()).toBe(1);
    game.destroy();
    expect(vi.getTimerCount()).toBe(0);
    canvas.focus();
    expect(key('ArrowUp').defaultPrevented).toBe(false);
    expect(disconnect).toHaveBeenCalled();
  });

  it('captures movement globally only during play and leaves editable fields and navigation keys alone', () => {
    game = new SnakeGame(canvas);
    game.start();
    const input = document.querySelector('input')!;
    input.focus();
    expect(key('ArrowUp', input).defaultPrevented).toBe(false);
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.setAttribute('contenteditable', 'true');
    document.body.append(editor);
    expect(key('W', editor).defaultPrevented).toBe(false);
    expect(key('ArrowUp').defaultPrevented).toBe(true);
    expect(key('W').defaultPrevented).toBe(true);
    expect(key('Tab').defaultPrevented).toBe(false);
    expect(key('Escape').defaultPrevented).toBe(false);
    expect(key(' ').defaultPrevented).toBe(false);
    expect(key('Enter').defaultPrevented).toBe(false);
    game.stop();
    expect(key('ArrowUp').defaultPrevented).toBe(false);
    expect(key('w').defaultPrevented).toBe(false);
  });

  it('rejects immediate reversal even when two directions arrive before a tick', () => {
    game = new SnakeGame(canvas);
    game.start();
    canvas.focus();
    key('ArrowUp');
    key('ArrowLeft');
    vi.advanceTimersByTime(120);
    expect(label).not.toHaveBeenCalled();
    // The accepted up turn moves to (7, 9), not into the neck at (6, 10).
    expect(draw).toHaveBeenCalledWith(7 * 16 + 1, 9 * 16 + 1, 14, 14);
  });

  it('stops after death and restarts only with Space or Enter from anywhere', () => {
    const score = vi.fn();
    game = new SnakeGame(canvas, score);
    game.start();
    vi.advanceTimersByTime(2000);
    expect(label).toHaveBeenCalledWith('Game over', expect.any(Number), expect.any(Number));
    expect(vi.getTimerCount()).toBe(0);
    expect(key('ArrowUp').defaultPrevented).toBe(false);
    expect(score).toHaveBeenCalledTimes(1);
    key('Enter');
    expect(score).toHaveBeenLastCalledWith(0);
    expect(score).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(key(' ').defaultPrevented).toBe(true);
    expect(score).toHaveBeenCalledTimes(3);
  });

  it.each(['Enter', ' '])('preserves %j activation on external controls after death', (restartKey) => {
    document.body.innerHTML = '<div id="game"><canvas></canvas><button id="pause">Resume</button></div><button id="chat"><span>Enter chat</span></button><a href="#index">Index</a><select><option>Mode</option></select>';
    canvas = document.querySelector('canvas')!;
    const score = vi.fn();
    game = new SnakeGame(canvas, score);
    game.start();
    vi.advanceTimersByTime(2000);
    for (const control of document.querySelectorAll<HTMLElement>('#chat span, a, select')) {
      expect(key(restartKey, control).defaultPrevented).toBe(false);
      expect(score).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
    expect(key(restartKey, document.querySelector<HTMLElement>('#pause')!).defaultPrevented).toBe(true);
    expect(score).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('scores food and resizes the canvas without resetting the game', () => {
    // First free slot at (8, 10), directly in front of the initial head.
    vi.spyOn(Math, 'random').mockReturnValue((205 + 0.5) / 397);
    const score = vi.fn();
    game = new SnakeGame(canvas, score);
    game.start();
    vi.advanceTimersByTime(120);
    expect(score).toHaveBeenLastCalledWith(1);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ width: 240 } as DOMRect);
    vi.stubGlobal('devicePixelRatio', 2);
    resize([], {} as ResizeObserver);
    expect(canvas.width).toBe(480);
    expect(canvas.height).toBe(480);
    expect(score).toHaveBeenCalledTimes(2);
  });

  it.each([{ width: 420, height: 90 }, { width: 180, height: 70 }, { width: 620, height: 500 }, { width: 1000, height: 1800 }])('keeps cells square on a $width × $height board', ({ width, height }) => {
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ width, height } as DOMRect);
    vi.stubGlobal('devicePixelRatio', 2);
    game = new SnakeGame(canvas);
    game.start();
    expect(canvas.width).toBe(width * 2);
    expect(canvas.height).toBe(height * 2);
    expect(draw.mock.calls[0]).toEqual([0, 0, width * 2, height * 2]);
    const cells = draw.mock.calls.slice(1);
    expect(cells).toHaveLength(4);
    for (const [x, y, cellWidth, cellHeight] of cells) {
      expect(cellWidth).toBe(cellHeight);
      expect(cellWidth).toBeGreaterThan(4);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + cellWidth).toBeLessThanOrEqual(width * 2);
      expect(y + cellHeight).toBeLessThanOrEqual(height * 2);
    }
    vi.advanceTimersByTime(5000);
    expect(label).toHaveBeenCalledWith('Game over', width, height - 6);
    expect(canvas.getContext('2d')?.font).toBe('24px system-ui');
  });

  it('preserves the whole body and score through expansions and narrow resizes', () => {
    let width = 420;
    vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 90 } as DOMRect));
    const score = vi.fn();
    const reset = vi.fn();
    canvas.addEventListener('snake-reset', reset);
    game = new SnakeGame(canvas, score);
    game.start();
    vi.advanceTimersByTime(120 * 10);
    width = 620;
    resize([], {} as ResizeObserver);
    expect(reset).not.toHaveBeenCalled();
    expect(score).toHaveBeenCalledTimes(1);
    width = 180;
    draw.mockClear();
    resize([], {} as ResizeObserver);
    expect(reset).not.toHaveBeenCalled();
    expect(score).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls).toHaveLength(5);
    for (const [x, y, cellWidth, cellHeight] of draw.mock.calls.slice(1)) {
      expect(cellWidth).toBe(cellHeight);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + cellWidth).toBeLessThanOrEqual(180);
      expect(y + cellHeight).toBeLessThanOrEqual(90);
    }
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(120);
    expect(label).not.toHaveBeenCalled();
  });

  it('scales a long earned snake intact when its body cannot fit the preferred narrow grid', () => {
    let foodPlacement = 0;
    // Repeatedly place food directly ahead of the snake along the same row.
    vi.spyOn(Math, 'random').mockImplementation(() => 205.5 / (397 - foodPlacement++));
    let width = 320;
    vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 320 } as DOMRect));
    const score = vi.fn();
    game = new SnakeGame(canvas, score);
    game.start();
    vi.advanceTimersByTime(1200);
    expect(score).toHaveBeenLastCalledWith(10);
    const scoreUpdates = score.mock.calls.length;
    width = 90;
    draw.mockClear();
    resize([], {} as ResizeObserver);
    // One background, one food, all thirteen earned body segments.
    expect(draw.mock.calls).toHaveLength(15);
    expect(score).toHaveBeenCalledTimes(scoreUpdates);
    const body = draw.mock.calls.slice(2);
    for (const [x, y, cellWidth, cellHeight] of body) {
      expect(cellWidth).toBe(cellHeight);
      expect(cellWidth).toBeGreaterThan(0);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + cellWidth).toBeLessThanOrEqual(90);
      expect(y + cellHeight).toBeLessThanOrEqual(320);
    }
    const gap = body[0][0] - body[1][0];
    for (let i = 1; i < body.length; i++) {
      expect(body[i - 1][0] - body[i][0]).toBeCloseTo(gap);
      expect(body[i][1]).toBe(body[0][1]);
    }
    vi.advanceTimersByTime(120);
    expect(label).not.toHaveBeenCalled();
    expect(score).toHaveBeenLastCalledWith(10);
  });
});
