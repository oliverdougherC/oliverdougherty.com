import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderMath } from '../src/local-assistant/render';
const doc = new JSDOM('<!doctype html>').window.document;
const render = (text: string) => { const container = doc.createElement('div'); container.append(renderMarkdown(text, doc)); return container; };
describe('safe assistant rendering', () => {
  it('renders common Markdown, links and copyable code without evaluating HTML', () => {
    const output = render('# Heading\n**bold** and *emphasis* and `code`\n- first\n- second\n[Safe](https://example.com)\n```js\n<script>alert(1)</script>\n```');
    expect(output.querySelector('h3')?.textContent).toBe('Heading');
    expect(output.querySelectorAll('li')).toHaveLength(2);
    expect(output.querySelector('strong')?.textContent).toBe('bold');
    expect(output.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(output.querySelector('pre code')?.textContent).toBe('<script>alert(1)</script>');
    expect(output.querySelector('script')).toBeNull();
    expect(output.querySelector('[data-copy-code]')).not.toBeNull();
  });
  it('rejects unsafe link protocols and displays untrusted tags as text', () => {
    const output = render('[bad](javascript:alert) [bad](data:text/html,evil) <img src=x onerror=alert(1)>');
    expect(output.querySelector('a')).toBeNull();
    expect(output.querySelector('img')).toBeNull();
    expect(output.textContent).toContain('<img');
  });
  it('renders incomplete streamed Markdown and fences safely', () => {
    const output = render('**not finished\n```html\n<img onerror=alert(1)>');
    expect(output.querySelector('pre code')?.textContent).toContain('<img');
    expect(output.querySelector('img')).toBeNull();
  });
  it('renders fractions, roots, scripts and Greek symbols as MathML', () => {
    const output = renderMath('\\frac {x_1^2}{\\sqrt{\\alpha}}', doc);
    expect(output.querySelector('mfrac')).not.toBeNull();
    expect(output.querySelector('msubsup')).not.toBeNull();
    expect(output.querySelector('msqrt')).not.toBeNull();
    expect(output.textContent).toContain('α');
  });
  it('supports inline and display delimiters', () => {
    const output = render('Here is $x^2$ and \\(y_1\\).\n$$\n\\frac{1}{2}\n$$');
    expect(output.querySelectorAll('math')).toHaveLength(3);
    expect(output.querySelector('math[display="block"] mfrac')).not.toBeNull();
  });
  it('retains unsupported, incomplete and deeply nested LaTeX as safe source', () => {
    for (const source of ['\\unsupported{x}', '\\frac{1}', '{'.repeat(60) + 'x' + '}'.repeat(60)]) {
      const result = renderMath(source, doc);
      expect(result.tagName).toBe('CODE');
      expect(result.textContent).toBe(source);
    }
  });
});
