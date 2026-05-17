export interface StartCpuStressRequest {
  type: 'start-cpu-stress';
  requestId: number;
  workerIndex: number;
}

export interface StopCpuStressRequest {
  type: 'stop-cpu-stress';
  requestId?: number;
}

export type StressTestWorkerRequest = StartCpuStressRequest | StopCpuStressRequest;

export interface CpuStressHeartbeatResponse {
  type: 'cpu-stress-heartbeat';
  requestId: number;
  workerIndex: number;
  iterations: number;
  checksum: number;
}

export interface CpuStressStoppedResponse {
  type: 'cpu-stress-stopped';
  requestId: number;
  workerIndex: number;
}

export interface CpuStressErrorResponse {
  type: 'cpu-stress-error';
  requestId: number;
  workerIndex: number;
  message: string;
}

export type StressTestWorkerResponse =
  | CpuStressHeartbeatResponse
  | CpuStressStoppedResponse
  | CpuStressErrorResponse;
