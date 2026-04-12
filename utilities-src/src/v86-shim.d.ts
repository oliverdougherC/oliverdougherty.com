declare module 'v86' {
  export interface V86FileSource {
    url: string;
    async?: boolean;
    size?: number;
  }

  export interface V86NetDeviceConfig {
    type?: 'ne2k' | 'virtio';
    relay_url?: string;
    id?: number;
    router_mac?: string;
    router_ip?: string;
    vm_ip?: string;
    masquerade?: boolean;
    dns_method?: 'static' | 'doh';
    doh_server?: string;
    cors_proxy?: string;
    mtu?: number;
  }

  export interface V86Options {
    screen_container?: HTMLElement;
    wasm_path?: string;
    bios?: V86FileSource;
    vga_bios?: V86FileSource;
    cdrom?: V86FileSource;
    autostart?: boolean;
    memory_size?: number;
    vga_memory_size?: number;
    boot_order?: number;
    disable_mouse?: boolean;
    disable_keyboard?: boolean;
    disable_audio?: boolean;
    network_relay_url?: string;
    net_device?: V86NetDeviceConfig;
  }

  export interface V86DownloadProgress {
    file_index: number;
    file_count: number;
    file_name: string;
    lengthComputable: boolean;
    total: number;
    loaded: number;
  }

  export class V86 {
    constructor(options: V86Options);
    add_listener(event: string, listener: (value?: unknown) => void): void;
    remove_listener(event: string, listener: (value?: unknown) => void): void;
    automatically(steps: Array<{ sleep?: number; vga_text?: string | RegExp | Array<string | RegExp>; keyboard_send?: string | number[]; call?: () => void }>): void;
    destroy(): Promise<void>;
    stop(): Promise<void>;
    run(): Promise<void>;
    restart(): void;
    keyboard_send_keys(keys: number[], delay?: number): Promise<void>;
    keyboard_send_text(text: string, delay?: number): Promise<void>;
    screen_set_scale(scaleX: number, scaleY?: number): void;
    is_running(): boolean;
    wait_until_vga_screen_contains(text: string | RegExp | Array<string | RegExp>, options?: { timeout_msec?: number }): Promise<boolean>;
  }

  export default V86;
}

declare module '*.wasm?url' {
  const url: string;
  export default url;
}
