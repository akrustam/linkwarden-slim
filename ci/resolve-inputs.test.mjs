import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = new URL('.', import.meta.url).pathname;
const script = join(root, 'resolve-inputs.mjs');
const hex = (character, length) => character.repeat(length);
const indexDigest = `sha256:${hex('a', 64)}`;
const amd64Digest = `sha256:${hex('b', 64)}`;
const arm64Digest = `sha256:${hex('c', 64)}`;

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'resolve-inputs-'));
  const packagingExport = join(directory, 'packaging');
  await mkdir(join(packagingExport, 'ci'), { recursive: true });
  await Promise.all([
    writeFile(join(packagingExport, 'Dockerfile'), 'FROM scratch\n'),
    writeFile(join(packagingExport, 'docker-entrypoint.sh'), '#!/bin/sh\n'),
    writeFile(join(packagingExport, 'patch-next-standalone.js'), 'process.exit(0);\n'),
    writeFile(join(packagingExport, 'ci', 'run-source-tests.sh'), '#!/bin/sh\n'),
  ]);
  const regctl = join(directory, 'regctl');
  const index = JSON.stringify({
    schemaVersion: 2,
    manifests: [
      { digest: amd64Digest, platform: { os: 'linux', architecture: 'amd64' } },
      { digest: arm64Digest, platform: { os: 'linux', architecture: 'arm64' } },
    ],
  });
  await writeFile(regctl, `#!/bin/sh
set -eu
if [ "$1" = manifest ] && [ "$2" = head ]; then
  printf 'sha256:${'a'.repeat(64)}\\n'
elif [ "$1" = manifest ] && [ "$2" = get ]; then
  printf '%s\\n' '${index}'
else
  exit 64
fi
`);
  await run('chmod', ['+x', regctl]);
  return { directory, packagingExport, regctl };
}

function args({ regctl, packagingExport, out }) {
  return [
    script,
    '--regctl', regctl,
    '--packaging-url', 'https://github.com/example/linkwarden-docker.git',
    '--packaging-sha', hex('d', 40),
    '--packaging-export', packagingExport,
    '--upstream-tag', 'v2.10.1',
    '--upstream-url', 'https://github.com/example/linkwarden.git',
    '--upstream-sha', hex('e', 40),
    '--postgres', 'docker.io/library/postgres:16-bookworm',
    '--meili', 'docker.io/getmeili/meilisearch:v1.12.3',
    '--node', 'node:lts-bookworm-slim',
    '--rust', 'rust:1.83-bookworm',
    '--monolith-version', '2.10.1',
    '--out', out,
  ];
}

test('resolves tag references to immutable indexes and amd64 service children', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.directory, { recursive: true, force: true }));
  const out = join(current.directory, 'inputs.json');

  const result = await run('node', args({ ...current, out }));

  assert.equal(result.code, 0, result.stderr);
  const input = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(input.recipe.schemaVersion, 'v1');
  assert.equal(input.recipe.nodeIndexDigest, indexDigest);
  assert.equal(input.recipe.rustIndexDigest, indexDigest);
  assert.equal(input.nodeImage, `docker.io/library/node@${indexDigest}`);
  assert.equal(input.rustImage, `docker.io/library/rust@${indexDigest}`);
  assert.equal(input.postgresImage, `docker.io/library/postgres@${amd64Digest}`);
  assert.equal(input.meiliImage, `docker.io/getmeili/meilisearch@${amd64Digest}`);
  assert.equal(input.validationFingerprint, 'sha256:81e276a92b70fc28855d8999b6e512daae4dde49e07c8ed65ea2b8c164e9a903');
  assert.equal(Object.hasOwn(input, 'packagingExport'), false);
  assert.equal(input.upstreamUrl, 'https://github.com/example/linkwarden.git');
  assert.equal(input.upstreamSha, hex('e', 40));
  assert.match(input.recipe.packagingInputsDigest, /^sha256:[a-f0-9]{64}$/);
});

test('requires the immutable upstream URL used to seal the publish context', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.directory, { recursive: true, force: true }));

  const command = args({ ...current, out: join(current.directory, 'inputs.json') });
  const upstreamUrl = command.indexOf('--upstream-url');
  const result = await run('node', [...command.slice(0, upstreamUrl), ...command.slice(upstreamUrl + 2)]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--upstream-url/);
});

test('rejects registry indexes that do not contain linux/amd64', async (t) => {
  const current = await fixture();
  t.after(() => rm(current.directory, { recursive: true, force: true }));
  const regctl = join(current.directory, 'missing-platform-regctl');
  await writeFile(regctl, `#!/bin/sh
if [ "$2" = head ]; then printf 'sha256:${'a'.repeat(64)}\\n'; exit 0; fi
printf '%s\\n' '{"schemaVersion":2,"manifests":[{"digest":"${arm64Digest}","platform":{"os":"linux","architecture":"arm64"}}]}'
`);
  await run('chmod', ['+x', regctl]);

  const result = await run('node', args({ ...current, regctl, out: join(current.directory, 'inputs.json') }));

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /linux\/amd64/);
});
