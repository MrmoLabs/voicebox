// Real tarballs + a fresh dependency root. No Desktop profile, GPU or microphone.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInstalledArtifact } from './verify-artifact.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const plugin = path.join(root, 'integrations/dsh-voicebox');
const output = path.join(root, 'release/dsh-voicebox-candidate');
const baseline = process.env.VOICEBOX_PACKAGE_BASELINE || '249ace262eed07591cfce6353160824e7631f1f9';
const bun = process.execPath;
function run(command, args, cwd) {
  // Honour the operating system's trust store without disabling TLS validation.
  if (command === bun) args = ['--use-system-ca', ...args];
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
await mkdir(output, { recursive: true });
// Outside the checkout: module resolution cannot borrow app/node_modules.
const isolated = await mkdtemp(path.join(tmpdir(), 'dsh-voicebox-package-'));
const before = path.join(isolated, 'baseline');
const install = path.join(isolated, 'consumer');
await mkdir(before); await mkdir(install);
run('git', ['archive', '--format=tar', `--output=${path.join(before, 'source.tar')}`, baseline, '--',
  'app/src/lib/audio', 'integrations/dsh-voicebox'], root);
run('tar', ['-xf', 'source.tar'], before);
const beforePlugin = path.join(before, 'integrations/dsh-voicebox');
run(bun, ['install', '--frozen-lockfile', '--ignore-scripts'], beforePlugin);
run(bun, ['run', 'build'], beforePlugin);
const previous = JSON.parse(await readFile(path.join(beforePlugin, 'package.json'), 'utf8'));
run(bun, ['pm', 'pack', '--ignore-scripts', '--destination', output, '--quiet'], beforePlugin);
run(bun, ['pm', 'pack', '--destination', output, '--quiet'], plugin);
const next = JSON.parse(await readFile(path.join(plugin, 'package.json'), 'utf8'));
assert.notEqual(previous.version, next.version, 'Upgrade verification needs distinct versions');
const archives = [previous, next].map(item => path.join(output, `${item.name}-${item.version}.tgz`));
const contents = run('tar', ['-tf', archives[1]], root).split(/\r?\n/);
for (const file of ['lib/index.js', 'lib/client.js', 'lib/build-info.json', 'LICENSE', 'INSTALL.md', 'ROADMAP.md', 'DESIGN-voice-interaction.md',
  'third-party/THINKING-ORBS-LICENSE.txt', 'third-party/SCHEMASTERY-LICENSE.txt', 'third-party/COSMOKIT-LICENSE.txt']) {
  assert(contents.includes(`package/${file}`), `Missing distribution file: ${file}`);
}
assert(!contents.some(file => /(?:^|\/)(?:node_modules|data|\.git|\.venv|release)(?:\/|$)/.test(file)));
await writeFile(path.join(install, 'package.json'), `${JSON.stringify({ private: true, type: 'module',
  dependencies: { '@deepseek-ai/cordis': '4.0.5', react: '18.3.1' } }, null, 2)}\n`, 'utf8');
await copyFile(new URL('./verify-installed.mjs', import.meta.url), path.join(install, 'verify.mjs'));
const stages = [];
for (const [index, label] of [[0, 'install-baseline'], [1, 'upgrade-candidate'], [0, 'rollback-baseline']]) {
  run(bun, ['add', '--ignore-scripts', `dsh-voicebox@file:${archives[index].replaceAll('\\', '/')}`], install);
  const result = JSON.parse(run('node', ['verify.mjs', index === 0 ? previous.version : next.version], install));
  const artifactHashes = await verifyInstalledArtifact(archives[index], path.join(install, 'node_modules/dsh-voicebox'));
  stages.push({ stage: label, ...result, artifactHashes });
}
const digests = {};
for (const archive of archives) digests[path.basename(archive)] = createHash('sha256').update(await readFile(archive)).digest('hex');
const candidateHash = digests[path.basename(archives[1])];
const candidate = { file: `${next.name}-${next.version}-${candidateHash.slice(0, 12)}.tgz`, sha256: candidateHash };
await copyFile(archives[1], path.join(output, candidate.file));
await writeFile(path.join(output, 'verification.json'), `${JSON.stringify({ baseline, isolated, stages, candidate, sha256: digests,
  scope: 'Fresh dependency root; packaged host/client imports and version changes. No native Desktop installer, inference or hardware audio.' }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, isolated, stages, candidate, sha256: digests }, null, 2));
