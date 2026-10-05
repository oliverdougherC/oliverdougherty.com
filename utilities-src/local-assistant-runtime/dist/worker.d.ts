/**
 * Module code will be copied into worker.
 *
 * Messages between main <==> worker:
 *
 * From main thread to worker:
 * - Send direction: { verb, args, callbackId }
 * - Result direction: { callbackId, result } or { callbackId, err }
 *
 * Signal from worker to main:
 * - Unidirection: { verb, args }
 */
import type { GlueMsg } from './glue/messages';
interface Logger {
    debug: typeof console.debug;
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
}
interface TaskParam {
    verb: 'module.init' | 'fs.alloc' | 'fs.write' | 'fs.read_res' | 'wllama.start' | 'wllama.action' | 'wllama.exit' | 'wllama.debug';
    args: any[];
    callbackId: number;
}
interface Task {
    resolve: any;
    reject: any;
    param: TaskParam;
    buffers?: ArrayBuffer[] | undefined;
}
export interface WllamaWorkerResources {
    wasmPath: string;
    jsPath?: string | {
        code: string;
    } | undefined;
    compat: boolean;
    noWebGPU?: boolean;
}
export declare class ProxyToWorker {
    resources: WllamaWorkerResources;
    logger: Logger;
    suppressNativeLog: boolean;
    taskQueue: Task[];
    taskId: number;
    resultQueue: Task[];
    busy: boolean;
    disposed: boolean;
    private terminalError;
    worker?: Worker | undefined;
    multiThread: boolean;
    nbThread: number;
    useAsyncFile: boolean;
    fileBlobs: Map<string, Blob>;
    constructor(resources: WllamaWorkerResources, nbThread: number, suppressNativeLog: boolean, logger: Logger);
    isTerminated(): boolean;
    getModuleCode(): Promise<string>;
    moduleInit(ggufFiles: {
        name: string;
        blob: Blob;
    }[]): Promise<void>;
    wllamaStart(): Promise<number>;
    wllamaAction<T extends GlueMsg>(name: string, body: GlueMsg): Promise<T>;
    wllamaExit(): Promise<void>;
    wllamaDebug(): Promise<any>;
    /**
     * Allocate a new file in heapfs
     * @returns fileId, to be used by fileWrite()
     */
    private fileAlloc;
    /**
     * Write a Blob to heapfs
     */
    private fileWrite;
    private fileReadResponse;
    /**
     * Parse JSON result returned by cpp code.
     * Throw new Error if "__exception" is present in the response
     *
     * TODO: get rid of this function once everything is migrated to Glue
     */
    private parseResult;
    /**
     * Push a new task to taskQueue
     */
    private pushTask;
    /**
     * Main loop for processing tasks
     */
    private runTaskLoop;
    /**
     * Handle messages from worker
     */
    private onRecvMsg;
    private abort;
}
export {};
