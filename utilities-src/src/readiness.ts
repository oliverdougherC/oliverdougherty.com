/** Readiness contract shared by the utilities entry and the workbench shell (issue #42). */

export type ReadinessReason = 'initialized' | 'deadline' | 'init-failed' | 'import-failed';

export type ReadinessRetryMode = 'none' | 'retry' | 'reload';

export interface ReadinessDetail {
  utilityId: string;
  reason: ReadinessReason;
  retryable: boolean;
  retryMode: ReadinessRetryMode;
  message: string;
}