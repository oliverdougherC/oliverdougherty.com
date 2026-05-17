import type { StressTestWorkerRequest, StressTestWorkerResponse } from './stressTestWorkerTypes';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

let activeRequestId = 0;
let activeWorkerIndex = 0;
let active = false;
let iterations = 0;
let checksum = 0.123456789;
let lastHeartbeat = 0;
const scheduledChunks: Array<() => void> = [];
const chunkChannel = new MessageChannel();

chunkChannel.port1.onmessage = () => {
  scheduledChunks.shift()?.();
};

function postMessage(message: StressTestWorkerResponse) {
  workerScope.postMessage(message);
}

function scheduleChunk(callback: () => void) {
  scheduledChunks.push(callback);
  chunkChannel.port2.postMessage(undefined);
}

function runChunk(requestId: number, workerIndex: number) {
  if (!active || activeRequestId !== requestId) {
    postMessage({ type: 'cpu-stress-stopped', requestId, workerIndex });
    return;
  }

  try {
    const chunkEnd = performance.now() + 90;
    while (performance.now() < chunkEnd) {
      checksum = Math.sin(checksum + iterations) * Math.cos(checksum * 1.000001) + Math.sqrt(Math.abs(checksum) + 1);
      checksum = ((checksum % 1) + 1) % 1;
      iterations += 1;
    }

    const now = performance.now();
    if (now - lastHeartbeat >= 250) {
      lastHeartbeat = now;
      postMessage({
        type: 'cpu-stress-heartbeat',
        requestId,
        workerIndex,
        iterations,
        checksum
      });
    }

    scheduleChunk(() => runChunk(requestId, workerIndex));
  } catch (error) {
    active = false;
    postMessage({
      type: 'cpu-stress-error',
      requestId,
      workerIndex,
      message: error instanceof Error ? error.message : 'CPU stress worker failed.'
    });
  }
}

function start(request: Extract<StressTestWorkerRequest, { type: 'start-cpu-stress' }>) {
  activeRequestId = request.requestId;
  activeWorkerIndex = request.workerIndex;
  active = true;
  iterations = 0;
  checksum = 0.123456789 + request.workerIndex * 0.03125;
  lastHeartbeat = 0;
  runChunk(request.requestId, request.workerIndex);
}

function stop(request: Extract<StressTestWorkerRequest, { type: 'stop-cpu-stress' }>) {
  if (request.requestId !== undefined && request.requestId !== activeRequestId) {
    return;
  }
  active = false;
  postMessage({
    type: 'cpu-stress-stopped',
    requestId: activeRequestId,
    workerIndex: activeWorkerIndex
  });
}

workerScope.onmessage = (event: MessageEvent<StressTestWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'start-cpu-stress') {
    start(request);
    return;
  }
  if (request.type === 'stop-cpu-stress') {
    stop(request);
  }
};
