import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const appRequire = createRequire(new URL('../../../app/package.json', import.meta.url));
const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL('../tests/preview.jsx', import.meta.url))],
  outdir: fileURLToPath(new URL('../../../.tmp-dsh-preview/', import.meta.url)),
  target: 'browser', format: 'esm', external: ['/client.js'],
  define: { 'process.env.NODE_ENV': '"production"' }, jsx: { development: false },
  plugins: [{ name: 'workspace-react', setup(build) {
    build.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, (args) => ({ path: appRequire.resolve(args.path) }));
  } }],
});
if (!result.success) throw new AggregateError(result.logs, 'Preview build failed');
console.log('Built browser fixture in .tmp-dsh-preview');
