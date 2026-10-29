declare module '*chronology.cjs' {
  /** `source`: where the time came from (`file` = recorded by our archive step; `git`/`birth`/`mtime`/`name` = fallbacks; `none` = nothing known). */
  export interface Stamp {
    at: string;
    ms: number;
    source: 'file' | 'git' | 'birth' | 'mtime' | 'name' | 'none';
  }
  const chronology: {
    isoLocal(d?: Date): string;
    parseTime(s: unknown): number;
    gitAdded(dir: string): Map<string, { at: string; ms: number }>;
    archiveStamp(archiveDir: string, dirName: string, git?: Map<string, { at: string; ms: number }>): Stamp;
    createdStamp(changeDir: string, git?: Map<string, { at: string; ms: number }>): Stamp;
    sortByTime<T>(items: T[], stampOf: (x: T) => Stamp, nameOf: (x: T) => string, newestFirst?: boolean): T[];
    archiveOrder(archiveDir: string, newestFirst?: boolean): { name: string; stamp: Stamp }[];
    sortRuns(ids: string[]): string[];
    latestRun(ids: string[]): string | undefined;
    sortRecords<T extends { at: string }>(list: T[]): T[];
    clock(at: string | number): string;
    when(stamp: Stamp): string;
    SOURCE_TEXT: Record<string, string>;
  };
  export default chronology;
}
