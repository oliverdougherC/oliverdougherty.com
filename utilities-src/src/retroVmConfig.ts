import type { V86Options } from 'v86';
import type { RetroVmConfig, RetroVmCopyConfig, RetroVmDatasetConfig } from './retroVmTypes';

const MB = 1024 * 1024;

/** Guest OS name + version (shown in progress meta; keep in sync with ISO). */
const RETRO_VM_DISTRO = 'Tiny Core Linux 11';

export const RETRO_VM_CONFIG: RetroVmConfig = {
  label: 'Retro VM',
  distro: RETRO_VM_DISTRO,
  guestName: 'Tiny Core',
  biosUrl: '../../assets/utilities/vm/seabios.bin',
  vgaBiosUrl: '../../assets/utilities/vm/vgabios.bin',
  cdromUrl: '../../assets/utilities/vm/tinycore-retro-vm.iso',
  cdromSizeBytes: 20_082_688,
  memorySize: 256 * MB,
  vgaMemorySize: 8 * MB,
  // SeaBIOS boot-order bit layout: CD-ROM first, then disk fallback.
  bootOrder: 0x210,
  bootHintDelayMs: 4000,
  bootMenuPrompt: /Press ENTER to boot/i,
  maxClipboardPasteChars: 2048,
  copy: {
    assetLabel: 'Tiny Core Linux 11 · 20 MB remastered retro ISO',
    sessionLabel: 'Ephemeral per tab · clean boot every launch',
    bridgeLabelOnline: 'Clipboard paste + experimental relay hook',
    bridgeLabelOffline: 'Clipboard paste only · offline-first rollback',
    supportNoteOnline:
      'Desktop browser recommended. Click into the VM screen to capture the mouse. Press Escape to release it, or to exit fullscreen. Relay-backed networking remains experimental.',
    supportNoteOffline:
      'Desktop browser recommended. Click into the VM screen to capture the mouse. Press Escape to release it, or to exit fullscreen. This Tiny Core rollback is offline-first.',
    screenBadgeOnline: 'Experimental relay',
    screenBadgeOffline: 'Local only',
    progressMeta: RETRO_VM_DISTRO
  },
  network: {
    // Relay-backed networking is intentionally dormant until a relay URL is configured.
    enabled: false,
    relayUrl: null,
    nicType: 'ne2k',
    id: 0,
    mtu: 1500
  }
};

const RETRO_VM_COPY_DATASET_FIELDS = {
  vmAssetLabel: 'assetLabel',
  vmSessionLabel: 'sessionLabel',
  vmBridgeLabelOnline: 'bridgeLabelOnline',
  vmBridgeLabelOffline: 'bridgeLabelOffline',
  vmSupportNoteOnline: 'supportNoteOnline',
  vmSupportNoteOffline: 'supportNoteOffline',
  vmScreenBadgeOnline: 'screenBadgeOnline',
  vmScreenBadgeOffline: 'screenBadgeOffline',
  vmProgressMeta: 'progressMeta'
} as const satisfies Record<keyof Omit<RetroVmDatasetConfig, 'vmNetworkEnabled' | 'vmRelayUrl'>, keyof RetroVmCopyConfig>;

function parseBooleanFlag(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function parseRelayUrl(value: string | undefined, fallback: string | null) {
  if (value === undefined) {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function applyRetroVmCopyOverrides(dataset: RetroVmDatasetConfig, fallback: RetroVmCopyConfig) {
  const copy: RetroVmCopyConfig = { ...fallback };

  for (const datasetKey of Object.keys(RETRO_VM_COPY_DATASET_FIELDS) as Array<keyof typeof RETRO_VM_COPY_DATASET_FIELDS>) {
    const nextValue = dataset[datasetKey]?.trim();
    if (nextValue) {
      copy[RETRO_VM_COPY_DATASET_FIELDS[datasetKey]] = nextValue;
    }
  }

  return copy;
}

export function readRetroVmDatasetConfig(
  dataset: Partial<Record<keyof RetroVmDatasetConfig, string | undefined>> = {}
): RetroVmDatasetConfig {
  return {
    vmAssetLabel: dataset.vmAssetLabel,
    vmSessionLabel: dataset.vmSessionLabel,
    vmBridgeLabelOnline: dataset.vmBridgeLabelOnline,
    vmBridgeLabelOffline: dataset.vmBridgeLabelOffline,
    vmSupportNoteOnline: dataset.vmSupportNoteOnline,
    vmSupportNoteOffline: dataset.vmSupportNoteOffline,
    vmScreenBadgeOnline: dataset.vmScreenBadgeOnline,
    vmScreenBadgeOffline: dataset.vmScreenBadgeOffline,
    vmProgressMeta: dataset.vmProgressMeta,
    vmNetworkEnabled: dataset.vmNetworkEnabled,
    vmRelayUrl: dataset.vmRelayUrl
  };
}

export function resolveRetroVmConfigFromDataset(dataset: RetroVmDatasetConfig = {}): RetroVmConfig {
  return {
    ...RETRO_VM_CONFIG,
    copy: applyRetroVmCopyOverrides(dataset, RETRO_VM_CONFIG.copy),
    network: {
      ...RETRO_VM_CONFIG.network,
      enabled: parseBooleanFlag(dataset.vmNetworkEnabled, RETRO_VM_CONFIG.network.enabled),
      relayUrl: parseRelayUrl(dataset.vmRelayUrl, RETRO_VM_CONFIG.network.relayUrl)
    }
  };
}

export function isRetroVmNetworkReady(config: RetroVmConfig) {
  return config.network.enabled && Boolean(config.network.relayUrl);
}

export function buildRetroVmV86Options(
  config: RetroVmConfig,
  screenContainer: HTMLElement,
  wasmPath: string
): V86Options {
  const options: V86Options = {
    screen_container: screenContainer,
    wasm_path: wasmPath,
    bios: { url: config.biosUrl },
    vga_bios: { url: config.vgaBiosUrl },
    cdrom: config.cdromSizeBytes
      ? { url: config.cdromUrl, size: config.cdromSizeBytes }
      : { url: config.cdromUrl },
    autostart: true,
    memory_size: config.memorySize,
    vga_memory_size: config.vgaMemorySize,
    boot_order: config.bootOrder,
    disable_mouse: true
  };

  if (isRetroVmNetworkReady(config)) {
    options.net_device = {
      type: config.network.nicType,
      relay_url: config.network.relayUrl ?? undefined,
      id: config.network.id,
      router_mac: config.network.routerMac,
      router_ip: config.network.routerIp,
      vm_ip: config.network.vmIp,
      masquerade: config.network.masquerade,
      dns_method: config.network.dnsMethod,
      doh_server: config.network.dohServer,
      cors_proxy: config.network.corsProxy,
      mtu: config.network.mtu
    };
  }

  return options;
}
