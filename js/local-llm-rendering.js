/**
 * @typedef {{ type: 'text' | 'code' | 'math', value: string }} InlineLocalLlmSegment
 */

export const LATEX_COMMANDS = {
  alpha: { tag: 'mi', value: 'α' },
  beta: { tag: 'mi', value: 'β' },
  gamma: { tag: 'mi', value: 'γ' },
  delta: { tag: 'mi', value: 'δ' },
  epsilon: { tag: 'mi', value: 'ε' },
  theta: { tag: 'mi', value: 'θ' },
  lambda: { tag: 'mi', value: 'λ' },
  mu: { tag: 'mi', value: 'μ' },
  pi: { tag: 'mi', value: 'π' },
  sigma: { tag: 'mi', value: 'σ' },
  phi: { tag: 'mi', value: 'φ' },
  omega: { tag: 'mi', value: 'ω' },
  Delta: { tag: 'mi', value: 'Δ' },
  Omega: { tag: 'mi', value: 'Ω' },
  pm: { tag: 'mo', value: '±' },
  mp: { tag: 'mo', value: '∓' },
  times: { tag: 'mo', value: '×' },
  div: { tag: 'mo', value: '÷' },
  cdot: { tag: 'mo', value: '⋅' },
  le: { tag: 'mo', value: '≤' },
  leq: { tag: 'mo', value: '≤' },
  ge: { tag: 'mo', value: '≥' },
  geq: { tag: 'mo', value: '≥' },
  neq: { tag: 'mo', value: '≠' },
  approx: { tag: 'mo', value: '≈' },
  infty: { tag: 'mo', value: '∞' }
};

/**
 * @param {string | null | undefined} text
 * @returns {string}
 */
export function cleanupLocalLlmText(text) {
  return String(text || '')
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<think[\s\S]*$/gi, '')
    .replace(/<\/?(?:s|pad|bos|eos|endoftext|im_start|im_end|\|im_start\||\|im_end\|)>/gi, '')
    .replace(/<\|[^|]+?\|>/g, '')
    .trim();
}

/**
 * @param {string | null | undefined} markdown
 * @returns {string}
 */
export function renderLocalLlmSafeText(markdown) {
  const source = cleanupLocalLlmText(markdown);
  if (!source) return '';

  return source
    .split(/\n{2,}/)
    .map((rawBlock) => {
      if (/^```/.test(rawBlock.trim())) {
        const code = rawBlock.trim().replace(/^```[^\r\n]*(?:\r?\n)?/, '').replace(/(?:\r?\n)?```$/, '');
        return `<pre><code>${escapeHtml(code)}</code></pre>`;
      }

      const displayMath = parseDisplayMathBlock(rawBlock);
      if (displayMath !== null) {
        return renderLocalLlmMath(displayMath, true);
      }

      if (/^\s*[-*]\s/m.test(rawBlock)) {
        const items = rawBlock
          .split(/\n/)
          .filter((line) => /^\s*[-*]\s/.test(line))
          .map((line) => `<li>${renderInlineLocalLlmText(line.replace(/^\s*[-*]\s*/, ''))}</li>`)
          .join('');
        if (items) return `<ul>${items}</ul>`;
      }

      if (/^\s*\d+\.\s/m.test(rawBlock)) {
        const items = rawBlock
          .split(/\n/)
          .filter((line) => /^\s*\d+\.\s/.test(line))
          .map((line) => `<li>${renderInlineLocalLlmText(line.replace(/^\s*\d+\.\s*/, ''))}</li>`)
          .join('');
        if (items) return `<ol>${items}</ol>`;
      }

      return `<p>${renderInlineLocalLlmText(rawBlock)}</p>`;
    })
    .join('');
}

/**
 * @param {string} rawBlock
 * @returns {string | null}
 */
function parseDisplayMathBlock(rawBlock) {
  const block = rawBlock.trim();
  if (!block.startsWith('$$') || !block.endsWith('$$') || block.length <= 4) return null;
  return block.slice(2, -2).trim();
}

/**
 * @param {string} text
 * @returns {string}
 */
function renderInlineLocalLlmText(text) {
  return splitInlineLocalLlmSegments(text)
    .map((segment) => {
      if (segment.type === 'code') return `<code>${escapeHtml(segment.value)}</code>`;
      if (segment.type === 'math') return renderLocalLlmMath(segment.value, false);
      return renderMarkdownInlineText(segment.value);
    })
    .join('');
}

/**
 * @param {string} text
 * @returns {string}
 */
function renderMarkdownInlineText(text) {
  return escapeHtml(text)
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=([\s).,;:!?]|$))/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\n/g, '<br>');
}

/**
 * @param {string} text
 * @returns {InlineLocalLlmSegment[]}
 */
export function splitInlineLocalLlmSegments(text) {
  const segments = [];
  let textStart = 0;
  let index = 0;

  const pushText = (end) => {
    if (end > textStart) segments.push({ type: 'text', value: text.slice(textStart, end) });
  };

  while (index < text.length) {
    const char = text[index];

    if (char === '`') {
      const close = text.indexOf('`', index + 1);
      if (close > index + 1) {
        pushText(index);
        segments.push({ type: 'code', value: text.slice(index + 1, close) });
        index = close + 1;
        textStart = index;
        continue;
      }
    }

    if (char === '$' && text[index + 1] !== '$' && text[index - 1] !== '$' && !isEscapedAt(text, index)) {
      const close = findClosingInlineMathDelimiter(text, index + 1);
      if (close > index + 1) {
        pushText(index);
        segments.push({ type: 'math', value: text.slice(index + 1, close).trim() });
        index = close + 1;
        textStart = index;
        continue;
      }
    }

    index += 1;
  }

  pushText(text.length);
  return segments;
}

function findClosingInlineMathDelimiter(text, start) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\n') return -1;
    if (text[index] === '$' && text[index + 1] !== '$' && text[index - 1] !== '$' && !isEscapedAt(text, index)) return index;
  }
  return -1;
}

function isEscapedAt(text, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

/**
 * @param {string} expression
 * @param {boolean} display
 * @returns {string}
 */
export function renderLocalLlmMath(expression, display) {
  const parser = new LocalLlmLatexParser(expression);
  const body = parser.parse();
  const displayAttribute = display ? ' display="block"' : '';
  const className = display ? 'local-llm-math local-llm-math--display' : 'local-llm-math local-llm-math--inline';
  const tag = display ? 'div' : 'span';

  return `<${tag} class="${className}"><math xmlns="http://www.w3.org/1998/Math/MathML"${displayAttribute}><mrow>${body}</mrow></math></${tag}>`;
}

export class LocalLlmLatexParser {
  constructor(input) {
    this.input = input;
    this.index = 0;
  }

  parse() {
    return this.parseExpression();
  }

  parseExpression(stopChar = '') {
    const parts = [];
    while (this.index < this.input.length) {
      if (stopChar && this.input[this.index] === stopChar) break;
      if (/\s/.test(this.input[this.index])) {
        this.index += 1;
        continue;
      }

      const atom = this.parseAtom();
      if (atom) parts.push(this.parseScripts(atom));
    }
    return parts.join('');
  }

  parseAtom() {
    const char = this.input[this.index];
    if (!char) return '';

    if (char === '{') {
      this.index += 1;
      const inner = this.parseExpression('}');
      if (this.input[this.index] === '}') this.index += 1;
      return `<mrow>${inner}</mrow>`;
    }

    if (char === '\\') return this.parseCommand();
    if (/[0-9.]/.test(char)) return this.parseNumber();

    if (/[a-zA-Z]/.test(char)) {
      this.index += 1;
      return `<mi>${escapeHtml(char)}</mi>`;
    }

    this.index += 1;
    if (/^[=+\-*/()[\]|,.:;<>]$/.test(char)) return `<mo>${escapeHtml(char)}</mo>`;
    return `<mtext>${escapeHtml(char)}</mtext>`;
  }

  parseScripts(base) {
    let subscript = '';
    let superscript = '';

    while (this.input[this.index] === '^' || this.input[this.index] === '_') {
      const marker = this.input[this.index];
      this.index += 1;
      const script = this.parseScriptArgument();
      if (marker === '^') superscript = script;
      if (marker === '_') subscript = script;
    }

    if (subscript && superscript) return `<msubsup>${base}${subscript}${superscript}</msubsup>`;
    if (subscript) return `<msub>${base}${subscript}</msub>`;
    if (superscript) return `<msup>${base}${superscript}</msup>`;
    return base;
  }

  parseScriptArgument() {
    this.skipWhitespace();
    if (this.input[this.index] === '{') return this.parseAtom();
    return this.parseAtom() || '<mrow></mrow>';
  }

  parseCommand() {
    this.index += 1;
    const start = this.index;
    while (/[a-zA-Z]/.test(this.input[this.index] || '')) this.index += 1;
    const command = this.input.slice(start, this.index);

    if (!command) {
      const char = this.input[this.index] || '';
      this.index += 1;
      return `<mo>${escapeHtml(char)}</mo>`;
    }

    if (command === 'left' || command === 'right') return '';

    if (command === 'sqrt') {
      this.skipOptionalBracketGroup();
      return `<msqrt>${this.parseRequiredArgument()}</msqrt>`;
    }

    if (command === 'frac') {
      const numerator = this.parseRequiredArgument();
      const denominator = this.parseRequiredArgument();
      return `<mfrac>${numerator}${denominator}</mfrac>`;
    }

    if (command === 'text') {
      return `<mtext>${escapeHtml(this.readRawBraceGroup())}</mtext>`;
    }

    const symbol = LATEX_COMMANDS[command];
    if (symbol) return `<${symbol.tag}>${escapeHtml(symbol.value)}</${symbol.tag}>`;
    return `<mi>${escapeHtml(command)}</mi>`;
  }

  parseRequiredArgument() {
    this.skipWhitespace();
    if (this.input[this.index] === '{') return this.parseAtom();
    return this.parseAtom() || '<mrow></mrow>';
  }

  parseNumber() {
    const start = this.index;
    while (/[0-9.]/.test(this.input[this.index] || '')) this.index += 1;
    return `<mn>${escapeHtml(this.input.slice(start, this.index))}</mn>`;
  }

  readRawBraceGroup() {
    this.skipWhitespace();
    if (this.input[this.index] !== '{') return '';
    this.index += 1;
    let depth = 1;
    const start = this.index;
    while (this.index < this.input.length && depth > 0) {
      if (this.input[this.index] === '{') depth += 1;
      if (this.input[this.index] === '}') depth -= 1;
      this.index += 1;
    }
    const end = depth === 0 ? this.index - 1 : this.index;
    return this.input.slice(start, end);
  }

  skipOptionalBracketGroup() {
    this.skipWhitespace();
    if (this.input[this.index] !== '[') return;
    this.index += 1;
    while (this.index < this.input.length && this.input[this.index] !== ']') this.index += 1;
    if (this.input[this.index] === ']') this.index += 1;
  }

  skipWhitespace() {
    while (/\s/.test(this.input[this.index] || '')) this.index += 1;
  }
}

/**
 * @param {string | number | boolean | null | undefined} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
