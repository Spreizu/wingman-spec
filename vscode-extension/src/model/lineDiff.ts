export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

const MAX_CELLS = 400_000;

/** Line diff by longest common subsequence. Falls back to delete-all/add-all for very large inputs. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text): DiffLine => ({ kind: 'del', text })), ...b.map((text): DiffLine => ({ kind: 'add', text }))];
  }

  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i] as number[];
      row[j] = a[i] === b[j] ? ((table[i + 1] as number[])[j + 1] ?? 0) + 1 : Math.max((table[i + 1] as number[])[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' });
      i++;
      j++;
    } else if (((table[i + 1] as number[])[j] ?? 0) >= ((table[i] as number[])[j + 1] ?? 0)) {
      out.push({ kind: 'del', text: a[i] ?? '' });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] ?? '' });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] ?? '' });
  while (j < m) out.push({ kind: 'add', text: b[j++] ?? '' });
  return out;
}

export function hasChanges(diff: DiffLine[]): boolean {
  return diff.some((d) => d.kind !== 'same');
}
