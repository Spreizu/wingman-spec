/**
 * A small, safe Markdown-to-HTML renderer for OpenSpec documents. Every piece of text is HTML-escaped
 * before any tag is emitted, raw HTML is never passed through, and only http(s) links become anchors.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Blanks HTML comments but keeps every newline, so line numbers stay valid. */
export function blankComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
}

function formatInline(escaped: string): string {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

export function renderInline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part, i) => (i % 2 === 1 ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : formatInline(escapeHtml(part))))
    .join('');
}

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const FENCE_RE = /^\s*```/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isBlockStart(line: string, next: string | undefined): boolean {
  return (
    HEADING_RE.test(line) ||
    FENCE_RE.test(line) ||
    LIST_RE.test(line) ||
    /^>/.test(line) ||
    /^(-{3,}|\*{3,})\s*$/.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEP_RE.test(next))
  );
}

function renderList(lines: string[]): string {
  interface Item {
    indent: number;
    ordered: boolean;
    text: string;
  }
  const items: Item[] = [];
  for (const raw of lines) {
    const m = LIST_RE.exec(raw);
    if (m) {
      items.push({ indent: (m[1] ?? '').replace(/\t/g, '  ').length, ordered: /\d/.test(m[2] ?? ''), text: m[3] ?? '' });
    } else if (items.length > 0 && raw.trim() !== '') {
      const last = items[items.length - 1];
      if (last) last.text += ` ${raw.trim()}`;
    }
  }

  let html = '';
  const stack: { indent: number; tag: string }[] = [];
  for (const item of items) {
    let top = stack[stack.length - 1];
    while (top && item.indent < top.indent) {
      html += `</li></${top.tag}>`;
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (!top || item.indent > top.indent) {
      const tag = item.ordered ? 'ol' : 'ul';
      html += `<${tag}>`;
      stack.push({ indent: item.indent, tag });
    } else {
      html += '</li>';
    }
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(item.text);
    html += task
      ? `<li class="task"><span class="cb${task[1] === ' ' ? '' : ' on'}"></span>${renderInline(task[2] ?? '')}`
      : `<li>${renderInline(item.text)}`;
  }
  while (stack.length > 0) {
    const top = stack.pop();
    html += `</li></${top?.tag ?? 'ul'}>`;
  }
  return html;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function renderTable(header: string, rows: string[]): string {
  const head = splitRow(header)
    .map((c) => `<th>${renderInline(c)}</th>`)
    .join('');
  const body = rows
    .map((r) => `<tr>${splitRow(r).map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderMarkdown(text: string): string {
  const lines = blankComments(text.replace(/\r\n/g, '\n')).split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const next = lines[i + 1];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    if (FENCE_RE.test(line)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      const level = (h[1] ?? '#').length;
      out.push(`<h${level}>${renderInline(h[2] ?? '')}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (/^>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>/.test(lines[i] ?? '')) {
        quote.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && next !== undefined && TABLE_SEP_RE.test(next)) {
      const rows: string[] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(lines[i] ?? '');
        i += 1;
      }
      out.push(renderTable(line, rows));
      continue;
    }

    if (LIST_RE.test(line)) {
      const block: string[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? '';
        if (cur.trim() === '') {
          const after = lines[i + 1];
          if (after !== undefined && (LIST_RE.test(after) || /^\s+\S/.test(after))) {
            i += 1;
            continue;
          }
          break;
        }
        if (!LIST_RE.test(cur) && !/^\s+\S/.test(cur)) break;
        block.push(cur);
        i += 1;
      }
      out.push(renderList(block));
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && (para.length === 0 || !isBlockStart(lines[i] ?? '', lines[i + 1]))) {
      para.push((lines[i] ?? '').trim());
      i += 1;
    }
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

export interface MarkdownSection {
  title: string;
  body: string;
}

/** Splits a document on its `## ` headings. Text before the first heading is the preamble. */
export function splitSections(text: string): { preamble: string; sections: MarkdownSection[] } {
  const lines = blankComments(text.replace(/\r\n/g, '\n')).split('\n');
  const sections: MarkdownSection[] = [];
  const pre: string[] = [];
  let current: { title: string; body: string[] } | undefined;
  let fenced = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) fenced = !fenced;
    const h = !fenced ? /^##\s+(.*?)\s*$/.exec(line) : null;
    if (h) {
      if (current) sections.push({ title: current.title, body: current.body.join('\n').trim() });
      current = { title: h[1] ?? '', body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      pre.push(line);
    }
  }
  if (current) sections.push({ title: current.title, body: current.body.join('\n').trim() });
  return { preamble: pre.join('\n').trim(), sections };
}

/** Text for a tree label, tooltip, quick pick or hover: the same words with the markdown backtick marks dropped (never a literal backtick). */
export const plain = (s: string): string => s.replace(/`/g, '');
