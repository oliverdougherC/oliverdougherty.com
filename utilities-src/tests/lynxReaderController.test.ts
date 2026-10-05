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
  input('seek', '11');
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

it('keeps text editing intact but handles shortcuts after focusing controls', () => {
  expect(key('Space', el('source')).defaultPrevented).toBe(false);
  click('read');
  expect(key('Space', el('wpm')).defaultPrevented).toBe(true);
  expect(el('play').getAttribute('aria-pressed')).toBe('true');
  expect(key('ArrowRight', el('seek')).defaultPrevented).toBe(true);
  expect(el('position').textContent).toBe('30 / 30');
  expect(key('Space', el('reset')).defaultPrevented).toBe(true);
  expect(el('play').getAttribute('aria-pressed')).toBe('true');
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

it('jumps to the previous sentence from mid-sentence and the next immediate sentence', () => {
  input('source', 'First sentence here. Second sentence here. Third sentence here.'); click('read');
  input('seek', '4'); click('back');
  expect(el('position').textContent).toBe('1 / 9');
  input('seek', '4'); key('ArrowRight', el('wpm'));
  expect(el('position').textContent).toBe('7 / 9');
  input('seek', '7'); key('ArrowLeft', el('font'));
  expect(el('position').textContent).toBe('4 / 9');
  expect(el('play').getAttribute('aria-pressed')).toBe('false');
});

it('changes WPM with wheel and trackpad input, clamps, and ignores zoom and inactive views', () => {
  const wheel = (deltaY: number, extra = {}) => {
    const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...extra });
    root.dispatchEvent(event); return event;
  };
  expect(wheel(-100).defaultPrevented).toBe(false);
  click('read'); click('play'); vi.advanceTimersByTime(0);
  expect(wheel(-100).defaultPrevented).toBe(true);
  expect(el('speed').textContent).toBe('325');
  expect(el('play').getAttribute('aria-pressed')).toBe('true');
  expect(vi.getTimerCount()).toBe(1);
  wheel(20); expect(el('speed').textContent).toBe('325');
  wheel(20); expect(el('speed').textContent).toBe('300');
  wheel(-3, { deltaMode: 1 }); expect(el('speed').textContent).toBe('325');
  expect(wheel(-100, { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(wheel(-100, { deltaX: 200 }).defaultPrevented).toBe(false);
  input('wpm', '1000'); wheel(-100); expect(el('speed').textContent).toBe('1000');
  input('wpm', '100'); wheel(100); expect(el('speed').textContent).toBe('100');
  root.dispatchEvent(new Event('utility-deactivate'));
  expect(wheel(-100).defaultPrevented).toBe(false);
});

it('changes punctuation timing during playback without losing the current dwell fraction', () => {
  input('source', 'one, two. three'); click('read'); click('play');
  vi.advanceTimersByTime(50);
  input('comma', '200'); input('period', '0');
  expect(el('position').textContent).toBe('1 / 3');
  expect(el('comma-value').textContent).toBe('+200%');
  expect(el('period-value').textContent).toBe('+0%');
  expect(el('play').getAttribute('aria-pressed')).toBe('true');
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(263);
  expect(el('position').textContent).toBe('1 / 3');
  vi.advanceTimersByTime(2);
  expect(el('position').textContent).toBe('2 / 3');
});

it('updates word appearance without changing playback or position', () => {
  click('read'); click('play'); vi.advanceTimersByTime(0);
  input('size', '120');
  el<HTMLSelectElement>('font').value = 'serif'; el('font').dispatchEvent(new Event('change'));
  expect(el('word').style.fontFamily).toBe('Georgia, serif');
  expect(root.style.getPropertyValue('--lynx-word-size')).toBe('120px');
  expect(el('size-value').textContent).toBe('120 px');
  expect(el('position').textContent).toBe('1 / 30');
  expect(el('play').getAttribute('aria-pressed')).toBe('true');
  expect(vi.getTimerCount()).toBe(1);
});

it.each(['button', 'select', 'a', 'input', 'summary', 'div'])('preserves shortcuts on an external %s control', tag => {
  const external = document.createElement(tag);
  if (tag === 'a') external.setAttribute('href', '#index');
  if (tag === 'div') { external.setAttribute('role', 'button'); external.tabIndex = 0; }
  document.body.append(external);
  try {
    click('read'); input('seek', '10');
    for (const code of ['Space', 'ArrowLeft', 'ArrowRight']) expect(key(code, external).defaultPrevented).toBe(false);
    expect(el('position').textContent).toBe('11 / 30');
    expect(el('play').getAttribute('aria-pressed')).toBe('false');
    expect(key('Space', document.body).defaultPrevented).toBe(true);
    expect(el('play').getAttribute('aria-pressed')).toBe('true');
  } finally { external.remove(); }
});

it('keeps reader shortcuts available when WebKit leaves focus on the noninteractive workbench main', () => {
  const main = document.createElement('main');
  main.tabIndex = -1;
  document.body.append(main);
  try {
    click('read');
    expect(key('Space', main).defaultPrevented).toBe(true);
    expect(el('play').getAttribute('aria-pressed')).toBe('true');
  } finally { main.remove(); }
});
