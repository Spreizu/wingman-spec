/**
 * Plan and file rules the editor needs synchronously while you type. TS ports of the CLI's internal/quality and internal/trace
 * helpers (same regular expressions); every rule that needs more than one file stays in the CLI (`wingman-spec problems --json`).
 */

/** Implementation-task caps per declared size. */
export const CAPS = { S: 3, M: 5, L: 8 } as const;
export type Size = keyof typeof CAPS;

const REVIEW_RE = /\bcode review\b|\breview\b.*\b(group|change)\b/i;
const CLOSEOUT_RE = /full (test )?suite|wingman-spec validate|validation passes|every (spec )?scenario is covered|every visual scenario passes|visual check and review/i;
const isQaGroup = (title: string): boolean => /^qa[ -]?fix/i.test(title);

/** A `Close-out` group: the change's final checks. */
export const isCloseoutGroup = (title: string): boolean => /^close-?out\b/i.test(title);
/** A review task (label N.R, or a title asking for a code review). */
export const isReviewTask = (label: string | undefined, title: string | undefined): boolean => /\.R$/i.test(label ?? '') || REVIEW_RE.test(title ?? '');
/** Counts against the Size cap: not a review, not a close-out task, not in a `QA fix` group. */
export const isImplementationTask = (groupTitle: string, label: string | undefined, title: string | undefined): boolean =>
  !isQaGroup(groupTitle) && !isReviewTask(label, title) && !isCloseoutGroup(groupTitle) && !CLOSEOUT_RE.test(title ?? '');

const stripComments = (t: string): string => t.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));

export interface ProposalSize {
  size: Size | null;
  line: number | null;
  risk: string[] | null;
  riskLine: number | null;
}

/** `Size: S|M|L` and `Risk: none|<kinds>` lines of proposal.md (first occurrence, comments ignored). */
export function proposalSize(text: string): ProposalSize {
  const out: ProposalSize = { size: null, line: null, risk: null, riskLine: null };
  stripComments(text).replace(/\r\n/g, '\n').split('\n').forEach((l, i) => {
    const s = out.size ? null : /^\s*(?:[-*]\s+)?\**Size\**:\s*\**\s*([SML])\b/i.exec(l);
    if (s?.[1]) {
      out.size = s[1].toUpperCase() as Size;
      out.line = i + 1;
    }
    const r = out.risk !== null ? null : /^\s*(?:[-*]\s+)?\**Risk\**:\s*\**\s*(.*?)\s*$/i.exec(l);
    if (r) {
      const v = (r[1] ?? '').replace(/[`*]/g, '').trim().toLowerCase();
      out.risk = /^(none|no|-|n\/a)?$/.test(v) ? [] : v.split(/\s*[,;/]\s*|\s+and\s+/).map((x) => x.trim().replace(/\s+/g, '-')).filter(Boolean);
      out.riskLine = i + 1;
    }
  });
  return out;
}

/**
 * The "no architectural decision" record of a change (`adrs/none.md`, `status: none`): not an ADR. It counts as none when the file
 * is named none.md, when its front matter says `status: none` (any case), or both.
 */
export function isNoneAdr(fileName: string, text: string): boolean {
  if (fileName.toLowerCase() === 'none.md') return true;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const st = fm ? (/^status:[ \t]*(.*)$/im.exec(fm[1] ?? '')?.[1] ?? '') : '';
  return st.trim().replace(/^["']|["']$/g, '').toLowerCase() === 'none';
}

/** A `[capability/scenario-slug]` test tag. */
export const TAG_RE = /\[([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\]/g;

const SKIP_EXT = /\.(md|markdown|mdx|txt|json|jsonc|lock|lockb|svg|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|map|min\.js|snap|csv|tsv|zip|gz|wasm)$/i;
const SKIP_DIR = /^(node_modules|\.git|dist|build|out|coverage|vendor|\.venv|venv|target|__pycache__|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.wingman-spec|\.cursor|\.claude|\.agents|\.codex)$/;
/** True for a file the CLI scans for markers (relative, `/`-separated path). */
export const isScannable = (f: string): boolean => !f.split('/').slice(0, -1).some((seg) => SKIP_DIR.test(seg)) && !SKIP_EXT.test(f);

const plan = { CAPS, isCloseoutGroup, isReviewTask, isImplementationTask, proposalSize, isNoneAdr, TAG_RE, isScannable };
export default plan;
