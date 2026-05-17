import {
  compactLocalLlmMessages,
  normalizeLocalLlmProgressState,
  renderLocalLlmSafeText
} from '@utilities/localLlmState';

describe('local LLM state helpers', () => {
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
    expect(normalizeLocalLlmProgressState('progress_total')).toBe('loading');
    expect(normalizeLocalLlmProgressState('done')).toBe('optimizing');
  });

  it('escapes links and images instead of reintroducing raw href/src attributes', () => {
    const html = renderLocalLlmSafeText('[x](javascript:alert(1))\n\n![bad](x onerror=alert(1))');

    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('src=');
    expect(html).toContain('[x](javascript:alert(1))');
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
});
