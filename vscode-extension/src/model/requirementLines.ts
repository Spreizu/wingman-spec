/** Lines of a requirement block that sit between its SHALL sentence and its first scenario (`Why:`, `Accepted:`, `Confirmed:`), and the proposal's `Owner approval:` line. */

/** The text after `Owner approval:` in a proposal (fences and HTML comments ignored), or null. */
export function proposalApproval(text: string): string | null {
  let fence = false;
  let out: string | null = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^(?:[-*]\s*)?\**Owner approval\**:\s*(.*)$/i.exec(raw.replace(/<!--.*?-->/g, '').trim());
    const v = (m?.[1] ?? '').replace(/\*/g, '').trim();
    if (v) out = v;
  }
  return out;
}

/** The reason of the `Accepted:` line of one requirement block (before its first scenario), or null. */
export function acceptedOf(raw: string): string | null {
  for (const l of raw.split('\n')) {
    if (/^####\s+Scenario:/.test(l)) break;
    const m = /^\s*(?:[-*]\s*)?\**Accepted\**:\s*(.+?)\s*$/i.exec(l);
    if (m) return (m[1] ?? '').replace(/\*/g, '');
  }
  return null;
}

/** The `Why:` line of one requirement block (the line sits under the SHALL sentence, before the first scenario), or null. */
export function whyOf(raw: string): string | null {
  for (const l of raw.split('\n')) {
    if (/^####\s+Scenario:/.test(l)) break;
    const m = /^\s*(?:[-*]\s*)?\**Why\**:\s*(.*?)\s*$/i.exec(l);
    if (m) return (m[1] ?? '').replace(/\*/g, '').trim();
  }
  return null;
}
