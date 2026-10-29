declare module '*visual-check.cjs' {
  const visual: {
    /** One ```visual block body: errors are strings like "line 12: unknown field ...". */
    parseBlock(body: string[], firstLine: number): { route: string | null; component: string | null; errors: string[] };
  };
  export default visual;
}
