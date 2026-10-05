import { type ModelSource } from './model-manager';
export interface HuggingFaceParams {
    /**
     * The repo name, e.g. user/model
     */
    repo: string;
    /**
     * The file name or path to file in the repo. Only file or quant is needed.
     */
    file?: string;
    /**
     * The GGUF quantization name, e.g. Q4_K_M, Q8_0, etc. Only file or quant is needed.
     *
     * By default, Q4_K_M will be used, then fallback to Q8_0, and finally the non-quantized version if no quantized version is found.
     */
    quant?: string;
    /**
     * The file name or path to file in the repo for mmproj. Only mmprojFile or mmprojQuant is needed.
     */
    mmprojFile?: string;
    /**
     * The GGUF quantization name for mmproj, e.g. Q4_K_M, Q8_0, etc. Only mmprojFile or mmprojQuant is needed.
     */
    mmprojQuant?: string;
    /**
     * The Hugging Face token with permission to access the repo. It can be omitted if the repo is public.
     */
    hfToken?: string;
}
export declare function getHFModelSource(config: HuggingFaceParams): Promise<ModelSource>;
export declare function getHFFileSHA256(url: string, headers: Record<string, string>): Promise<string | undefined>;
