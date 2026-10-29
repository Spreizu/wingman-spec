declare module '*quality.cjs' {
  const quality: {
    /** Plan rules of tasks.md: `line` is 1-based. */
    planLint(text: string, opts?: { size?: string; review?: boolean }): { problems: { line: number; severity: 'error' | 'warning' | 'info'; kind: string; text: string }[] };
    /** `[capability/scenario-slug]` (global: use matchAll). */
    TAG_RE: RegExp;
    CAPS: { S: number; M: number; L: number };
    /** `Size:` and `Risk:` of proposal.md (`risk` is null without a Risk line, [] for "none"). */
    proposalSize(text: string): { size: 'S' | 'M' | 'L' | null; line: number | null; risk: string[] | null };
    /** True for the "no architectural decision" record: file name none.md and/or `status: none` (any case) in the front matter. */
    isNoneAdr(fileName: string, text: string): boolean;
    isReviewTask(label: string, title: string): boolean;
    isCloseoutGroup(title: string): boolean;
    isImplementationTask(groupTitle: string, label: string, title: string): boolean;
  };
  export default quality;
}
