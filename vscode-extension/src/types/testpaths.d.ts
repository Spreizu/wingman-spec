declare module '*testpaths.cjs' {
  const testPaths: {
    CODE_EXT_RE: RegExp;
    isTestPath(f: string): boolean;
    isTestFile(f: string): boolean;
    isUiFile(f: string, exts?: string[]): boolean;
  };
  export default testPaths;
}
