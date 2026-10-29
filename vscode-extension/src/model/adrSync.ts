import { isPlaceholder, parseFrontMatter } from './frontMatter.ts';
import quality from '../../../project-template/openspec/scripts/quality.cjs';
import type { AdrSyncResult, RootAdr, SourceAdr } from './types.ts';

const ROOT_NAME_RE = /^(\d{4})-(.+)\.md$/;

export function parseSourceAdr(slug: string, path: string, text: string): SourceAdr {
  const fm = parseFrontMatter(text);
  return { slug, path, none: quality.isNoneAdr(`${slug}.md`, text), fields: fm.fields, body: fm.body };
}

/** The one sentence a none record gives for "no decision" (first body line that is not a heading or comment). */
export function noDecisionReason(source: SourceAdr): string {
  const body = source.body.replace(/<!--[\s\S]*?-->/g, '');
  const line = body.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#'));
  return line ?? '';
}

/** Returns undefined for files that are not `NNNN-<slug>.md` (for example README.md). */
export function parseRootAdr(fileName: string, path: string, text: string): RootAdr | undefined {
  const m = ROOT_NAME_RE.exec(fileName);
  if (!m?.[1] || !m[2]) return undefined;
  if (quality.isNoneAdr(fileName, text)) return undefined;
  const fm = parseFrontMatter(text);
  const f = fm.fields;
  return {
    number: m[1],
    slug: m[2],
    path,
    title: f['title'] ?? '',
    status: f['status'] ?? '',
    date: f['date'] ?? '',
    change: f['change'] ?? '',
    source: f['source'] ?? '',
    supersedes: f['supersedes'] ?? '',
    body: fm.body,
    fields: f,
  };
}

function normalizeBody(body: string): string {
  return body.replace(/^\n+/, '').trimEnd();
}

function realSupersedes(value: string | undefined): string {
  return isPlaceholder(value) ? '' : (value ?? '').trim();
}

/**
 * Computes the sync state of one change ADR against the promoted ADRs. This mirrors step 2
 * of `/spec-sync`: identity is `source: <change>/<slug>`, `status: none` is skipped, unfilled
 * templates are never promoted, and a promoted file is current when its front matter and body
 * equal what sync would write.
 */
export function computeAdrSync(change: string, source: SourceAdr, roots: RootAdr[]): AdrSyncResult {
  const f = source.fields;
  if (source.none) {
    return { state: 'none', detail: 'Records that this change has no significant decision; skipped by sync.' };
  }
  if (isPlaceholder(f['title']) || isPlaceholder(f['date'])) {
    return { state: 'unfilled', detail: 'Title or date is empty or still a template placeholder.' };
  }

  const supersedes = realSupersedes(f['supersedes']);
  if (supersedes && !roots.some((r) => r.number === supersedes)) {
    return { state: 'error', detail: `Supersedes ${supersedes}, but no adr/${supersedes}-*.md exists.` };
  }

  const identity = `${change}/${source.slug}`;
  const target = roots.find((r) => r.source === identity);
  if (!target) return { state: 'not-promoted', detail: 'Not yet promoted to the root ADR directory.' };

  const keepStatus = /^(superseded|deprecated)/i.test(target.status);
  const expectedStatus = keepStatus ? target.status : 'Accepted';
  const diffs: string[] = [];
  if (target.title !== (f['title'] ?? '').trim()) diffs.push('title');
  if (target.status !== expectedStatus) diffs.push('status');
  if (target.date !== (f['date'] ?? '').trim()) diffs.push('date');
  if (target.change !== change) diffs.push('change');
  if (realSupersedes(target.fields['supersedes']) !== supersedes) diffs.push('supersedes');
  if (normalizeBody(target.body) !== normalizeBody(source.body)) diffs.push('body');

  if (supersedes) {
    const old = roots.find((r) => r.number === supersedes);
    if (old && !/^superseded/i.test(old.status)) diffs.push(`ADR ${supersedes} not marked superseded`);
  }

  if (diffs.length > 0) {
    return { state: 'out-of-date', detail: `Differs from the promoted file: ${diffs.join(', ')}.`, target };
  }
  return { state: 'up-to-date', detail: `Promoted as ${target.number}-${target.slug}.md.`, target };
}

/** Synced means every ADR is promoted and current, or deliberately skipped (`status: none`). Errors and unfilled templates are not synced. */
export function isSynced(results: AdrSyncResult[]): boolean {
  return results.every((r) => r.state === 'up-to-date' || r.state === 'none');
}
