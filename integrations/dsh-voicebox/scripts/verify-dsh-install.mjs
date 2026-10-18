// Optional Windows check against an existing official Desktop runtime.
// Uses its CLI in Node mode, with a fresh DSH_HOME. Does not launch/quit Desktop.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = process.env.VOICEBOX_DSH_DESKTOP;
if (process.platform !== 'win32' || !desktop) throw new Error('Set VOICEBOX_DSH_DESKTOP to an installed DSH Desktop directory on Windows');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, 'release/dsh-voicebox-candidate');
const home = path.join(root, `.tmp-dsh-package-${Date.now()}`);
await mkdir(home, { recursive: true });
const executable = path.join(desktop, 'DeepSeek Harness.exe');
const runtime = path.join(desktop, 'resources/app.asar/dsh');
const cli = path.join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const env = { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1', npm_config_store_dir: path.join(home, 'store') };
function run(args) {
  const result = spawnSync(executable, ['--expose-internals', ...args], { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`${args.join(' ')} failed\n${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
const launch = args => run([cli, ...args]);
const runtimeVersion = launch(['--version']);
// A shipped Web template exercises the official plugin installer without the
// Desktop carrier's first-launch requirement or touching a running user profile.
launch(['--profile', 'voicebox-preview', '--from-default-profile', 'web', '--dump-config']);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const stages = [];
for (const [stage, version] of [['install-baseline', '0.1.0'], ['upgrade-candidate', manifest.version], ['rollback-baseline', '0.1.0']]) {
  const archive = path.join(output, `dsh-voicebox-${version}.tgz`);
  launch(['plugin', '--profile', 'voicebox-preview', 'add', archive, '--ignore-scripts', '--store-dir', path.join(home, 'store')]);
  const profile = path.join(home, 'profiles/voicebox-preview');
  const plugin = path.join(profile, 'node_modules/dsh-voicebox');
  const installed = JSON.parse(await readFile(path.join(plugin, 'package.json'), 'utf8'));
  assert.equal(installed.version, version);
  const composed = launch(['--profile', 'voicebox-preview', '--dump-config']);
  assert.match(composed, /name: ['"]?dsh-voicebox/);
  const smoke = run([path.join(root, 'integrations/dsh-voicebox/tests/host-smoke.mjs'), runtime, path.join(plugin, 'lib/index.js')]);
  assert.match(smoke, /^PASS:/);
  stages.push({ stage, version, composed: true, hostSmoke: smoke });
}
const sourceDialogue = run([path.join(root, 'integrations/dsh-voicebox/tests/dialogue-host-smoke.mjs'), runtime]);
assert.match(sourceDialogue, /^PASS:/);
const evidence = { runtimeVersion, home, stages, sourceDialogue,
  scope: 'Official Desktop CLI + pnpm + profile composition + packaged plugin against installed Cordis/Connection/SessionStore. Source VoiceContext against installed AgentLoop with scripted models. Uses shipped Web profile; no native Desktop window, credentials, models or microphone.' };
await writeFile(path.join(output, 'dsh-install-verification.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(evidence, null, 2));
