/** First useful paragraph after `## Why`, else the first paragraph of the document. */
export function excerptWhy(markdown: string | undefined, max = 220): string {
  if (markdown === undefined || markdown.trim() === '') return '';
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const why = /(?:^|\n)##[ \t]+Why[ \t]*\n([\s\S]*?)(?=\n##[ \t]|\n#[^#]|$)/i.exec(normalized);
  const chunk = why?.[1] ?? normalized;
  const para = chunk
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .replace(/^#+\s+.*$/gm, '')
        .replace(/[*_`]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .find((p) => p.length > 0);
  if (!para) return '';
  return para.length <= max ? para : `${para.slice(0, max - 1).trimEnd()}...`;
}
