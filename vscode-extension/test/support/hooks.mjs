// Resolves the bare `vscode` import to the stub, so the editor layer can be imported and driven under `node --test`.
export async function resolve(specifier, context, next) {
  if (specifier === 'vscode') return { url: new URL('./vscodeStub.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
