import {
  RETRO_VM_CONFIG,
  buildRetroVmV86Options,
  isRetroVmNetworkReady,
  readRetroVmDatasetConfig,
  resolveRetroVmConfigFromDataset
} from '@utilities/retroVmConfig';

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
      vmSessionLabel: 'Custom session label',
      vmBridgeLabelOffline: 'Offline bridge copy',
      vmSupportNoteOffline: 'Offline support copy',
      vmNetworkEnabled: 'true',
      vmRelayUrl: ''
    });

    expect(config.copy.assetLabel).toBe('Custom Alpine label');
    expect(config.copy.sessionLabel).toBe('Custom session label');
    expect(config.copy.bridgeLabelOffline).toBe('Offline bridge copy');
    expect(config.copy.supportNoteOffline).toBe('Offline support copy');
    expect(config.network.enabled).toBe(true);
    expect(config.network.relayUrl).toBeNull();
    expect(isRetroVmNetworkReady(config)).toBe(false);
  });

  it('extracts only the supported VM dataset fields before config resolution', () => {
    const rawDataset = {
      vmAssetLabel: '  Custom Alpine label  ',
      vmRelayUrl: 'wss://relay.example.test/',
      vmNetworkEnabled: 'true',
      unexpectedVmField: 'ignored'
    };
    const dataset = readRetroVmDatasetConfig(rawDataset);

    expect(dataset).toEqual({
      vmAssetLabel: '  Custom Alpine label  ',
      vmSessionLabel: undefined,
      vmBridgeLabelOnline: undefined,
      vmBridgeLabelOffline: undefined,
      vmSupportNoteOnline: undefined,
      vmSupportNoteOffline: undefined,
      vmScreenBadgeOnline: undefined,
      vmScreenBadgeOffline: undefined,
      vmProgressMeta: undefined,
      vmNetworkEnabled: 'true',
      vmRelayUrl: 'wss://relay.example.test/'
    });
    expect('unexpectedVmField' in dataset).toBe(false);
  });

  it('includes net_device only when relay-backed networking is configured', () => {
    const screenContainer = { tagName: 'DIV' } as HTMLElement;
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

  it('applies optional network fields to net_device when configured', () => {
    const screenContainer = { tagName: 'DIV' } as HTMLElement;
    const config = resolveRetroVmConfigFromDataset({
      vmNetworkEnabled: 'true',
      vmRelayUrl: 'wss://relay.example.test/'
    });

    const configWithNetworkFields = {
      ...config,
      network: {
        ...config.network,
        routerMac: '52:54:00:12:34:56',
        routerIp: '192.168.76.1',
        vmIp: '192.168.76.2',
        masquerade: true,
        dnsMethod: 'doh' as const,
        dohServer: 'https://dns.google/dns-query',
        corsProxy: 'https://cors.example.com/',
        mtu: 1400
      }
    };

    const options = buildRetroVmV86Options(configWithNetworkFields, screenContainer, '/vm.wasm');
    const netDevice = options.net_device;

    expect(netDevice).toBeDefined();
    expect(netDevice?.router_mac).toBe('52:54:00:12:34:56');
    expect(netDevice?.router_ip).toBe('192.168.76.1');
    expect(netDevice?.vm_ip).toBe('192.168.76.2');
    expect(netDevice?.masquerade).toBe(true);
    expect(netDevice?.dns_method).toBe('doh');
    expect(netDevice?.doh_server).toBe('https://dns.google/dns-query');
    expect(netDevice?.cors_proxy).toBe('https://cors.example.com/');
    expect(netDevice?.mtu).toBe(1400);
  });

  it('omits optional network fields from net_device when not configured', () => {
    const screenContainer = { tagName: 'DIV' } as HTMLElement;
    const config = resolveRetroVmConfigFromDataset({
      vmNetworkEnabled: 'true',
      vmRelayUrl: 'wss://relay.example.test/'
    });

    const options = buildRetroVmV86Options(config, screenContainer, '/vm.wasm');
    const netDevice = options.net_device;

    expect(netDevice).toBeDefined();
    expect(netDevice?.router_mac).toBeUndefined();
    expect(netDevice?.router_ip).toBeUndefined();
    expect(netDevice?.vm_ip).toBeUndefined();
    expect(netDevice?.masquerade).toBeUndefined();
    expect(netDevice?.dns_method).toBeUndefined();
    expect(netDevice?.doh_server).toBeUndefined();
    expect(netDevice?.cors_proxy).toBeUndefined();
  });

  it('recognizes truthy boolean flag variants with mixed case and whitespace', () => {
    const truthyValues = ['true', 'True', 'TRUE', 'TrUe', '  true  ', '1', 'yes', 'on'];
    for (const val of truthyValues) {
      const config = resolveRetroVmConfigFromDataset({ vmNetworkEnabled: val });
      expect(config.network.enabled, `expected '${val}' to be truthy`).toBe(true);
    }
  });

  it('recognizes falsy boolean flag variants with mixed case and whitespace', () => {
    const falsyValues = ['false', 'False', 'FALSE', '0', 'no', 'off', '  false  '];
    for (const val of falsyValues) {
      const config = resolveRetroVmConfigFromDataset({ vmNetworkEnabled: val });
      expect(config.network.enabled, `expected '${val}' to be falsy`).toBe(false);
    }
  });

  it('falls back for unrecognized boolean flag values', () => {
    const unrecognizedValues = ['', '  ', 'enabled', 'disabled', 'y', 'n', 'maybe', '2'];
    for (const val of unrecognizedValues) {
      const config = resolveRetroVmConfigFromDataset({ vmNetworkEnabled: val });
      expect(config.network.enabled, `expected '${val}' to fall back`).toBe(false);
    }
  });
});
