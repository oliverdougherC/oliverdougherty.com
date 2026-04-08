import type { V86Options } from 'v86';
import type { RetroVmConfig, RetroVmDatasetConfig } from './retroVmTypes';

const MB = 1024 * 1024;

export const RETRO_VM_CONFIG: RetroVmConfig = {
  label: 'Retro VM',
  distro: 'Tiny Core Linux 11',
  guestName: 'Tiny Core',
  biosUrl: '../../assets/utilities/vm/seabios.bin',
  vgaBiosUrl: '../../assets/utilities/vm/vgabios.bin',
  cdromUrl: '../../assets/utilities/vm/tinycore-retro-vm.iso',
  cdromSizeBytes: 20_082_688,
  memorySize: 256 * MB,
  vgaMemorySize: 8 * MB,
  bootOrder: 0x132,
  bootHintDelayMs: 4000,
  bootMenuPrompt: /Press ENTER to boot/i,
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
    progressMeta: 'Remastered Tiny Core 11 guest · retro desktop utility'
  },
  network: {
    enabled: false,
    relayUrl: null,
    nicType: 'ne2k',
    id: 0,
    mtu: 1500
  }
};

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

export function resolveRetroVmConfigFromDataset(dataset: RetroVmDatasetConfig = {}): RetroVmConfig {
  return {
    ...RETRO_VM_CONFIG,
    copy: {
      ...RETRO_VM_CONFIG.copy,
      assetLabel: dataset.vmAssetLabel?.trim() || RETRO_VM_CONFIG.copy.assetLabel,
      sessionLabel: dataset.vmSessionLabel?.trim() || RETRO_VM_CONFIG.copy.sessionLabel,
      bridgeLabelOnline: dataset.vmBridgeLabelOnline?.trim() || RETRO_VM_CONFIG.copy.bridgeLabelOnline,
      bridgeLabelOffline: dataset.vmBridgeLabelOffline?.trim() || RETRO_VM_CONFIG.copy.bridgeLabelOffline,
      supportNoteOnline: dataset.vmSupportNoteOnline?.trim() || RETRO_VM_CONFIG.copy.supportNoteOnline,
      supportNoteOffline: dataset.vmSupportNoteOffline?.trim() || RETRO_VM_CONFIG.copy.supportNoteOffline,
      screenBadgeOnline: dataset.vmScreenBadgeOnline?.trim() || RETRO_VM_CONFIG.copy.screenBadgeOnline,
      screenBadgeOffline: dataset.vmScreenBadgeOffline?.trim() || RETRO_VM_CONFIG.copy.screenBadgeOffline,
      progressMeta: dataset.vmProgressMeta?.trim() || RETRO_VM_CONFIG.copy.progressMeta
    },
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
