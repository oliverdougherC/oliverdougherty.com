import CacheManager, { type CacheEntry, type DownloadOptions } from './cache-manager';
import { type WllamaLogger } from './wllama';
export interface ModelSource {
    /**
     * URL to the GGUF file. If the model is splitted, pass the URL to the first shard. Mmproj file should also be provided via this array if you want to use multimodal.
     */
    url: string;
    mmprojUrl?: string;
}
/**
 * Callback function to track download progress
 */
export type DownloadProgressCallback = (opts: {
    /**
     * Number of bytes loaded (sum of all shards)
     */
    loaded: number;
    /**
     * Total number of bytes (sum of all shards)
     */
    total: number;
}) => any;
/**
 * Status of the model validation
 */
export declare enum ModelValidationStatus {
    VALID = "valid",
    INVALID = "invalid",
    DELETED = "deleted"
}
/**
 * Parameters for ModelManager constructor
 */
export interface ModelManagerParams {
    cacheManager?: CacheManager;
    logger?: WllamaLogger;
    /**
     * Number of parallel downloads
     *
     * Default: 3
     */
    parallelDownloads?: number | undefined;
    /**
     * Allow offline mode
     *
     * Default: false
     */
    allowOffline?: boolean | undefined;
}
/**
 * Model class
 *
 * One model can have multiple shards, each shard is a GGUF file.
 */
export declare class Model {
    private modelManager;
    constructor(modelManager: ModelManager, url: string, mmprojUrl?: string, savedFiles?: CacheEntry[]);
    /**
     * URL to the GGUF file (in case it contains multiple shards, the URL should point to the first shard)
     *
     * This URL will be used to identify the model in the cache. There can't be 2 models with the same URL.
     */
    url: string;
    /**
     * URL to mmproj file, if exists
     */
    mmprojUrl?: string | undefined;
    /**
     * Size in bytes (total size of all shards).
     *
     * A value of -1 means the model is deleted from the cache. You must call `ModelManager.downloadModel` to re-download the model.
     */
    size: number;
    /**
     * List of all shards in the cache, sorted by original URL (ascending order)
     */
    files: CacheEntry[];
    /**
     * Open and get a list of all shards as Blobs
     */
    open(): Promise<Blob[]>;
    /**
     * Validate the model files.
     *
     * If the model is invalid, the model manager will not be able to use it. You must call `refresh` to re-download the model.
     *
     * Cases that model is invalid:
     * - The model is deleted from the cache
     * - The model files are missing (or the download is interrupted)
     */
    validate(): ModelValidationStatus;
    /**
     * In case the model is invalid, call this function to re-download the model
     */
    refresh(options?: DownloadOptions): Promise<void>;
    /**
     * Remove the model from the cache
     */
    remove(): Promise<void>;
    private getAllFiles;
    private getTotalDownloadSize;
}
export declare class ModelManager {
    cacheManager: CacheManager;
    params: ModelManagerParams;
    logger: WllamaLogger;
    constructor(params?: ModelManagerParams);
    /**
     * Parses a model URL and returns an array of URLs based on the following patterns:
     * - If the input URL is an array, it returns the array itself.
     * - If the input URL is a string in the `gguf-split` format, it returns an array containing the URL of each shard in ascending order.
     * - Otherwise, it returns an array containing the input URL as a single element array.
     * @param modelUrl URL or list of URLs
     */
    static parseModelUrl(modelUrl: string | string[]): string[];
    /**
     * Get all models in the cache
     */
    getModels(opts?: {
        includeInvalid?: boolean;
    }): Promise<Model[]>;
    /**
     * Download a model from the given URL.
     *
     * The URL must end with `.gguf`
     */
    downloadModel(sourceOrURL: ModelSource | string, options?: DownloadOptions): Promise<Model>;
    /**
     * Get a model from the cache or download it if it's not available.
     */
    getModelOrDownload(source: ModelSource, options?: DownloadOptions): Promise<Model>;
    /**
     * Remove all models from the cache
     */
    clear(): Promise<void>;
}
