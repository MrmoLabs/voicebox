import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyInstalledArtifact } from '../scripts/verify-artifact.mjs';

test('artifact verification rejects stale entrypoints even with the same package version', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'voicebox-artifact-'));
  const packed = path.join(root, 'package'), installed = path.join(root, 'installed');
  const files = [];
  t.after(async () => {
    for (const file of files) await unlink(file);
    for (const dir of [path.join(packed, 'lib'), packed, path.join(installed, 'lib'), installed, root]) await rmdir(dir);
  });
  for (const dir of [packed, installed]) {
    await mkdir(path.join(dir, 'lib'), { recursive: true });
    for (const [name, content] of Object.entries({ 'package.json': '{"version":"0.2.0-beta.2"}', 'lib/index.js': 'export const host = 1;\n', 'lib/client.js': 'window.client = 1;\n' })) {
      const file = path.join(dir, name); await writeFile(file, content, 'utf8'); files.push(file);
    }
  }
  const archive = path.join(root, 'candidate.tgz');
  const tar = spawnSync('tar', ['-czf', archive, 'package'], { cwd: root, windowsHide: true });
  assert.equal(tar.status, 0); files.push(archive);
  assert.equal(Object.keys(await verifyInstalledArtifact(archive, installed)).length, 2);
  await writeFile(path.join(installed, 'lib/client.js'), 'window.client = 0;\n', 'utf8');
  await assert.rejects(verifyInstalledArtifact(archive, installed), /Installed lib\/client.js differs from archive/);
});
