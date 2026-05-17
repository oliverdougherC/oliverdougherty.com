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
    packageVersion: '4.2.0',
    moduleUrl: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0',
    device: 'webgpu',
    dtype: 'q1',
    requirements: 'WebGPU, enough free GPU/browser memory, and network access to Hugging Face.'
  },
  limits: {
    maxInputChars: 1800,
    maxMessageChars: 2500,
    maxHistoryMessages: 10
  },
  generation: {
    max_new_tokens: 512,
    do_sample: true,
    sampling: {
      temp: 0.5,
      top_k: 20,
      top_p: 0.9,
      penalty_repeat: 1.05
    }
  },
  systemPrompt:
    "You are a small local AI assistant running entirely in the visitor's browser.\n" +
    'Be concise, practical, and honest about limitations.\n' +
    'Do not claim to have internet access, private data, or server-side tools.\n' +
    'If unsure, say so.\n' +
    'Do not output XML tags, special tokens, or thinking tags.'
};
