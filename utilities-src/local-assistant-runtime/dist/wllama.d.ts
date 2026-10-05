/// <reference types="node" />
/// <reference types="node" />
import { type WllamaWorkerResources } from './worker';
import CacheManager, { type DownloadOptions } from './cache-manager';
import { ModelManager, Model, type ModelSource } from './model-manager';
import type { LoadedContextInfo, LoadModelParams, StreamParams } from './types/types';
import type { ChatCompletionChunk, ChatCompletionParams, ChatCompletionResponse, CreateEmbeddingResponse, EmbeddingCreateParams, RawCompletionChunk, RawCompletionParams, RawCompletionResponse, RerankParams, RerankResponse, SystemOneParams, SystemOneResponse } from './types/oai-compat';
import { type HuggingFaceParams } from './huggingface';
export interface WllamaLogger {
    debug: typeof console.debug;
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
}
export interface WllamaConfig {
    /**
     * If true, suppress all log messages from native CPP code
     */
    suppressNativeLog?: boolean;
    /**
     * Custom logger functions
     */
    logger?: WllamaLogger;
    /**
     * Maximum number of parallel files to be downloaded
     *
     * Default: parallelDownloads = 3
     */
    parallelDownloads?: number;
    /**
     * Allow offline mode. If true, the model will be loaded from cache if it's available.
     *
     * Default: allowOffline = false
     */
    allowOffline?: boolean;
    /**
     * Custom cache manager (only for advanced usage)
     */
    cacheManager?: CacheManager;
    /**
     * Custom model manager (only for advanced usage)
     */
    modelManager?: ModelManager;
}
export interface WllamaChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface AssetsPathConfig {
    default: string;
    'single-thread/wllama.wasm'?: string;
    'multi-thread/wllama.wasm'?: string;
}
export interface ModelMetadata {
    hparams: {
        nVocab: number;
        nCtxTrain: number;
        nEmbd: number;
        nLayer: number;
    };
    meta: Record<string, string>;
}
/**
 * Logger preset with debug messages suppressed
 */
export declare const LoggerWithoutDebug: {
    debug: () => void;
    assert(condition?: boolean | undefined, ...data: any[]): void;
    assert(value: any, message?: string | undefined, ...optionalParams: any[]): void;
    clear(): void;
    clear(): void;
    count(label?: string | undefined): void;
    count(label?: string | undefined): void;
    countReset(label?: string | undefined): void;
    countReset(label?: string | undefined): void;
    dir(item?: any, options?: any): void;
    dir(obj: any, options?: import("util").InspectOptions | undefined): void;
    dirxml(...data: any[]): void;
    dirxml(...data: any[]): void;
    error(...data: any[]): void;
    error(message?: any, ...optionalParams: any[]): void;
    group(...data: any[]): void;
    group(...label: any[]): void;
    groupCollapsed(...data: any[]): void;
    groupCollapsed(...label: any[]): void;
    groupEnd(): void;
    groupEnd(): void;
    info(...data: any[]): void;
    info(message?: any, ...optionalParams: any[]): void;
    log(...data: any[]): void;
    log(message?: any, ...optionalParams: any[]): void;
    table(tabularData?: any, properties?: string[] | undefined): void;
    table(tabularData: any, properties?: readonly string[] | undefined): void;
    time(label?: string | undefined): void;
    time(label?: string | undefined): void;
    timeEnd(label?: string | undefined): void;
    timeEnd(label?: string | undefined): void;
    timeLog(label?: string | undefined, ...data: any[]): void;
    timeLog(label?: string | undefined, ...data: any[]): void;
    timeStamp(label?: string | undefined): void;
    timeStamp(label?: string | undefined): void;
    trace(...data: any[]): void;
    trace(message?: any, ...optionalParams: any[]): void;
    warn(...data: any[]): void;
    warn(message?: any, ...optionalParams: any[]): void;
    Console: console.ConsoleConstructor;
    profile(label?: string | undefined): void;
    profileEnd(label?: string | undefined): void;
};
export type WllamaErrorType = 'model_not_loaded' | 'download_error' | 'load_error' | 'kv_cache_full' | 'unknown_error' | 'inference_error';
export declare class WllamaError extends Error {
    type: WllamaErrorType;
    constructor(message: string, type?: WllamaErrorType);
}
/**
 * AbortError is thrown when the user wants to abort the current operation.
 * This is equivalent to AbortError in Fetch API.
 */
export declare class WllamaAbortError extends Error {
    name: string;
    constructor();
}
/**
 * RuntimeError is thrown when there is an error in the WASM runtime, such as stack overflow, OOM, etc.
 * Stack trace of the error in the WASM runtime can be included in the error object for debugging purpose.
 */
export declare class WllamaRuntimeError extends Error {
    name: string;
    stack: string;
    constructor(message: string, stack: string);
}
/**
 * Set compatibility options for Wllama.
 * By default, these are set to URL of the latest builds on CDN, which requires internet to download. If you want to use local assets or have your own CDN, follow the instruction from @wllama/wllama-compat package.
 */
export interface WllamaCompat {
    worker: string | {
        code: string;
    };
    wasm: string;
}
export declare class Wllama {
    cacheManager: CacheManager;
    modelManager: ModelManager;
    private compat;
    private proxy;
    private lifecycleEpoch;
    private slowMode;
    private wakeDecodeWait;
    private config;
    private pathConfig;
    private useMultiThread;
    private nbThreads;
    private useEmbeddings;
    private useRerank;
    private loadedContextInfo;
    private seed;
    private bosToken;
    private eosToken;
    private eotToken;
    private eogTokens;
    private addBosToken;
    private addEosToken;
    private mediaMarker?;
    private chatTemplate?;
    private metadata?;
    private hasEncoder;
    private decoderStartToken;
    private chatTemplateKwargs;
    constructor(pathConfig: AssetsPathConfig, wllamaConfig?: WllamaConfig);
    private logger;
    private checkModelLoaded;
    /**
     * Get the libllama version string, e.g. "b6327-4d74393".
     *
     * @returns version string embedded at build time.
     */
    static getLibllamaVersion(): string;
    /**
     * Set compatibility options for Wllama.
     * @param compat Set to null to disable compatibility, or 'default' to use the default compat resources from CDN.
     * @param mode 'safari' by default; If set to 'firefox_safari', the compat mode will **also** be enabled on Firefox, which will significantly degrade the performance but allow using WebGPU on Firefox.
     */
    setCompat(compat: WllamaCompat | null | 'default', mode?: 'safari' | 'firefox_safari'): void;
    /**
     * Check if the model is loaded via `loadModel()`
     */
    isModelLoaded(): boolean;
    /**
     * Get token ID associated to BOS (begin of sentence) token.
     *
     * NOTE: This can only being used after `loadModel` is called.
     *
     * @returns -1 if the model is not loaded.
     */
    getBOS(): number;
    /**
     * Get token ID associated to EOS (end of sentence) token.
     *
     * NOTE: This can only being used after `loadModel` is called.
     *
     * @returns -1 if the model is not loaded.
     */
    getEOS(): number;
    /**
     * Get token ID associated to EOT (end of turn) token.
     *
     * NOTE: This can only being used after `loadModel` is called.
     *
     * @returns -1 if the model is not loaded.
     */
    getEOT(): number;
    /**
     * Check if a given token is end-of-generation token (e.g. EOS, EOT, etc.)
     *
     * @param token the token ID to be checked
     * @returns true if the token is EOS, EOT, or any other end-of-generation tokens
     */
    isTokenEOG(token: number): boolean;
    /**
     * Get token ID associated to token used by decoder, to start generating output sequence(only usable for encoder-decoder architecture). In other words, encoder uses normal BOS and decoder uses this token.
     *
     * NOTE: This can only being used after `loadModel` is called.
     *
     * @returns -1 if the model is not loaded.
     */
    getDecoderStartToken(): number;
    /**
     * Get model hyper-parameters and metadata
     *
     * NOTE: This can only being used after `loadModel` is called.
     *
     * @returns ModelMetadata
     */
    getModelMetadata(): ModelMetadata;
    /**
     * Check if we're currently using multi-thread build.
     *
     * NOTE: This can only being used after `loadModel` is called.
     *
     * @returns true if multi-thread is used.
     */
    isMultithread(): boolean;
    /**
     * Get number of threads used in the current context.
     *
     * NOTE: This can only being used after `loadModel` is called.
     *
     * @returns number of threads
     */
    getNumThreads(): number;
    /**
     * Check if the current model uses encoder-decoder architecture
     *
     * NOTE: This can only being used after `loadModel` is called.
     *
     * @returns true if multi-thread is used.
     */
    isEncoderDecoderArchitecture(): boolean;
    /**
     * Must we add BOS token to the tokenized sequence?
     *
     * NOTE: This can only being used after `loadModel` is called.
     *
     * @returns true if BOS token must be added to the sequence
     */
    mustAddBosToken(): boolean;
    /**
     * Must we add EOS token to the tokenized sequence?
     *
     * NOTE: This can only being used after `loadModel` is called.
     *
     * @returns true if EOS token must be added to the sequence
     */
    mustAddEosToken(): boolean;
    /**
     * Get the jinja chat template comes with the model. It only available if the original model (before converting to gguf) has the template in `tokenizer_config.json`
     *
     * NOTE: This can only being used after `loadModel` is called.
     *
     * @returns the jinja template. null if there is no template in gguf
     */
    getChatTemplate(): string | null;
    /**
     * Check if WebGPU is supported by the current environment.
     * @returns true if WebGPU is supported
     */
    isSupportWebGPU(): boolean;
    /**
     * Load model from a given URL (or a list of URLs, in case the model is splitted into smaller files)
     * - If the model already been downloaded (via `downloadModel()`), then we will use the cached model
     * - Else, we download the model from internet
     * @param modelSourceOrURL
     * @param params
     */
    loadModelFromUrl(modelSourceOrURL: ModelSource | string, params?: LoadModelParams & DownloadOptions & {
        useCache?: boolean;
    }): Promise<void>;
    /**
     * Load model from a given Hugging Face model ID and file path.
     *
     * @param hfOptions
     * @param params
     */
    loadModelFromHF(hfOptions: HuggingFaceParams, params?: LoadModelParams & DownloadOptions & {
        useCache?: boolean;
    }): Promise<void>;
    /**
     * Load model from a given list of Blob.
     *
     * You can pass multiple buffers into the function (in case the model contains multiple shards).
     *
     * @param ggufBlobsOrModel Can be either list of Blobs (in case you use local file), or a Model object (in case you use ModelManager)
     * @param params LoadModelParams
     */
    loadModel(ggufBlobsOrModel: Blob[] | Model, params?: LoadModelParams): Promise<void>;
    getLoadedContextInfo(): LoadedContextInfo;
    /**
     * Calculate embedding vector for a given text.
     * By default, BOS and EOS tokens will be added automatically. You can use the "skipBOS" and "skipEOS" option to disable it.
     * @param options OAI-compatible embedding creation options
     * @returns OAI-compatible embedding response
     */
    createEmbedding(options: EmbeddingCreateParams): Promise<CreateEmbeddingResponse>;
    /**
     * Rerank a list of documents against a query.
     * Requires the model to be loaded with embeddings: true and pooling_type: 'rank'.
     * @param options Reranking options (query, documents, top_n)
     * @returns Reranking response with relevance scores sorted highest first
     */
    createRerank(options: RerankParams): Promise<RerankResponse>;
    /**
     * Answer typed questions about a state, using a decision model (TypeSafe-compatible System One API).
     * Image input is not supported yet.
     * @param options The state and the questions
     * @returns The answer of each question
     */
    createSystemOne(options: SystemOneParams): Promise<SystemOneResponse>;
    /**
     * Make chat completion for a given chat messages.
     * @param options OAI-compatible chat completion options
     * @returns OAI-compatible chat completion response (only the final result when stream=false) or an async iterator of completion chunks (when stream=true)
     */
    createChatCompletion(options: ChatCompletionParams & {
        stream?: false;
    }): Promise<ChatCompletionResponse>;
    createChatCompletion(options: ChatCompletionParams & StreamParams<ChatCompletionChunk>): Promise<void>;
    createChatCompletion(options: ChatCompletionParams & {
        stream: true;
    }): Promise<AsyncIterable<ChatCompletionChunk>>;
    /**
     * Make (raw) completion for a given text.
     * @param options OAI-compatible completion options
     * @returns OAI-compatible completion response (stream=false), void when done (stream=true + onData), or async iterator (stream=true, no onData)
     */
    createCompletion(options: RawCompletionParams & {
        stream?: false;
    }): Promise<RawCompletionResponse>;
    createCompletion(options: RawCompletionParams & StreamParams<RawCompletionChunk>): Promise<void>;
    createCompletion(options: RawCompletionParams & {
        stream: true;
    }): Promise<AsyncIterable<RawCompletionChunk>>;
    /**
     * Private implementation of createCompletion
     */
    private createCompletionImpl;
    /**
     * Same with `createCompletion`, but returns an async iterator instead.
     * Only called when stream=true and no onData is provided.
     */
    private createCompletionGenerator;
    /**
     * Whether the currently loaded model supports a specific input modality (e.g. image or audio).
     * @param modality
     * @returns
     */
    supportInputModality(modality: 'image' | 'audio'): boolean;
    /**
     * Unload the model and free all memory.
     *
     * Note: This function will NOT crash if model is not yet loaded
     */
    /** Pace native decode pulls, not text playback. Applies to the active request. */
    setSlowMode(slow: boolean): void;
    private paceDecode;
    tokenize(text: string, options?: {
        addSpecial?: boolean;
        parseSpecial?: boolean;
    }): Promise<{
        id: number;
        piece: string;
    }[]>;
    resetConversation(): Promise<void>;
    exit(): Promise<void>;
    /**
     * [FOR DEBUGGING ONLY] Run ggml backend ops tests without loading any model.
     *
     * Initializes the wasm runtime, executes `test-backend-ops` with the given args, then shuts down.
     *
     * For more info, please refer to guides/debug.md
     *
     * @param args Arguments forwarded to test-backend-ops (e.g. ["-o", "ADD"])
     * @returns retcode (0 = all tests passed) and success flag
     */
    testBackendOps(args?: string[]): Promise<{
        retcode: number;
        success: boolean;
    }>;
    /**
     * get debug info
     */
    _getDebugInfo(): Promise<any>;
    private jsonDecode;
    private prepareMultimodalInput;
    private cancelRequest;
    private getSingleResult;
    private getResponse;
    getWorkerResources(): WllamaWorkerResources;
}
