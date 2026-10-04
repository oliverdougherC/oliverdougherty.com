/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LynxReaderController } from '../src/lynxReaderController';

let root: HTMLElement;
let controller: LynxReaderController;
const el = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector<T>(`[data-lynx-${name}]`)!;
const click = (name: string) => el<HTMLButtonElement>(name).click();
function input(name: string, value: string) { el<HTMLInputElement>(name).value = value; el(name).dispatchEvent(new Event('input')); }
function key(code: string, target: HTMLElement = el('display')) { const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }); target.dispatchEvent(event); return event; }
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  root = document.createElement('section');
  document.body.append(root);
  controller = new LynxReaderController(root);
  controller.init();
  input('source', Array.from({ length: 30 }, (_, i) => `word${i}`).join(' '));
});
afterEach(() => { controller.destroy(); root.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('starts paused, resumes exactly the displayed word and seeks with clamping', () => {
  click('read');
  expect(el('position').textContent).toBe('1 / 30');
  vi.advanceTimersByTime(1000);
  expect(el('position').textContent).toBe('1 / 30');
  expect(key('Space').defaultPrevented).toBe(true);
  vi.advanceTimersByTime(201);
  expect(el('position').textContent).toBe('2 / 30');
  click('forward');
  expect(el('position').textContent).toBe('12 / 30');
  vi.advanceTimersByTime(1000);
  expect(el('position').textContent).toBe('12 / 30');
  click('play');
  vi.advanceTimersByTime(100);
  expect(el('position').textContent).toBe('12 / 30');
  input('seek', '29');
  click('forward');
  expect(el('position').textContent).toBe('30 / 30');
  click('reset'); click('back');
  expect(el('position').textContent).toBe('1 / 30');
});

it('applies WPM changes to the remaining dwell without changing position', () => {
  click('read'); click('play');
  vi.advanceTimersByTime(100);
  input('wpm', '600');
  expect(el('position').textContent).toBe('1 / 30');
  vi.advanceTimersByTime(51);
  expect(el('position').textContent).toBe('2 / 30');
  expect(el('play').getAttribute('aria-pressed')).toBe('true');
});

it('invalidates rapid state changes and preserves state while deactivated', () => {
  click('read');
  for (let i = 0; i < 10; i++) { click('play'); click('reset'); }
  input('seek', '12'); input('wpm', '450'); click('play');
  root.dispatchEvent(new Event('utility-deactivate'));
  vi.advanceTimersByTime(5000);
  key('Space');
  root.dispatchEvent(new Event('utility-activate'));
  controller.init();
  expect(el('position').textContent).toBe('13 / 30');
  expect(el('speed').textContent).toBe('450');
  expect(el('play').getAttribute('aria-pressed')).toBe('false');
  expect(vi.getTimerCount()).toBe(0);
  click('play'); expect(vi.getTimerCount()).toBe(1);
  click('edit'); vi.advanceTimersByTime(2000);
  expect(el('position').textContent).toBe('13 / 30');
  expect(el('play').getAttribute('aria-pressed')).toBe('false');
  expect(el<HTMLTextAreaElement>('source').value).toContain('word0');
});

it('keeps editing and native control keyboard events intact', () => {
  expect(key('Space', el('source')).defaultPrevented).toBe(false);
  click('read');
  expect(key('Space', el('wpm')).defaultPrevented).toBe(false);
  expect(key('ArrowRight', el('seek')).defaultPrevented).toBe(false);
  expect(key('Space', el('reset')).defaultPrevented).toBe(false);
  expect(el('play').getAttribute('aria-pressed')).toBe('false');
});

it('holds the final word for its dwell, finishes, and can replay or reset', () => {
  input('source', 'Only'); click('read'); click('play');
  vi.advanceTimersByTime(199);
  expect(el('status').textContent).toBe('Reading');
  vi.advanceTimersByTime(1);
  expect(el('status').textContent).toBe('Finished');
  expect(vi.getTimerCount()).toBe(0);
  click('play'); expect(el('status').textContent).toBe('Reading');
  click('reset'); expect(el('status').textContent).toBe('Paused');
});
