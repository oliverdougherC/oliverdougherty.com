import type { StorageBackend } from './index';
export declare class OPFSBackend implements StorageBackend {
    isSupported(): boolean;
    read(key: string): Promise<Blob | null>;
    write(key: string, stream: ReadableStream): Promise<void>;
    getSize(key: string): Promise<number>;
    list(): Promise<Array<{
        key: string;
        size: number;
    }>>;
    delete(key: string): Promise<void>;
}
