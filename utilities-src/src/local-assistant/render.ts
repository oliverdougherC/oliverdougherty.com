/** Safe, dependency-free Markdown and common LaTeX. Model output never becomes HTML. */
const MATH = 'http://www.w3.org/1998/Math/MathML';
const SYMBOLS: Record<string, string> = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', phi: 'φ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', times: '×', cdot: '·', div: '÷', pm: '±', leq: '≤', geq: '≥', neq: '≠', approx: '≈', infty: '∞', sum: '∑', prod: '∏', int: '∫', to: '→', in: '∈' };
function mathNode(doc: Document, tag: string, ...children: (Node | string)[]): Element {
  const node = doc.createElementNS(MATH, tag);
  for (const child of children) node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  return node;
}
export function renderMath(source: string, doc: Document, display = false): Element {
  let index = 0;
  let depth = 0;
  const atom = (): Element => {
    if (++depth > 40) throw new Error('Math nesting limit');
    while (/\s/.test(source[index] ?? '') && index < source.length) index++;
    let value: Element;
    const char = source[index++];
    if (char === '{') value = row(true);
    else if (char === '\\') {
      const command = /^[a-zA-Z]+/.exec(source.slice(index))?.[0] ?? source[index++] ?? '';
      if (/^[a-zA-Z]+$/.test(command)) index += command.length;
      if (command === 'frac') value = mathNode(doc, 'mfrac', atom(), atom());
      else if (command === 'sqrt') value = mathNode(doc, 'msqrt', atom());
      else if (['text', 'mathrm', 'mathbf'].includes(command)) {
        const text = /^\{([^{}]*)\}/.exec(source.slice(index));
        if (!text) throw new Error('Unfinished text');
        index += text[0].length;
        value = mathNode(doc, command === 'text' ? 'mtext' : 'mi', text[1]);
        if (command === 'mathbf') value.setAttribute('mathvariant', 'bold');
      } else if (command === 'left' || command === 'right') value = atom();
      else if (SYMBOLS[command]) value = mathNode(doc, 'mo', SYMBOLS[command]);
      else if (/^[{}_% ]$/.test(command)) value = mathNode(doc, 'mo', command);
      else throw new Error('Unsupported command');
    } else if (char === undefined || char === '}') throw new Error('Unfinished expression');
    else value = mathNode(doc, /\d/.test(char) ? 'mn' : /[a-zA-Z]/.test(char) ? 'mi' : 'mo', char);
    depth--;
    return value;
  };
  const row = (group = false): Element => {
    const result = mathNode(doc, 'mrow');
    while (index < source.length && source[index] !== '}') {
      if (/\s/.test(source[index])) { index++; continue; }
      let base = atom();
      let sub: Element | undefined;
      let sup: Element | undefined;
      while (source[index] === '^' || source[index] === '_') {
        const marker = source[index++];
        if (marker === '^') sup = atom(); else sub = atom();
      }
      if (sub && sup) base = mathNode(doc, 'msubsup', base, sub, sup);
      else if (sub || sup) base = mathNode(doc, sub ? 'msub' : 'msup', base, (sub ?? sup)!);
      result.append(base);
    }
    if (group && source[index++] !== '}') throw new Error('Unfinished group');
    return result;
  };
  try {
    const root = mathNode(doc, 'math', row());
    if (index !== source.length) throw new Error('Unbalanced group');
    root.setAttribute('display', display ? 'block' : 'inline');
    root.setAttribute('aria-label', source);
    return root;
  } catch {
    const fallback = doc.createElement('code');
    fallback.className = 'la-math-source';
    fallback.textContent = source;
    fallback.title = 'LaTeX source (this expression is outside the supported math subset)';
    return fallback;
  }
}
function inline(source: string, parent: Node, doc: Document): void {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\)|\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    parent.appendChild(doc.createTextNode(source.slice(offset, match.index)));
    const text = match[0];
    let node: Element;
    if (text.startsWith('$') || text.startsWith('\\')) {
      const block = text.startsWith('$$') || text.startsWith('\\[');
      const trim = text.startsWith('$$') || text.startsWith('\\') ? 2 : 1;
      node = renderMath(text.slice(trim, -trim), doc, block);
    } else if (text.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(text)!;
      node = doc.createElement('span');
      // Only explicit web/mail links; never javascript, data, relative or encoded protocols.
      if (/^https?:\/\//i.test(link[2]) || /^mailto:/i.test(link[2])) {
        node = doc.createElement('a');
        node.setAttribute('href', link[2]);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
      node.textContent = link[1];
    } else {
      const strong = text.startsWith('**');
      node = doc.createElement(text.startsWith('`') ? 'code' : strong ? 'strong' : 'em');
      node.textContent = text.slice(strong ? 2 : 1, strong ? -2 : -1);
    }
    parent.appendChild(node);
    offset = match.index! + text.length;
  }
  parent.appendChild(doc.createTextNode(source.slice(offset)));
}
export function renderMarkdown(source: string, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index++];
    if (/^\s*```/.test(line)) {
      const language = line.replace(/^\s*```/, '').trim();
      const block = doc.createElement('div'); block.className = 'la-code';
      const header = doc.createElement('div'); header.className = 'la-code-heading';
      const label = doc.createElement('span'); label.textContent = language || 'Code';
      const copy = doc.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy'; copy.dataset.copyCode = '';
      header.append(label, copy);
      const pre = doc.createElement('pre'); const code = doc.createElement('code');
      const content: string[] = [];
      while (index < lines.length && !/^\s*```/.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      code.textContent = content.join('\n'); pre.append(code); block.append(header, pre); fragment.append(block);
    } else if (line.trim() === '$$' || line.trim() === '\\[') {
      const close = line.trim() === '$$' ? '$$' : '\\]';
      const content: string[] = [];
      while (index < lines.length && lines[index].trim() !== close) content.push(lines[index++]);
      if (index < lines.length) index++;
      fragment.append(renderMath(content.join('\n'), doc, true));
    } else if (line.trim()) {
      const heading = /^(#{1,6})\s+(.*)/.exec(line);
      const bullet = /^\s*(?:[-*]|\d+\.)\s+(.*)/.exec(line);
      const quote = /^>\s?(.*)/.exec(line);
      const element = doc.createElement(heading ? `h${Math.min(6, heading[1].length + 2)}` : bullet ? 'li' : quote ? 'blockquote' : 'p');
      inline(heading?.[2] ?? bullet?.[1] ?? quote?.[1] ?? line, element, doc);
      if (bullet) {
        let list = fragment.lastChild;
        const ordered = /^\s*\d+\./.test(line);
        if (!(list instanceof doc.defaultView!.HTMLElement) || list.tagName !== (ordered ? 'OL' : 'UL')) { list = doc.createElement(ordered ? 'ol' : 'ul'); fragment.append(list); }
        list.appendChild(element);
      } else fragment.append(element);
    }
  }
  return fragment;
}
