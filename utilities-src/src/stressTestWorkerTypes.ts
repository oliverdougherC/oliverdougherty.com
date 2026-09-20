import type { PrimeBlock } from './stressTestPrimeScheduler';

export interface StartCpuStressRequest {
  type: 'start-cpu-stress';
  requestId: number;
  workerIndex: number;
  blocks: PrimeBlock[];
  exhausted: boolean;
}

export interface SupplyCpuStressWorkRequest {
  type: 'supply-cpu-stress-work';
  requestId: number;
  workerIndex: number;
  supplyId: number;
  blocks: PrimeBlock[];
  exhausted: boolean;
}

export interface StopCpuStressRequest {
  type: 'stop-cpu-stress';
  requestId?: number;
  workerIndex?: number;
}

export type StressTestWorkerRequest = StartCpuStressRequest | SupplyCpuStressWorkRequest | StopCpuStressRequest;

export interface CpuStressHeartbeatResponse {
  type: 'cpu-stress-heartbeat';
  requestId: number;
  workerIndex: number;
  iterations: number;
  checksum: number;
  latestPrime: number;
  primesFound: number;
}

export interface CpuStressWorkRequestResponse {
  type: 'cpu-stress-work-request';
  requestId: number;
  workerIndex: number;
  supplyId: number;
  count: number;
}

export interface CpuStressStoppedResponse {
  type: 'cpu-stress-stopped' | 'cpu-stress-exhausted';
  requestId: number;
  workerIndex: number;
}

export interface CpuStressErrorResponse {
  type: 'cpu-stress-error';
  requestId: number;
  workerIndex: number;
  message: string;
}

export type StressTestWorkerResponse = CpuStressHeartbeatResponse | CpuStressWorkRequestResponse
  | CpuStressStoppedResponse | CpuStressErrorResponse;
