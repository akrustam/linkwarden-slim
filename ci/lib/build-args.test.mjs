import assert from 'node:assert/strict';
import test from 'node:test';

import { buildArgPairs, buildArgsForRecipe } from './build-args.mjs';
import { createRecipe } from './recipe.mjs';

const hex = (character, length) => character.repeat(length);

function recipe() {
  return createRecipe({
    schemaVersion: 'v1',
    upstreamTag: 'v2.15.1',
    upstreamCommit: hex('a', 40),
    packagingSourceSha: hex('b', 40),
    nodeIndexDigest: `sha256:${hex('c', 64)}`,
    rustIndexDigest: `sha256:${hex('d', 64)}`,
    packagingInputsDigest: `sha256:${hex('e', 64)}`,
    monolithVersion: '2.8.3',
  });
}

test('returns all Docker build arguments in their stable order', () => {
  const value = recipe();
  const nodeImage = `docker.io/library/node@sha256:${hex('1', 64)}`;
  const rustImage = `docker.io/library/rust@sha256:${hex('2', 64)}`;
  const args = buildArgsForRecipe({ recipe: value, nodeImage, rustImage });

  assert.deepEqual(args, [
    `NODE_IMAGE=${nodeImage}`,
    `RUST_IMAGE=${rustImage}`,
    'MONOLITH_VERSION=2.8.3',
    'UPSTREAM_TAG=v2.15.1',
    `UPSTREAM_SHA=${hex('a', 40)}`,
    `RECIPE_ID=${value.recipeId}`,
    `PACKAGING_INPUTS_DIGEST=sha256:${hex('e', 64)}`,
    `PACKAGING_SOURCE_SHA=${hex('b', 40)}`,
    `NODE_BASE_DIGEST=sha256:${hex('c', 64)}`,
    `RUST_BASE_DIGEST=sha256:${hex('d', 64)}`,
  ]);
  assert.deepEqual(buildArgPairs(args), args.flatMap((entry) => ['--build-arg', entry]));
});

test('emits canonical base digests with one sha256 prefix', () => {
  const value = recipe();
  const args = buildArgsForRecipe({
    recipe: value,
    nodeImage: `docker.io/library/node@sha256:${hex('1', 64)}`,
    rustImage: `docker.io/library/rust@sha256:${hex('2', 64)}`,
  });
  const baseDigests = args.filter((entry) => /^(NODE|RUST)_BASE_DIGEST=/.test(entry));

  assert.deepEqual(baseDigests, [
    `NODE_BASE_DIGEST=${value.nodeIndexDigest}`,
    `RUST_BASE_DIGEST=${value.rustIndexDigest}`,
  ]);
  for (const entry of baseDigests) {
    assert.equal((entry.match(/sha256:/g) ?? []).length, 1);
  }
});

test('rejects incomplete recipes and non-digest-qualified base images', () => {
  const value = recipe();

  assert.throws(
    () => buildArgsForRecipe({ recipe: { ...value, packagingInputsDigest: undefined }, nodeImage: 'node', rustImage: 'rust' }),
    /packagingInputsDigest/,
  );
  assert.throws(
    () => buildArgsForRecipe({ recipe: value, nodeImage: 'docker.io/library/node:22', rustImage: 'docker.io/library/rust@sha256:' + hex('2', 64) }),
    /nodeImage/,
  );
  assert.throws(
    () => buildArgsForRecipe({
      recipe: value,
      nodeImage: `docker.io/library/node:22@sha256:${hex('1', 64)}`,
      rustImage: `docker.io/library/rust@sha256:${hex('2', 64)}`,
    }),
    /nodeImage/,
  );
  assert.throws(() => buildArgPairs('not-an-array'), /array/);
});
