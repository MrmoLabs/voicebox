import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const sha256 = data => createHash('sha256').update(data).digest('hex');
let revision = null, dirty = null;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  dirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
} catch { /* A source archive can build without Git metadata. */ }
await writeFile('lib/build-info.json', JSON.stringify({ package: manifest.name, version: manifest.version,
  dsh: manifest.engines.dsh, revision, dirty, files: {
    'index.js': sha256(await readFile('lib/index.js')), 'client.js': sha256(await readFile('lib/client.js')),
  } }, null, 2) + '\n', 'utf8');
console.log('Built standalone host + DSH ModuleLoader client');
