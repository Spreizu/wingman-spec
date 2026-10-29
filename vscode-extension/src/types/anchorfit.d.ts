declare module '*anchorfit.cjs' {
  export interface FitFinding {
    file: string;
    /** 1-based line of the marker. */
    line: number;
    key: string;
    /** `over-anchored` (a count with weak anchors), `many-anchors` (info), `boilerplate-anchor`, `crowded-unit`, `foreign-anchor` or `unrelated-anchor`. */
    kind: string;
    text: string;
    /** Deleting the marker is the suggested fix (never true for the last code anchor of a requirement). */
    remove: boolean;
    /** An info line (`many-anchors`): never an error. */
    info?: boolean;
  }
  export interface FitInput {
    files: { file: string; text: string; test: boolean }[];
    reqs: Map<string, { name: string; block: string; cap: string }>;
    capNames: Set<string>;
    taskCaps?: Map<string, Set<string>> | null;
    max?: number;
    many?: Set<string>;
  }
  const fit: {
    fitFindings(o: FitInput): FitFinding[];
    fitConfig(configFiles: string[], read: (f: string) => string | undefined | null): { level: 'warn' | 'error' | 'off'; max: number; many: Set<string> };
  };
  export default fit;
}
