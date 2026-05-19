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
    maxHistoryMessages: 10
  },
  generation: {
    // Keep responses bounded for a small browser-resident model. The narrow
    // sampling horizon and mild repeat penalty favor stable concise answers
    // over highly creative output.
    max_new_tokens: 512,
    do_sample: true,
    sampling: {
      temp: 0.5,
      top_k: 20,
      top_p: 0.9,
      penalty_repeat: 1.05
    }
  },
  // Defense in depth: the prompt asks the model not to emit hidden-thinking
  // tags, while cleanupModelText strips them if the model ignores that request.
  systemPrompt:
    "You are a small local AI assistant running entirely in the visitor's browser.\n" +
    'Be concise, practical, and honest about limitations.\n' +
    'Do not claim to have internet access, private data, or server-side tools.\n' +
    'If unsure, say so.\n' +
    'Do not output XML tags, special tokens, or thinking tags.'
};
