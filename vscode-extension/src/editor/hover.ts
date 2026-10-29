import { join } from 'node:path';
import * as vscode from 'vscode';
import { plain } from '../model/markdown.ts';
import { isPlaceholder } from '../model/frontMatter.ts';
import { findRequirement, parseSpec } from '../model/specParser.ts';
import { readTextSafe } from '../model/specFiles.ts';
import type { ProjectStore } from '../store.ts';
import { classify } from './context.ts';

function md(): vscode.MarkdownString {
  const m = new vscode.MarkdownString(undefined, true);
  m.isTrusted = false;
  return m;
}

const esc = (s: string): string => plain(s).replace(/[\\`*_{}[\]()#+!|~<>-]/g, '\\$&');

export class SpecHoverProvider implements vscode.HoverProvider {
  private readonly store: ProjectStore;

  constructor(store: ProjectStore) {
    this.store = store;
  }

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const ctx = classify(this.store.projects, doc.uri.fsPath);
    if (!ctx) return undefined;
    const line = doc.lineAt(pos.line).text;

    if (ctx.kind === 'tasks') {
      const m = /^(\s+- Spec:\s*)(.+?)\s*$/.exec(line);
      if (!m) return undefined;
      const [cap, req] = (m[2] ?? '').split('>').map((s) => s.trim());
      if (!cap) return undefined;
      const delta = ctx.change.capabilities.find((c) => c.name === cap);
      const path = delta?.path ?? join(ctx.project.root, 'openspec', 'specs', cap, 'spec.md');
      const text = await readTextSafe(path);
      if (text === undefined) return undefined;
      const spec = parseSpec(text);
      const found = req ? findRequirement(spec, req) : undefined;
      const out = md();
      if (!found) {
        out.appendMarkdown(`**${esc(cap)}**\n\n${esc(spec.purpose || 'No purpose recorded.')}`);
        return new vscode.Hover(out);
      }
      out.appendMarkdown(`**${esc(found.name)}** (${esc(cap)}${delta ? `, ${delta.kind}` : ''})\n\n${esc(found.statement)}\n\n`);
      for (const s of found.scenarios) {
        out.appendMarkdown(`- *${esc(s.name)}*\n`);
        for (const st of s.steps) out.appendMarkdown(`  - **${st.keyword}** ${esc(st.text)}\n`);
      }
      return new vscode.Hover(out);
    }

    if (ctx.kind === 'sourceAdr' || ctx.kind === 'rootAdr') {
      const m = /^supersedes:\s*(\d{4})\s*$/.exec(line);
      if (!m?.[1] || isPlaceholder(m[1])) return undefined;
      const target = ctx.project.adrs.find((a) => a.number === m[1]);
      const out = md();
      out.appendMarkdown(target ? `**${esc(target.number)} ${esc(target.title)}**\n\nStatus: ${esc(target.status || 'unknown')}` : `No promoted ADR ${m[1]} exists.`);
      return new vscode.Hover(out);
    }
    return undefined;
  }
}
