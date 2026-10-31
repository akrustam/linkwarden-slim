import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseSourceReference } from './lib/reference.mjs';
import { readBuildLock } from './lib/build-lock.mjs';

test('release policy has one validated lock and Dockerfile cannot supply floating defaults', async () => {
  const root = new URL('../', import.meta.url);
  await readBuildLock(root.pathname);
  const workflow = await readFile(new URL('.github/workflows/build-publish.yml', root), 'utf8');
  const dockerfile = await readFile(new URL('Dockerfile', root), 'utf8');
  assert.doesNotMatch(workflow, /ubuntu-latest|NODE_REF:|RUST_REF:|--latest-upstream/);
  assert.match(workflow, /- build-lock\.json/);
  for (const name of ['BUILDKIT_IMAGE', 'QEMU_IMAGE']) {
    parseSourceReference(workflow.match(new RegExp(`^  ${name}: (.+)$`, 'm'))?.[1]);
  }
  assert.match(workflow, /^  BUILDX_VERSION: v[0-9]+\.[0-9]+\.[0-9]+$/m);
  for (const name of ['NODE_IMAGE', 'RUST_IMAGE', 'MONOLITH_VERSION']) {
    assert.match(dockerfile, new RegExp(`^ARG ${name}$`, 'm'));
    assert.doesNotMatch(dockerfile, new RegExp(`^ARG ${name}=`, 'm'));
  }
});
