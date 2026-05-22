import {
  LATEX_COMMANDS,
  LocalLlmLatexParser,
  cleanupLocalLlmText,
  escapeHtml,
  renderLocalLlmMath,
  renderLocalLlmSafeText,
  splitInlineLocalLlmSegments
} from '../../js/local-llm-rendering.js';

export interface LocalLlmMessage {
  role: 'user' | 'assistant' | 'notice';
  content: string;
}

export interface LocalLlmLimits {
  maxMessageChars: number;
  maxHistoryMessages: number;
}

export type InlineLocalLlmSegment =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'math'; value: string };

export {
  LATEX_COMMANDS,
  LocalLlmLatexParser,
  cleanupLocalLlmText,
  escapeHtml,
  renderLocalLlmMath,
  renderLocalLlmSafeText,
  splitInlineLocalLlmSegments
};

export function normalizeLocalLlmProgressState(status: unknown): 'downloading' | 'loading' {
  if (status === 'progress' || status === 'download' || status === 'progress_total') return 'downloading';
  if (status === 'ready' || status === 'done' || status === 'loading' || status === 'optimizing') return 'loading';
  return 'downloading';
}

export function compactLocalLlmMessages(
  messages: LocalLlmMessage[],
  limits: LocalLlmLimits,
  systemPrompt?: string
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const chat = messages
    .filter((message) => message.role !== 'notice' && typeof message.content === 'string')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: cleanupLocalLlmText(message.content).slice(0, limits.maxMessageChars)
    }))
    .filter((message) => message.content.trim())
    .slice(-limits.maxHistoryMessages);

  while (chat[0]?.role === 'assistant') chat.shift();

  const prompt = systemPrompt?.trim();
  return prompt ? [{ role: 'system', content: prompt }, ...chat] : chat;
}
