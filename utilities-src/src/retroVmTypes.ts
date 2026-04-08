export type RetroVmState = 'idle' | 'loading' | 'running' | 'fullscreen' | 'resetting' | 'error' | 'unsupported';

export interface RetroVmSupport {
  supported: boolean;
  reason: string;
  isMobileLike: boolean;
}

export interface RetroVmConfig {
  label: string;
  distro: string;
  biosUrl: string;
  vgaBiosUrl: string;
  cdromUrl: string;
  cdromSizeBytes: number;
  memorySize: number;
  vgaMemorySize: number;
  bootOrder: number;
  bootHintDelayMs: number;
}

export interface RetroVmProgress {
  loadedBytes: number;
  totalBytes: number | null;
}

export interface RetroVmStatusView {
  chipLabel: string;
  chipClass: string;
  statusText: string;
  progressText: string;
}
