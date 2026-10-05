import type { GlueMessageProto } from './glue';
export declare const GLUE_VERSION = 1;
export declare const GLUE_MESSAGE_PROTOTYPES: {
    [name: string]: GlueMessageProto;
};
export interface GlueMsgError {
    _name: "erro_evt";
    message: string;
}
export interface GlueMsgLoadReq {
    _name: "load_req";
    observatory?: boolean | undefined;
    observatory_lens?: boolean | undefined;
    model_paths: string[];
    mmproj_path?: string | undefined;
    n_ctx_auto: boolean;
    use_mmap: boolean;
    use_mlock: boolean;
    n_gpu_layers: number;
    n_ctx: number;
    n_threads: number;
    model_alias?: string | undefined;
    log_level?: number | undefined;
    embeddings?: boolean | undefined;
    offload_kqv?: boolean | undefined;
    n_batch?: number | undefined;
    n_ubatch?: number | undefined;
    n_parallel?: number | undefined;
    pooling_type?: string | undefined;
    rope_scaling_type?: string | undefined;
    rope_freq_base?: number | undefined;
    rope_freq_scale?: number | undefined;
    yarn_ext_factor?: number | undefined;
    yarn_attn_factor?: number | undefined;
    yarn_beta_fast?: number | undefined;
    yarn_beta_slow?: number | undefined;
    yarn_orig_ctx?: number | undefined;
    cache_type_k?: string | undefined;
    cache_type_v?: string | undefined;
    kv_unified?: boolean | undefined;
    flash_attn?: boolean | undefined;
    swa_full?: boolean | undefined;
    n_ctx_checkpoints?: number | undefined;
    checkpoint_min_step?: number | undefined;
    chat_template?: string | undefined;
    jinja?: boolean | undefined;
    default_template_kwargs_keys?: string[] | undefined;
    default_template_kwargs_vals?: string[] | undefined;
    reasoning?: boolean | undefined;
    image_min_tokens?: number | undefined;
    image_max_tokens?: number | undefined;
    warmup?: boolean | undefined;
    no_kv_offload?: boolean | undefined;
    mmproj_offload?: boolean | undefined;
    cont_batching?: boolean | undefined;
    n_keep?: number | undefined;
    ctx_shift?: boolean | undefined;
    cache_idle_slots?: boolean | undefined;
    n_cache_reuse?: number | undefined;
    lora_paths?: string[] | undefined;
    lora_scales?: number[] | undefined;
    lora_init_without_apply?: boolean | undefined;
    spec_draft_model?: string | undefined;
    spec_draft_ngl?: number | undefined;
    spec_draft_n_max?: number | undefined;
    spec_draft_n_min?: number | undefined;
    spec_draft_p_min?: number | undefined;
    spec_draft_threads?: number | undefined;
    spec_draft_threads_batch?: number | undefined;
    kv_overrides_keys?: string[] | undefined;
    kv_overrides_vals?: string[] | undefined;
    reasoning_budget_tokens?: number | undefined;
    reasoning_budget_message?: string | undefined;
    reasoning_format?: string | undefined;
    skip_chat_parsing?: boolean | undefined;
    prefill_assistant?: boolean | undefined;
}
export interface GlueMsgLoadRes {
    _name: "load_res";
    success: boolean;
    n_ctx: number;
    n_batch: number;
    n_ubatch: number;
    n_vocab: number;
    n_ctx_train: number;
    n_embd: number;
    n_layer: number;
    metadata_key: string[];
    metadata_val: string[];
    token_bos: number;
    token_eos: number;
    token_eot: number;
    list_tokens_eog: number[];
    add_bos_token: boolean;
    add_eos_token: boolean;
    has_encoder: boolean;
    token_decoder_start: number;
    media_marker: string;
    has_image_input: boolean;
    has_audio_input: boolean;
}
export interface GlueMsgCompletionReq {
    _name: "cmpl_req";
    is_chat: boolean;
    data_json: string;
    files: Uint8Array[];
}
export interface GlueMsgCompletionRes {
    _name: "cmpl_res";
    success: boolean;
    req_id: number;
}
export interface GlueMsgEmbeddingReq {
    _name: "embd_req";
    data_json: string;
    files: Uint8Array[];
}
export interface GlueMsgEmbeddingRes {
    _name: "embd_res";
    success: boolean;
    req_id: number;
}
export interface GlueMsgRerankReq {
    _name: "rrnk_req";
    data_json: string;
}
export interface GlueMsgRerankRes {
    _name: "rrnk_res";
    success: boolean;
    req_id: number;
}
export interface GlueMsgSystemoneReq {
    _name: "sys1_req";
    data_json: string;
}
export interface GlueMsgSystemoneRes {
    _name: "sys1_res";
    success: boolean;
    req_id: number;
}
export interface GlueMsgGetResultReq {
    _name: "gres_req";
    req_id: number;
}
export interface GlueMsgGetResultRes {
    _name: "gres_res";
    success: boolean;
    has_more: boolean;
    is_error: boolean;
    data_json: string;
}
export interface GlueMsgCancelReq {
    _name: "cncl_req";
    req_id: number;
}
export interface GlueMsgCancelRes {
    _name: "cncl_res";
    success: boolean;
}
export interface GlueMsgTestBackendOpsReq {
    _name: "tbop_req";
    args: string[];
}
export interface GlueMsgTestBackendOpsRes {
    _name: "tbop_res";
    retcode: number;
    success: boolean;
}
export interface GlueMsgObserveTokenizeReq {
    _name: "obst_req";
    text: string;
    add_special: boolean;
    parse_special: boolean;
}
export interface GlueMsgObserveTokenizeRes {
    _name: "obst_res";
    ids: number[];
    pieces: string[];
}
export interface GlueMsgObserveResetReq {
    _name: "obsr_req";
}
export interface GlueMsgObserveResetRes {
    _name: "obsr_res";
    success: boolean;
}
export type GlueMsg = GlueMsgError | GlueMsgLoadReq | GlueMsgLoadRes | GlueMsgCompletionReq | GlueMsgCompletionRes | GlueMsgEmbeddingReq | GlueMsgEmbeddingRes | GlueMsgRerankReq | GlueMsgRerankRes | GlueMsgSystemoneReq | GlueMsgSystemoneRes | GlueMsgGetResultReq | GlueMsgGetResultRes | GlueMsgCancelReq | GlueMsgCancelRes | GlueMsgTestBackendOpsReq | GlueMsgTestBackendOpsRes | GlueMsgObserveTokenizeReq | GlueMsgObserveTokenizeRes | GlueMsgObserveResetReq | GlueMsgObserveResetRes;
