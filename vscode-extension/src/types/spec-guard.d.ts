declare module '*spec-guard.cjs' {
  const guard: {
    ALTERNATIVES: Record<string, string>;
    evaluate(prompt: string, roots: string[]): { continue: boolean; user_message?: string };
    isInstalled(roots: string[], name: string): boolean;
    render(result: { continue: boolean; user_message?: string }, format: string): string;
  };
  export default guard;
}
