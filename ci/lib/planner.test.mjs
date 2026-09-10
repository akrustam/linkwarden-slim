import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MONOLITH_VERSION_LABEL,
  NODE_BASE_LABEL,
  PACKAGING_INPUTS_DIGEST_LABEL,
  PACKAGING_SOURCE_REVISION_LABEL,
  RECIPE_ID_LABEL,
  RUST_BASE_LABEL,
  UPSTREAM_REVISION_LABEL,
  VERSION_LABEL,
  validateArtifact,
} from './artifact.mjs';
import {
  TARGET_PLATFORMS,
  ensureArtifact,
  findMatchingSource,
  planRun,
} from './planner.mjs';

const hex = (character, length) => character.repeat(length);
const repository = 'registry.example/linkwarden-slim';
const upstreamTag = 'v2.15.1';
const upstreamCommit = hex('a', 40);

function artifact({ recipeId, sourceDigest = hex('b', 64) }) {
  const labels = {
    [RECIPE_ID_LABEL]: recipeId,
    [VERSION_LABEL]: upstreamTag,
    [PACKAGING_INPUTS_DIGEST_LABEL]: `sha256:${hex('e', 64)}`,
    [UPSTREAM_REVISION_LABEL]: upstreamCommit,
    [PACKAGING_SOURCE_REVISION_LABEL]: hex('b', 40),
    [NODE_BASE_LABEL]: `sha256:${hex('c', 64)}`,
    [RUST_BASE_LABEL]: `sha256:${hex('d', 64)}`,
    [MONOLITH_VERSION_LABEL]: '2.8.3',
  };
  return validateArtifact({
    sourceRef: `${repository}@sha256:${sourceDigest}`,
    index: {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: `sha256:${hex('c', 64)}`,
          platform: { os: 'linux', architecture: 'amd64' },
        },
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: `sha256:${hex('d', 64)}`,
          platform: { os: 'linux', architecture: 'arm64' },
        },
      ],
    },
    configs: {
      'linux/amd64': { os: 'linux', architecture: 'amd64', config: { Labels: labels } },
      'linux/arm64': { os: 'linux', architecture: 'arm64', config: { Labels: labels } },
    },
  });
}

function desired(recipeId = hex('e', 64)) {
  return { recipeId, upstreamTag, upstreamCommit };
}

test('reuses only a source with the full requested recipe identity', () => {
  const oldBase = artifact({ recipeId: hex('f', 64) });
  const current = artifact({ recipeId: hex('e', 64), sourceDigest: hex('1', 64) });

  assert.equal(findMatchingSource([oldBase, current], desired()), current);
  assert.deepEqual(
    ensureArtifact({ sources: [oldBase], desired: desired(), platforms: TARGET_PLATFORMS }),
    { kind: 'Build', recipe: desired(), platforms: TARGET_PLATFORMS },
  );
});

test('keeps an old immutable version tag but advances latest for a new base recipe', () => {
  const oldRecipe = artifact({ recipeId: hex('f', 64) });
  const plan = planRun({
    desired: desired(),
    platforms: TARGET_PLATFORMS,
    sourceArtifacts: [oldRecipe],
    versionArtifact: oldRecipe,
    latestArtifact: oldRecipe,
    versionTag: `${repository}:${upstreamTag}`,
    latestTag: `${repository}:latest`,
  });

  assert.equal(plan.artifact.kind, 'Build');
  assert.deepEqual(plan.version, { kind: 'Keep', destination: `${repository}:${upstreamTag}` });
  assert.deepEqual(plan.latest, { kind: 'SetTag', destination: `${repository}:latest` });
});

test('fails closed on incomplete platform requests and inspected errors or conflicts', () => {
  const current = artifact({ recipeId: hex('e', 64) });
  assert.throws(
    () => planRun({
      desired: desired(),
      platforms: ['linux/amd64'],
      sourceArtifacts: [current],
      versionArtifact: { kind: 'Missing' },
      latestArtifact: { kind: 'Missing' },
      versionTag: `${repository}:${upstreamTag}`,
      latestTag: `${repository}:latest`,
    }),
    /linux\/arm64/,
  );
  assert.throws(
    () => findMatchingSource([{ kind: 'Error', message: 'registry timeout' }], desired()),
    /registry timeout/,
  );
  assert.throws(
    () => findMatchingSource([{ kind: 'Conflict', message: 'platform mismatch' }], desired()),
    /platform mismatch/,
  );
});
