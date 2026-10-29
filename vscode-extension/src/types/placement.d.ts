declare module '*placement.cjs' {
  export interface PlacementFinding {
    /** 1-based line of the marker. */
    line: number;
    kind: 'trailing-marker' | 'duplicate-marker' | 'file-top-marker' | 'detached-marker';
    keys: string[];
    text: string;
  }
  const placement: {
    MARKER_LEADER: RegExp;
    KEY: RegExp;
    COMMENT_LINE: RegExp;
    ANNOTATION: RegExp;
    CLOSING: RegExp;
    isUnitStart(line: string): boolean;
    placementFindings(text: string, isTest?: boolean): PlacementFinding[];
  };
  export default placement;
}
