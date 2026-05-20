import {
  cleanupLocalLlmText,
  compactLocalLlmMessages,
  LocalLlmLatexParser,
  normalizeLocalLlmProgressState,
  renderLocalLlmMath,
  renderLocalLlmSafeText,
  splitInlineLocalLlmSegments
} from '@utilities/localLlmState';

describe('local LLM state helpers', () => {
  it('removes think tags and chat-template markers from model output', () => {
    expect(
      cleanupLocalLlmText('<think>hidden</think>Hello <|im_start|>there<|im_end|> <bos>friend</bos>')
    ).toBe('Hello there friend');
  });

  it('keeps the newest user prompt when trimming history', () => {
    const result = compactLocalLlmMessages(
      [
        { role: 'user', content: 'old user' },
        { role: 'assistant', content: 'old assistant' },
        { role: 'user', content: 'newest user prompt' }
      ],
      { maxHistoryMessages: 1, maxMessageChars: 200 },
      'system'
    );

    expect(result).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'newest user prompt' }
    ]);
  });

  it('drops orphan leading assistant messages after trimming', () => {
    const result = compactLocalLlmMessages(
      [
        { role: 'assistant', content: 'orphan' },
        { role: 'user', content: 'usable' }
      ],
      { maxHistoryMessages: 2, maxMessageChars: 200 },
      'system'
    );

    expect(result).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'usable' }
    ]);
  });

  it('normalizes progress statuses without relying on transient exact names', () => {
    expect(normalizeLocalLlmProgressState('progress_total')).toBe('downloading');
    expect(normalizeLocalLlmProgressState('done')).toBe('loading');
    expect(normalizeLocalLlmProgressState('optimizing')).toBe('loading');
  });

  it('escapes links and images instead of reintroducing raw href/src attributes', () => {
    const html = renderLocalLlmSafeText('[x](javascript:alert(1))\n\n![bad](x onerror=alert(1))');

    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('src=');
    expect(html).toContain('[x](javascript:alert(1))');
  });

  it('escapes raw HTML payloads even when wrapped in inline markdown', () => {
    const html = renderLocalLlmSafeText([
      '<script>alert(1)</script>',
      '',
      '**<img src=x onerror=alert(1)>** *<svg onload=alert(1)></svg>*'
    ].join('\n'));

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
    expect(html).toContain('<em>&lt;svg onload=alert(1)&gt;&lt;/svg&gt;</em>');
  });

  it('renders ordered lists as ordered lists', () => {
    expect(renderLocalLlmSafeText('1. First\n2. Second')).toContain('<ol>');
  });

  it('renders safe inline emphasis for load copy', () => {
    expect(renderLocalLlmSafeText('This is a *teensy* LLM')).toContain('<em>teensy</em>');
  });

  it('renders inline and display LaTeX as MathML instead of raw delimiters', () => {
    const html = renderLocalLlmSafeText([
      'Solve $x^2 = 16$.',
      '',
      '$$',
      'x = \\pm \\sqrt{16}',
      '$$'
    ].join('\n'));

    expect(html).toContain('local-llm-math--inline');
    expect(html).toContain('local-llm-math--display');
    expect(html).toContain('<msup><mi>x</mi><mn>2</mn></msup>');
    expect(html).toContain('<mo>±</mo>');
    expect(html).toContain('<msqrt><mrow><mn>16</mn></mrow></msqrt>');
    expect(html).not.toContain('$$');
  });

  it('leaves LaTeX-looking text inside code spans and fences alone', () => {
    const html = renderLocalLlmSafeText('`$x^2$`\n\n```tex\n$$x^2$$\n```');

    expect(html).toContain('<code>$x^2$</code>');
    expect(html).toContain('<pre><code>$$x^2$$</code></pre>');
  });

  it('splits inline code and math segments without treating escaped dollars as math', () => {
    expect(splitInlineLocalLlmSegments('Price is \\$5 and solve $x^2$ with `$y$`.')).toEqual([
      { type: 'text', value: 'Price is \\$5 and solve ' },
      { type: 'math', value: 'x^2' },
      { type: 'text', value: ' with ' },
      { type: 'code', value: '$y$' },
      { type: 'text', value: '.' }
    ]);
    expect(splitInlineLocalLlmSegments('No inline math across\n$x\n$ breaks.')).toEqual([
      { type: 'text', value: 'No inline math across\n$x\n$ breaks.' }
    ]);
  });

  it('wraps parsed math output for inline and display rendering', () => {
    expect(renderLocalLlmMath('x_1^2', false)).toContain('<span class="local-llm-math local-llm-math--inline">');
    expect(renderLocalLlmMath('\\frac{1}{x}', true)).toContain('display="block"');
    expect(renderLocalLlmMath('\\frac{1}{x}', true)).toContain('<mfrac><mrow><mn>1</mn></mrow><mrow><mi>x</mi></mrow></mfrac>');
  });

  it('parses latex scripts, commands, and escaped text content safely', () => {
    const mathml = new LocalLlmLatexParser('x_1^2 + \\sqrt{y} + \\text{<safe>} + \\unknown').parse();

    expect(mathml).toContain('<msubsup><mi>x</mi><mn>1</mn><mn>2</mn></msubsup>');
    expect(mathml).toContain('<msqrt><mrow><mi>y</mi></mrow></msqrt>');
    expect(mathml).toContain('<mtext>&lt;safe&gt;</mtext>');
    expect(mathml).toContain('<mi>unknown</mi>');
  });
});
