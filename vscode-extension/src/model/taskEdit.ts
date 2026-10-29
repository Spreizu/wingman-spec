const CHECKBOX_RE = /^(- \[)( |x|X)(\]\s)/;

/** Flips the checkbox of a top-level task line. Returns undefined when the line is not a task. */
export function toggleTaskLine(line: string): string | undefined {
  const m = CHECKBOX_RE.exec(line);
  if (!m) return undefined;
  return line.replace(CHECKBOX_RE, (_all, open: string, mark: string, close: string) => `${open}${mark === ' ' ? 'x' : ' '}${close}`);
}

