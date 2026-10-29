declare module '*anchorguard.cjs' {
  export interface AnchorEvent {
    kind: 'modified' | 'added' | 'removed';
    key: string;
    /** 1-based line of the marker. */
    line: number;
    header: string;
    whole: boolean;
    renamed?: boolean;
    body?: string;
  }
  const guard: {
    compareAnchors(baseText: string, curText: string): AnchorEvent[];
  };
  export default guard;
}
