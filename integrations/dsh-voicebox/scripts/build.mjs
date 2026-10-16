import { mkdir, writeFile } from 'node:fs/promises';

const result = await Bun.build({
  entrypoints: ['src/client.jsx'], target: 'browser', format: 'cjs',
  external: ['react', 'react/jsx-runtime'],
  define: { 'process.env.NODE_ENV': '"production"' },
  jsx: { runtime: 'automatic', development: false },
});
if (!result.success) throw new AggregateError(result.logs, 'Voicebox client build failed');
const code = await result.outputs[0].text();
await mkdir('lib', { recursive: true });
const host = await Bun.build({ entrypoints: ['src/index.js'], target: 'node', format: 'esm' });
if (!host.success) throw new AggregateError(host.logs, 'Voicebox host build failed');
await writeFile('lib/index.js', await host.outputs[0].text(), 'utf8');
await writeFile('lib/client.js',
  'window.__ModuleLoader__.load({id:"dsh-voicebox",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n'
  + code + '\nreturn module.exports;}});\n', 'utf8');
console.log('Built standalone host + DSH ModuleLoader client');
