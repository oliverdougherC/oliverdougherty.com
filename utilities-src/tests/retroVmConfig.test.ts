import { RETRO_VM_CONFIG, buildRetroVmV86Options, isRetroVmNetworkReady, resolveRetroVmConfigFromDataset } from '@utilities/retroVmConfig';

describe('retro VM config', () => {
  it('defaults to the Tiny Core offline-first rollback profile', () => {
    expect(RETRO_VM_CONFIG.distro).toBe('Tiny Core Linux 11');
    expect(RETRO_VM_CONFIG.guestName).toBe('Tiny Core');
    expect(RETRO_VM_CONFIG.network.enabled).toBe(false);
    expect(RETRO_VM_CONFIG.bootOrder).toBe(0x210);
    expect(RETRO_VM_CONFIG.copy.assetLabel).toMatch(/Tiny Core Linux 11/i);
    expect(RETRO_VM_CONFIG.copy.screenBadgeOffline).toMatch(/Local only/i);
  });

  it('maps dataset overrides into runtime copy and offline network state', () => {
    const config = resolveRetroVmConfigFromDataset({
      vmAssetLabel: 'Custom Alpine label',
      vmBridgeLabelOffline: 'Offline bridge copy',
      vmSupportNoteOffline: 'Offline support copy',
      vmNetworkEnabled: 'true',
      vmRelayUrl: ''
    });

    expect(config.copy.assetLabel).toBe('Custom Alpine label');
    expect(config.copy.bridgeLabelOffline).toBe('Offline bridge copy');
    expect(config.copy.supportNoteOffline).toBe('Offline support copy');
    expect(config.network.enabled).toBe(true);
    expect(config.network.relayUrl).toBeNull();
    expect(isRetroVmNetworkReady(config)).toBe(false);
  });

  it('includes net_device only when relay-backed networking is configured', () => {
    const screenContainer = {} as HTMLElement;
    const offlineConfig = resolveRetroVmConfigFromDataset({
      vmNetworkEnabled: 'true',
      vmRelayUrl: ''
    });
    const offlineOptions = buildRetroVmV86Options(offlineConfig, screenContainer, '/vm.wasm');
    expect(offlineOptions.net_device).toBeUndefined();
    expect(offlineOptions.boot_order).toBe(0x210);

    const onlineConfig = resolveRetroVmConfigFromDataset({
      vmNetworkEnabled: 'true',
      vmRelayUrl: 'wss://relay.example.test/'
    });
    const onlineOptions = buildRetroVmV86Options(onlineConfig, screenContainer, '/vm.wasm');

    expect(onlineOptions.net_device).toMatchObject({
      type: 'ne2k',
      relay_url: 'wss://relay.example.test/'
    });
  });
});
