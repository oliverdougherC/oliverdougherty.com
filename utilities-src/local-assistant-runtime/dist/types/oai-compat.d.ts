import type { SamplingParams } from './types';
export interface ChatCompletionMessageText {
    type: 'text';
    text: string;
}
export interface ChatCompletionMessageImage {
    type: 'image';
    data: ArrayBuffer;
}
export interface ChatCompletionMessageAudio {
    type: 'audio';
    data: ArrayBuffer;
}
export type ChatCompletionMessageContent = ChatCompletionMessageText | ChatCompletionMessageImage | ChatCompletionMessageAudio;
export interface ChatCompletionToolFunctionParameters {
    type: 'object';
    properties: Record<string, {
        type: string;
        description?: string;
        enum?: string[];
        [key: string]: unknown;
    }>;
    required?: string[];
    additionalProperties?: boolean;
}
export interface ChatCompletionToolFunction {
    name: string;
    description?: string;
    parameters?: ChatCompletionToolFunctionParameters;
    strict?: boolean;
}
export interface ChatCompletionTool {
    type: 'function';
    function: ChatCompletionToolFunction;
}
export type ChatCompletionToolChoice = 'none' | 'auto' | 'required' | {
    type: 'function';
    function: {
        name: string;
    };
};
export interface ChatCompletionSystemMessage {
    role: 'system';
    content: string;
    name?: string;
}
export interface ChatCompletionUserMessage {
    role: 'user';
    content: string | ChatCompletionMessageContent[];
    name?: string;
}
export interface ChatCompletionToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
export interface ChatCompletionAssistantMessage {
    role: 'assistant';
    content?: string | null;
    name?: string;
    tool_calls?: ChatCompletionToolCall[];
}
export interface ChatCompletionToolMessage {
    role: 'tool';
    content: string;
    tool_call_id: string;
}
export type ChatCompletionMessage = ChatCompletionSystemMessage | ChatCompletionUserMessage | ChatCompletionAssistantMessage | ChatCompletionToolMessage;
export type ChatCompletionParams = {
    messages: ChatCompletionMessage[];
    stream?: boolean;
    model?: string;
    abortSignal?: AbortSignal;
    temperature?: number;
    max_tokens?: number;
    logprobs?: boolean;
    top_logprobs?: number;
    logit_bias?: Record<string, number>;
    tools?: ChatCompletionTool[];
    tool_choice?: ChatCompletionToolChoice;
    response_format?: {
        type: 'text' | 'json_object' | 'json_schema';
        json_schema?: {
            name: string;
            schema: unknown;
            strict?: boolean;
        };
    };
    user?: string;
    chat_template_kwargs?: Record<string, any>;
    cache_prompt?: boolean;
    post_sampling_probs?: boolean;
    return_tokens?: boolean;
    timings_per_token?: boolean;
    return_progress?: boolean;
} & SamplingParams;
export interface ChatCompletionLogprob {
    token: string;
    logprob: number;
    bytes: number[] | null;
}
export interface ChatCompletionLogprobsContent extends ChatCompletionLogprob {
    top_logprobs: ChatCompletionLogprob[];
}
export interface ChatCompletionChoiceLogprobs {
    content: ChatCompletionLogprobsContent[] | null;
    refusal: ChatCompletionLogprobsContent[] | null;
}
export interface ChatCompletionChoice {
    index: number;
    message: ChatCompletionAssistantMessage;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
    logprobs: ChatCompletionChoiceLogprobs | null;
}
export interface ChatCompletionUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
        cached_tokens: number;
        audio_tokens: number;
    };
    completion_tokens_details?: {
        reasoning_tokens: number;
        audio_tokens: number;
        accepted_prediction_tokens: number;
        rejected_prediction_tokens: number;
    };
}
/** Response when stream=false (or omitted) */
export interface ChatCompletionResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: ChatCompletionChoice[];
    usage: ChatCompletionUsage;
    system_fingerprint?: string;
    service_tier?: string;
}
export interface ChatCompletionChunkDelta {
    role?: 'assistant';
    content?: string | null;
    tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
            name?: string;
            arguments?: string;
        };
    }>;
    refusal?: string | null;
}
export interface ChatCompletionChunkChoice {
    index: number;
    delta: ChatCompletionChunkDelta;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
    logprobs: ChatCompletionChoiceLogprobs | null;
}
export interface ChatMessagePromptProgress {
    total: number;
    cache: number;
    processed: number;
    time_ms: number;
}
export interface ResultTimings {
    cache_n: number;
    prompt_n: number;
    prompt_ms: number;
    prompt_per_token_ms: number;
    prompt_per_second: number;
    predicted_n: number;
    predicted_ms: number;
    predicted_per_token_ms: number;
    predicted_per_second: number;
}
/** Response when stream=true — one chunk per SSE event */
export interface ObservatoryObservation {
    prompt_tokens?: Array<{
        id: number;
        piece: string;
    }>;
    token?: {
        id: number;
        piece: string;
    };
    candidates?: Array<{
        id: number;
        piece: string;
        probability: number;
    }>;
    layers?: Array<{
        layer: number;
        rms: number;
    }>;
    probability_kind?: 'post-sampling' | 'model-softmax';
    generated?: number;
    context_used?: number;
    pass?: number;
    layer_statistic?: string;
    layer_backend?: string;
}
export interface ChatCompletionChunk {
    observatory?: ObservatoryObservation;
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: ChatCompletionChunkChoice[];
    usage?: ChatCompletionUsage | null;
    timings?: ResultTimings;
    prompt_progress?: ChatMessagePromptProgress;
}
export type RawCompletionParams = {
    prompt: string | string[];
    stream?: boolean;
    model?: string;
    abortSignal?: AbortSignal;
    suffix?: string;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    n?: number;
    logprobs?: number | null;
    echo?: boolean;
    stop?: string | string[];
    presence_penalty?: number;
    frequency_penalty?: number;
    best_of?: number;
    logit_bias?: Record<string, number>;
    seed?: number;
    user?: string;
    return_progress?: boolean;
} & SamplingParams;
export interface RawCompletionChoice {
    text: string;
    index: number;
    finish_reason: 'stop' | 'length' | 'content_filter' | null;
    logprobs: {
        tokens: string[];
        token_logprobs: number[];
        top_logprobs: Array<Record<string, number>>;
        text_offset: number[];
    } | null;
}
/** Response when stream=false */
export interface RawCompletionResponse {
    id: string;
    object: 'text_completion';
    created: number;
    model: string;
    choices: RawCompletionChoice[];
    usage: ChatCompletionUsage;
    system_fingerprint?: string;
    timings?: ResultTimings;
}
/** One chunk when stream=true */
export interface RawCompletionChunk {
    id: string;
    object: 'text_completion';
    created: number;
    model: string;
    choices: Array<{
        text: string;
        index: number;
        finish_reason: 'stop' | 'length' | 'content_filter' | null;
        logprobs: null;
    }>;
    usage?: ChatCompletionUsage | null;
    timings?: ResultTimings;
    prompt_progress?: ChatMessagePromptProgress;
}
export interface EmbeddingCreateParams {
    input: string | string[] | number[] | number[][];
    model?: string;
    encoding_format?: 'float' | 'base64';
}
export interface Embedding {
    object: 'embedding';
    index: number;
    embedding: number[] | string;
}
export interface EmbeddingUsage {
    prompt_tokens: number;
    total_tokens: number;
}
export interface CreateEmbeddingResponse {
    object: 'list';
    data: Embedding[];
    model: string;
    usage: EmbeddingUsage;
}
export interface RerankParams {
    query: string;
    documents: string[];
    top_n?: number;
}
export interface RerankResult {
    index: number;
    relevance_score: number;
}
export interface RerankUsage {
    prompt_tokens: number;
    total_tokens: number;
}
export interface RerankResponse {
    model: string;
    object: 'list';
    usage: RerankUsage;
    results: RerankResult[];
}
export type SystemOneQuestion = {
    type: 'choice';
    instructions: any;
    criteria: Record<string, any>;
} | {
    type: 'score';
    instructions: any;
    criteria: any[];
} | {
    type: 'noul';
    instructions: any;
    criteria?: {
        true?: any;
        false?: any;
    };
};
export interface SystemOneParams {
    state: any;
    questions: Record<string, SystemOneQuestion>;
}
export type SystemOneAnswer = {
    type: 'choice';
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
} | {
    type: 'score';
    score: number;
    legend: Record<string, any>;
    probabilities: Record<string, number>;
    confidence: number;
} | {
    type: 'noul';
    noul: number;
};
export interface SystemOneResponse {
    model: string;
    answers: Record<string, SystemOneAnswer>;
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
}
