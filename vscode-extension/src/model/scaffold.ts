/** Pure helpers for the scaffold commands (new change, new ADR). */

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Returns an error message, or undefined when the name is a valid kebab-case change name. */
export function validateChangeName(name: string, existing: string[]): string | undefined {
  if (!KEBAB_RE.test(name)) return 'Use kebab-case: lowercase letters, digits and single hyphens (for example add-auth).';
  if (existing.includes(name)) return `A change named "${name}" already exists.`;
  return undefined;
}

export function validateAdrSlug(slug: string, existing: string[]): string | undefined {
  if (!KEBAB_RE.test(slug)) return 'The title must contain letters or digits.';
  if (existing.includes(slug)) return `adrs/${slug}.md already exists in this change.`;
  return undefined;
}

export function today(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface AdrDraft {
  title: string;
  change: string;
  date: string;
  /** Number of the promoted ADR this one replaces. */
  supersedes?: string;
}

/** A change ADR in the shape of the schema's `adr.md` template, with front matter filled in. */
export function adrTemplate(d: AdrDraft): string {
  const lines = ['---', `title: ${d.title}`, 'status: Proposed', `date: ${d.date}`, `change: ${d.change}`];
  if (d.supersedes) lines.push(`supersedes: ${d.supersedes}`);
  lines.push('---', '');
  return `${lines.join('\n')}
# ${d.title}

## Context

<!-- The forces at play: requirements, constraints, and why a decision is needed. -->

## Decision

<!-- What we chose, in one or two sentences, active voice: "We will ...". -->

## Alternatives considered

<!-- Each option and why it was rejected. -->
- **<Option A>**: <why not>

## Consequences

<!-- Good, bad, and follow-up work this decision creates. -->
- **Positive**:
- **Negative**:
- **Follow-ups**:
`;
}
