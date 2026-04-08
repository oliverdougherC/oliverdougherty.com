export type RetroVmState = 'idle' | 'loading' | 'running' | 'fullscreen' | 'resetting' | 'error' | 'unsupported';
export type RetroVmNicType = 'ne2k' | 'virtio';
export type RetroVmDnsMethod = 'static' | 'doh';

export interface RetroVmSupport {
  supported: boolean;
  reason: string;
  isMobileLike: boolean;
}

export interface RetroVmNetworkConfig {
  enabled: boolean;
  relayUrl: string | null;
  nicType: RetroVmNicType;
  id: number;
  routerMac?: string;
  routerIp?: string;
  vmIp?: string;
  masquerade?: boolean;
  dnsMethod?: RetroVmDnsMethod;
  dohServer?: string;
  corsProxy?: string;
  mtu?: number;
}

export interface RetroVmCopyConfig {
  assetLabel: string;
  sessionLabel: string;
  bridgeLabelOnline: string;
  bridgeLabelOffline: string;
  supportNoteOnline: string;
  supportNoteOffline: string;
  screenBadgeOnline: string;
  screenBadgeOffline: string;
  progressMeta: string;
}

export interface RetroVmConfig {
  label: string;
  distro: string;
  guestName: string;
  biosUrl: string;
  vgaBiosUrl: string;
  cdromUrl: string;
  cdromSizeBytes: number | null;
  memorySize: number;
  vgaMemorySize: number;
  bootOrder: number;
  bootHintDelayMs: number;
  bootMenuPrompt: RegExp | null;
  copy: RetroVmCopyConfig;
  network: RetroVmNetworkConfig;
}

export interface RetroVmDatasetConfig {
  vmAssetLabel?: string;
  vmSessionLabel?: string;
  vmBridgeLabelOnline?: string;
  vmBridgeLabelOffline?: string;
  vmSupportNoteOnline?: string;
  vmSupportNoteOffline?: string;
  vmScreenBadgeOnline?: string;
  vmScreenBadgeOffline?: string;
  vmProgressMeta?: string;
  vmNetworkEnabled?: string;
  vmRelayUrl?: string;
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
