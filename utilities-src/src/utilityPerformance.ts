export type UtilityPerformanceMode = 'settle-background' | 'pause-background';

export interface UtilityPerformanceStateOptions {
  mode?: UtilityPerformanceMode;
}

export interface UtilityPerformanceEventDetail {
  source: string;
  active: boolean;
  mode: UtilityPerformanceMode;
  pauseRendering: boolean;
}

export interface UtilityPerformanceController {
  setActive(active: boolean, options?: UtilityPerformanceStateOptions): void;
  cleanup(): void;
}

const DEFAULT_MODE: UtilityPerformanceMode = 'settle-background';

function resolveMode(mode: UtilityPerformanceMode | undefined): UtilityPerformanceMode {
  return mode === 'pause-background' ? 'pause-background' : DEFAULT_MODE;
}

function dispatchUtilityPerformanceState(
  source: string,
  active: boolean,
  mode: UtilityPerformanceMode
) {
  window.dispatchEvent(new CustomEvent<UtilityPerformanceEventDetail>('utilities-load-state', {
    detail: {
      source,
      active,
      mode,
      pauseRendering: mode === 'pause-background'
    }
  }));
}

export function createUtilityPerformanceController(source: string): UtilityPerformanceController {
  let active = false;
  let currentMode: UtilityPerformanceMode = DEFAULT_MODE;

  return {
    setActive(nextActive: boolean, options: UtilityPerformanceStateOptions = {}) {
      const nextMode = resolveMode(options.mode);
      if (active === nextActive && currentMode === nextMode) {
        return;
      }

      active = nextActive;
      currentMode = nextMode;
      dispatchUtilityPerformanceState(source, active, currentMode);
    },

    cleanup() {
      if (!active) {
        return;
      }

      active = false;
      dispatchUtilityPerformanceState(source, false, currentMode);
    }
  };
}

declare global {
  interface Window {
    createUtilityPerformanceController?: typeof createUtilityPerformanceController;
  }
}

if (typeof window !== 'undefined') {
  window.createUtilityPerformanceController = createUtilityPerformanceController;
}
