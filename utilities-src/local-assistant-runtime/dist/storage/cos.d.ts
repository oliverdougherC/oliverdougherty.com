import type { StorageBackend, StorageFileHint } from './index';
interface CrossOriginStorageRequestFileHandleHash {
    value: string;
    algorithm: string;
}
interface CrossOriginStorageManager {
    requestFileHandle(hash: CrossOriginStorageRequestFileHandleHash, options?: {
        create?: boolean;
        origins?: string[] | string;
    }): Promise<FileSystemFileHandle>;
}
declare global {
    interface Navigator {
        readonly crossOriginStorage?: CrossOriginStorageManager;
    }
}
/**
 * Storage backend that uses the Cross-Origin Storage API
 * Metadata is stored in OPFS, while the actual data is stored in COS
 * If hint.sha256 is provided, it will be used as the key for COS, otherwise fallback to OPFS
 */
export declare class COSBackend implements StorageBackend {
    private cos;
    private priv;
    isSupported(): boolean;
    read(key: string, hint?: StorageFileHint): Promise<Blob | null>;
    write(key: string, stream: ReadableStream, hint?: StorageFileHint): Promise<void>;
    getSize(key: string, hint?: StorageFileHint): Promise<number>;
    list(): Promise<Array<{
        key: string;
        size: number;
    }>>;
    delete(key: string): Promise<void>;
}
export declare function mockCOS(): void;
export {};
