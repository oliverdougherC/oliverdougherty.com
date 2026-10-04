export declare const Debug: {
    /**
     * Resolves a list of wasm function indices to their cleaned symbol names.
     */
    decodeFuncIds: (funcIds: number[], isCompatBuild: boolean) => Promise<{
        funcId: number;
        name: string;
    }[]>;
    /**
     * Annotates a wasm stack trace string with resolved function names.
     *
     * Example input from Chrome:
     *   at http://localhost:8080/esm/wasm/wllama.wasm:wasm-function[775]:0x74251
     *   at async blob:http://localhost:8080/53a863cc-7227-45cc-8594-ddbbf5257f20:317:28
     *
     * Example input from Firefox:
     *   @http://localhost:8080/esm/wasm/wllama.wasm:wasm-function[796]:0x7dfe2
     *       at wModuleInit/WebAssembly.promising/< (9b6a2acd-d909-44e2-b021-d42fb9087cfb:15:32) index.js:1433:45
     *
     * Example input from Safari:
     *   2441@wasm-function[2441]
     *       at wrapper (d746f19e-4523-4f36-ba06-d0969acc0b05:22:126009)
     *
     * Example output:
     *   wasm-func[775] (server_response::send)
     */
    decodeStackTrace: (stack: string, isCompatBuild: boolean) => Promise<string>;
};
