import type { RetroVmConfig } from './retroVmTypes';

const MB = 1024 * 1024;

export const RETRO_VM_CONFIG: RetroVmConfig = {
  label: 'Retro VM',
  distro: 'Tiny Core Linux 11',
  biosUrl: '../../assets/utilities/vm/seabios.bin',
  vgaBiosUrl: '../../assets/utilities/vm/vgabios.bin',
  cdromUrl: '../../assets/utilities/vm/TinyCore-11.0.iso',
  cdromSizeBytes: 19_922_944,
  memorySize: 256 * MB,
  vgaMemorySize: 8 * MB,
  bootOrder: 0x132,
  bootHintDelayMs: 4000
};
