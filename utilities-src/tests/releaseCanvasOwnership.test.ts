import { StressTestController } from '../src/stressTestController';

// Exercise the real sizing boundary with small backing-store stand-ins. The
// controller/backend integration suite separately exercises queued GPU work.
interface SizingReceiver {
  gpu: object | null;
  gpuSurfaceClaim: number;
  requestId: number;
  canvas: { width: number; height: number; getBoundingClientRect(): { width: number; height: number } };
}
const resize = Reflect.get(StressTestController.prototype, 'syncCanvasSize') as (this: SizingReceiver) => void;

describe('release canvas ownership boundary', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    { claim: 0, request: 0, expected: [160, 60], label: 'initial idle' },
    { claim: 1, request: 1, expected: [11, 7], label: 'GPU startup' },
    { claim: 0, request: 2, expected: [160, 60], label: 'released after stop' }
  ])('sizes only controller-owned surfaces: $label', ({ claim, request, expected }) => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const receiver: SizingReceiver = {
      gpu: null, gpuSurfaceClaim: claim, requestId: request,
      canvas: { width: 11, height: 7, getBoundingClientRect: () => ({ width: 80, height: 30 }) }
    };
    resize.call(receiver);
    expect([receiver.canvas.width, receiver.canvas.height]).toEqual(expected);
  });
});
