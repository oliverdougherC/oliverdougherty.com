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

export interface LocalLlmTokenWindowOptions {
  maxInputTokens: number;
  effectiveInputTokens?: number;
  perMessageOverheadTokens: number;
  maxInputTokensPerMessage?: number;
  countTokens: (text: string) => number;
}

export interface LocalLlmTokenWindowResult {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  droppedMessageCount: number;
  truncatedUserInput: boolean;
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

function isNonSystemMessage(
  msg: { role: 'system' | 'user' | 'assistant'; content: string }
): msg is { role: 'user' | 'assistant'; content: string } {
  return msg.role !== 'system';
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

export function compactLocalLlmMessagesByTokenBudget(
  messages: LocalLlmMessage[],
  limits: LocalLlmLimits,
  options: LocalLlmTokenWindowOptions
): LocalLlmTokenWindowResult {
  const perMessageOverheadTokens = Math.max(0, options.perMessageOverheadTokens);
  const rawMaxInputTokens = Math.max(1, options.maxInputTokens);
  const maxInputTokens = options.effectiveInputTokens
    ? Math.max(1, Math.min(rawMaxInputTokens, options.effectiveInputTokens))
    : rawMaxInputTokens;
  const maxInputTokensPerMessage = Math.max(1, options.maxInputTokensPerMessage ?? maxInputTokens);
  const countTokens = (text: string) => Math.max(1, options.countTokens(text));
  const messageCost = (text: string) => countTokens(text) + perMessageOverheadTokens;

  const chat = compactLocalLlmMessages(messages, limits)
    .filter(isNonSystemMessage)
    .map((message) => ({ role: message.role, content: message.content }));

  let latestUserIndex = -1;
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    if (chat[index].role === 'user') {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex === -1) {
    return {
      messages: [],
      droppedMessageCount: chat.length,
      truncatedUserInput: false
    };
  }

  const selectedIndexes: number[] = [];
  const selected = new Set<number>();
  let tokenBudgetUsed = 0;
  let truncatedUserInput = false;

  const latestUser = { ...chat[latestUserIndex] };
  let latestUserCost = messageCost(latestUser.content);
  if (latestUserCost > maxInputTokensPerMessage) {
    latestUser.content = truncateToTokenBudget(latestUser.content, Math.max(1, maxInputTokensPerMessage - perMessageOverheadTokens), countTokens);
    latestUserCost = messageCost(latestUser.content);
    truncatedUserInput = true;
  }
  if (latestUserCost > maxInputTokens) {
    latestUser.content = truncateToTokenBudget(latestUser.content, Math.max(1, maxInputTokens - perMessageOverheadTokens), countTokens);
    latestUserCost = messageCost(latestUser.content);
    truncatedUserInput = true;
  }
  chat[latestUserIndex] = latestUser;

  selectedIndexes.push(latestUserIndex);
  selected.add(latestUserIndex);
  tokenBudgetUsed += latestUserCost;

  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const cost = messageCost(chat[index].content);
    if (tokenBudgetUsed + cost > maxInputTokens) continue;
    tokenBudgetUsed += cost;
    selectedIndexes.push(index);
    selected.add(index);
  }

  selectedIndexes.sort((a, b) => a - b);
  const packed = selectedIndexes.map((index) => chat[index]);
  while (packed[0]?.role === 'assistant') packed.shift();

  let droppedMessageCount = 0;
  for (let index = 0; index < chat.length; index += 1) {
    if (!selected.has(index)) droppedMessageCount += 1;
  }

  return {
    messages: packed,
    droppedMessageCount,
    truncatedUserInput
  };
}

function truncateToTokenBudget(text: string, maxTokens: number, countTokens: (text: string) => number) {
  const source = String(text || '');
  if (!source.trim()) return '';
  if (countTokens(source) <= maxTokens) return source;

  let low = 0;
  let high = source.length;
  let best = source.slice(-Math.max(1, Math.floor(source.length / 4)));

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = source.slice(source.length - mid).trim();
    const tokenCount = candidate ? countTokens(candidate) : 0;
    if (tokenCount <= maxTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best.trim();
}
