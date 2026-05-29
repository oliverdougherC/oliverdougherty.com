import { createUtilityPerformanceController, type UtilityPerformanceEventDetail } from '@utilities/utilityPerformance';

describe('utility performance controller', () => {
  const originalWindow = globalThis.window;
  let events: UtilityPerformanceEventDetail[];
  let listeners: Array<(event: CustomEvent<UtilityPerformanceEventDetail>) => void>;

  beforeEach(() => {
    events = [];
    listeners = [];
    const testWindow = {
      dispatchEvent(event: CustomEvent<UtilityPerformanceEventDetail>) {
        events.push(event.detail);
        listeners.forEach((listener) => listener(event));
        return true;
      },
      addEventListener(_type: string, listener: (event: CustomEvent<UtilityPerformanceEventDetail>) => void) {
        listeners.push(listener);
      }
    } as unknown as Window & typeof globalThis;

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: testWindow
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow
    });
  });

  it('dispatches active and inactive settle-background states', () => {
    const controller = createUtilityPerformanceController('image-transform');
    controller.setActive(true);
    controller.setActive(false);

    expect(events).toEqual([
      {
        source: 'image-transform',
        active: true,
        mode: 'settle-background',
        pauseRendering: false
      },
      {
        source: 'image-transform',
        active: false,
        mode: 'settle-background',
        pauseRendering: false
      }
    ]);
  });

  it('does not dispatch duplicates for unchanged state', () => {
    const controller = createUtilityPerformanceController('audio-fourier');
    controller.setActive(true);
    controller.setActive(true);
    controller.setActive(false);
    controller.setActive(false);

    expect(events).toHaveLength(2);
  });

  it('preserves pause-background mode for extreme workloads', () => {
    const controller = createUtilityPerformanceController('stress-test');
    controller.setActive(true, { mode: 'pause-background' });

    expect(events).toEqual([
      {
        source: 'stress-test',
        active: true,
        mode: 'pause-background',
        pauseRendering: true
      }
    ]);
  });

  it('cleanup dispatches inactive when active', () => {
    const controller = createUtilityPerformanceController('retro-vm');
    controller.setActive(true);
    controller.cleanup();
    controller.cleanup();

    expect(events).toEqual([
      {
        source: 'retro-vm',
        active: true,
        mode: 'settle-background',
        pauseRendering: false
      },
      {
        source: 'retro-vm',
        active: false,
        mode: 'settle-background',
        pauseRendering: false
      }
    ]);
  });
});
