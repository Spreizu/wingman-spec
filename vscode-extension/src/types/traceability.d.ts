declare module '*traceability.cjs' {
  const traceability: {
    /** A file the anchor scan reads (relative path). */
    isScannable(f: string): boolean;
  };
  export default traceability;
}
