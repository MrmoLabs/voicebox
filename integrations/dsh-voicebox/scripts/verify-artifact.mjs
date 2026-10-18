import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Check installed bytes, not just the version cached by the package manager. */
export async function verifyInstalledArtifact(archive, installed) {
  const hashes = {};
  for (const file of ['lib/index.js', 'lib/client.js']) {
    const result = spawnSync('tar', ['-xOf', archive, `package/${file}`], {
      maxBuffer: 8 * 1024 * 1024, timeout: 120_000, windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error(`Cannot inspect ${file} in candidate archive`, { cause: result.error });
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const expected = hash(result.stdout);
    assert.equal(hash(await readFile(path.join(installed, file))), expected, `Installed ${file} differs from archive; check stale local-package cache`);
    hashes[file] = expected;
  }
  return hashes;
}
