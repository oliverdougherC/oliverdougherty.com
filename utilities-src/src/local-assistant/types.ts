export interface AssistantMessage { role: 'user' | 'assistant'; content: string; reasoning?: string }
export interface Token { id: number; piece: string }
export interface Candidate { piece: string; probability: number; id?: number }
export interface LayerSummary { layer: number; rms?: number; milliseconds?: number }
/** Sparse top attention weights; positions are absolute sequence positions, zero based. */
export interface AttentionSummary {
  layer: number;
  queryPosition: number;
  keyCount: number;
  headCount: number;
  entries: Array<{ position: number; weight: number }>;
  coverage?: number;
}
export interface LayerChange { layer: number; relativeDelta: number; inputRms?: number; deltaRms?: number }
/** Final output norm/head applied to an intermediate residual; not a sampler distribution. */
export interface LensCheckpoint { layer: number; candidates: Candidate[] }
export interface Observation {
  stage?: 'prefill' | 'decode';
  promptProcessed?: number;
  promptTotal?: number;
  pass?: number;
  layerBackend?: string;
  attention?: AttentionSummary[];
  layerChanges?: LayerChange[];
  lens?: LensCheckpoint[];
  promptTokens?: Token[];
  token?: Token;
  candidates?: Candidate[];
  layers?: LayerSummary[];
  promptMs?: number;
  tokensPerSecond?: number;
  contextUsed?: number;
  generated?: number;
}
export interface ModelInfo {
  name: string;
  context: number;
  layers: Array<'deltanet' | 'attention'>;
  backend: string;
}
export interface Runtime {
  setSlowMode?(slow: boolean): void;
  load(signal: AbortSignal, progress: (loaded: number, total: number | null, phase: string) => void): Promise<ModelInfo>;
  generate(messages: AssistantMessage[], thinking: boolean, signal: AbortSignal, update: (content: string, reasoning: string, observation: Observation) => void): Promise<void>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}
export type Phase = 'idle' | 'loading' | 'ready' | 'generating' | 'error' | 'unsupported';
export interface AssistantState {
  phase: Phase;
  active: boolean;
  thinking: boolean;
  slow: boolean;
  entered: boolean;
  messages: AssistantMessage[];
  info: ModelInfo | null;
  observation: Observation;
  loaded: number;
  total: number | null;
  status: string;
}
