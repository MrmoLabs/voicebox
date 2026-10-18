// Copied into a temporary consumer; deliberately no imports from the checkout.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const entry = require.resolve('dsh-voicebox');
const directory = path.dirname(path.dirname(entry));
const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
assert.equal(manifest.version, process.argv[2]);
const host = await import('dsh-voicebox');
assert.equal(typeof host.apply, 'function');
assert.equal(host.Config({}).get().modelSize, '0.6B');
let definition;
vm.runInNewContext(await readFile(path.join(directory, 'lib/client.js'), 'utf8'), {
  window: { __ModuleLoader__: { load(value) { definition = value; } } },
});
assert.equal(definition.id, 'dsh-voicebox');
const requests = [];
const client = definition.factory(name => {
  requests.push(name);
  assert(['react', 'react/jsx-runtime'].includes(name), `Unexpected runtime dependency: ${name}`);
  return require(name);
});
assert.equal(typeof client.apply, 'function');
assert.equal(client.name, 'dsh-voicebox');
console.log(JSON.stringify({ version: manifest.version, host: 'loaded', client: 'loaded', external: [...new Set(requests)] }));
