import type { FrontMatter } from './types.ts';

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** True for empty values and unfilled template placeholders such as `<!-- YYYY-MM-DD -->`. */
export function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined) return true;
  const v = value.trim();
  return v === '' || v.startsWith('<!--');
}

/**
 * Parses the flat `key: value` front matter used by ADR files. Nested YAML is not supported
 * on purpose: the schema only ever writes flat keys.
 */
export function parseFrontMatter(text: string): FrontMatter {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { fields: {}, body: normalized, hasFrontMatter: false };

  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv?.[1] !== undefined) fields[kv[1]] = unquote(kv[2] ?? '');
  }
  return { fields, body: normalized.slice(match[0].length), hasFrontMatter: true };
}

/** Reads one flat key from a YAML-ish file such as `.openspec.yaml` or `config.yaml`. */
export function readYamlKey(text: string, key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*:\\s*(.*?)\\s*(?:#.*)?$`, 'm');
  const m = re.exec(text.replace(/\r\n/g, '\n'));
  if (!m || m[1] === undefined || m[1] === '') return undefined;
  return unquote(m[1]);
}
