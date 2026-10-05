import type { DownloadProgressCallback } from './model-manager';
import type { StorageBackend } from './storage/index';
export type DownloadOptions = {
    /**
     * Callback function to track download progress
     */
    progressCallback?: DownloadProgressCallback;
    /**
     * Additional metadata to be stored with the downloaded file
     */
    metadataAdditional?: Record<string, any>;
    /**
     * Custom headers for the request. Useful for authentication (e.g. Bearer token)
     */
    headers?: Record<string, string>;
    /**
     * Abort signal for the request
     */
    signal?: AbortSignal;
};
export declare const POLYFILL_ETAG = "polyfill_for_older_version";
export interface CacheEntry {
    /**
     * Storage key for this file, in the format: `${hashSHA1(fullURL)}_${fileName}`
     */
    name: string;
    /**
     * Size of file (in bytes)
     */
    size: number;
    /**
     * Other metadata
     */
    metadata: CacheEntryMetadata;
}
export interface CacheEntryMetadata {
    /**
     * ETag header from remote request
     * https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag
     */
    etag: string;
    /**
     * Remote file size (in bytes), used for integrity check
     */
    originalSize: number;
    /**
     * Original URL of the remote model. Unused for now
     */
    originalURL: string;
    /**
     * URL to mmproj file, if exists
     */
    mmprojURL?: string | undefined;
    /**
     * Optional SHA256, mostly used by COS backend
     */
    sha256?: string | undefined;
}
/**
 * Manages cached model files, backed by a pluggable StorageBackend.
 *
 * Defaults to OPFS (Origin Private File System).
 */
export declare class CacheManager {
    private sb;
    /**
     * @param backends Array of storage backends to use, in order of preference ; if first is available, use it, otherwise try the next one.
     */
    constructor(backends?: StorageBackend[]);
    /**
     * Convert a given URL into a storage key.
     *
     * Format: `${hashSHA1(fullURL)}_${fileName}`
     */
    getNameFromURL(url: string): Promise<string>;
    /**
     * @deprecated Use `download()` instead
     *
     * Write a new file to cache. This will overwrite existing file.
     *
     * @param name The file name returned by `getNameFromURL()` or `list()`
     */
    write(name: string, stream: ReadableStream, metadata: CacheEntryMetadata): Promise<void>;
    download(url: string, options?: DownloadOptions): Promise<void>;
    /**
     * Open a file in cache for reading
     *
     * @param nameOrURL The file name returned by `getNameFromURL()` or `list()`, or the original URL of the remote file
     * @returns Blob, or null if file does not exist
     */
    open(nameOrURL: string): Promise<Blob | null>;
    /**
     * Get the size of a file in stored cache
     *
     * NOTE: in case the download is stopped mid-way (i.e. user close browser tab), the file maybe corrupted, size maybe different from `metadata.originalSize`
     *
     * @param name The file name returned by `getNameFromURL()` or `list()`
     * @returns number of bytes, or -1 if file does not exist
     */
    getSize(name: string): Promise<number>;
    /**
     * Get metadata of a cached file
     */
    getMetadata(name: string): Promise<CacheEntryMetadata | null>;
    /**
     * Same as `getMetadata()`, but without polyfill. Returns null if the file has no metadata.
     */
    private readMetadata;
    /**
     * List all files currently in cache
     */
    list(): Promise<CacheEntry[]>;
    /**
     * Clear all files currently in cache
     */
    clear(): Promise<void>;
    /**
     * Delete a single file in cache
     *
     * @param nameOrURL Can be either an URL or a name returned by `getNameFromURL()` or `list()`
     */
    delete(nameOrURL: string): Promise<void>;
    /**
     * Delete multiple files in cache.
     *
     * @param predicate A predicate like `array.filter(item => boolean)`
     */
    deleteMany(predicate: (e: CacheEntry) => boolean): Promise<void>;
    /**
     * Write the metadata of the file to disk.
     */
    writeMetadata(name: string, metadata: CacheEntryMetadata): Promise<void>;
}
export default CacheManager;
