const TRANSFORMERS_VERSION = '4.2.0';

export const WORKER_STATE = {
  IDLE: 'idle',
  CHECKING: 'checking',
  LOADING: 'loading',
  OPTIMIZING: 'optimizing',
  READY: 'ready',
  THINKING: 'thinking',
  STREAMING: 'streaming',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
  DISPOSED: 'disposed'
};

export const LOCAL_LLM_CONFIG = {
  model: {
    id: 'onnx-community/Bonsai-1.7B-ONNX',
    displayName: 'Bonsai 1.7B',
    sizeLabel: '290 MB',
    sourceUrl: 'https://huggingface.co/onnx-community/Bonsai-1.7B-ONNX'
  },
  runtime: {
    name: 'Transformers.js WebGPU',
    packageVersion: TRANSFORMERS_VERSION,
    moduleUrl: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`,
    device: 'webgpu',
    dtype: 'q1',
    requirements: 'WebGPU, enough free GPU/browser memory, and network access to Hugging Face.'
  },
  limits: {
    maxInputChars: 1800,
    maxMessageChars: 2500,
    maxHistoryMessages: 48
  },
  context: {
    fallbackContextTokens: 8192,
    effectiveInputTokens: 3072,
    reservedGenerationTokens: 512,
    reserveSafetyTokens: 256,
    perMessageOverheadTokens: 14,
    maxInputTokensPerMessage: 1200
  },
  generation: {
    // Creative and loose — this is a tech demo, not a serious assistant.
    max_new_tokens: 512,
    do_sample: true,
    sampling: {
      temp: 0.9,
      top_k: 40,
      top_p: 0.95,
      penalty_repeat: 1.0
    }
  }
};
