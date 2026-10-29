import { build } from 'esbuild';

const production = process.argv.includes('--production');

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
});
