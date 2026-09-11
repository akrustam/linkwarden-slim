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
import { buildArgsForRecipe } from './build-args.mjs';
import { createRecipe } from './recipe.mjs';
import {
  TARGET_PLATFORMS,
  ensureArtifact,
  ensureTag,
  findMatchingSource,
  planRun,
} from './planner.mjs';

const hex = (character, length) => character.repeat(length);
const repository = 'registry.example/linkwarden-slim';
const upstreamTag = 'v2.15.1';
const upstreamCommit = hex('a', 40);

function recipeInput(overrides = {}) {
  return {
    schemaVersion: 'v1',
    upstreamTag,
    upstreamCommit,
    packagingSourceSha: hex('b', 40),
    nodeIndexDigest: `sha256:${hex('c', 64)}`,
    rustIndexDigest: `sha256:${hex('d', 64)}`,
    packagingInputsDigest: `sha256:${hex('e', 64)}`,
    monolithVersion: '2.8.3',
    ...overrides,
  };
}

function artifact({ recipe = createRecipe(recipeInput()), sourceDigest = hex('b', 64) }) {
  const labels = {
    [RECIPE_ID_LABEL]: recipe.recipeId,
    [VERSION_LABEL]: recipe.upstreamTag,
    [PACKAGING_INPUTS_DIGEST_LABEL]: recipe.packagingInputsDigest,
    [UPSTREAM_REVISION_LABEL]: recipe.upstreamCommit,
    [PACKAGING_SOURCE_REVISION_LABEL]: recipe.packagingSourceSha,
    [NODE_BASE_LABEL]: recipe.nodeIndexDigest,
    [RUST_BASE_LABEL]: recipe.rustIndexDigest,
    [MONOLITH_VERSION_LABEL]: recipe.monolithVersion,
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

test('reuses only a source with the full requested recipe identity', () => {
  const oldBase = artifact({ recipe: createRecipe(recipeInput({ nodeIndexDigest: `sha256:${hex('f', 64)}` })) });
  const current = artifact({ sourceDigest: hex('1', 64) });

  assert.equal(findMatchingSource([oldBase, current], recipeInput()), current);
  assert.deepEqual(
    ensureArtifact({ sources: [oldBase], recipe: recipeInput() }),
    { kind: 'Build', recipe: createRecipe(recipeInput()), platforms: TARGET_PLATFORMS },
  );
});

test('keeps an old immutable version tag but advances latest for a new base recipe', () => {
  const oldRecipe = artifact({ recipe: createRecipe(recipeInput({ nodeIndexDigest: `sha256:${hex('f', 64)}` })) });
  const plan = planRun({
    recipe: recipeInput(),
    sourceArtifacts: [oldRecipe],
    versionArtifact: oldRecipe,
    latestArtifact: oldRecipe,
    versionTag: `${repository}:${upstreamTag}`,
    latestTag: `${repository}:latest`,
  });

  assert.equal(plan.artifact.kind, 'Build');
  assert.deepEqual(plan.version, { kind: 'Keep', destination: `${repository}:${upstreamTag}` });
  assert.deepEqual(plan.latest, { kind: 'SetTag', destination: `${repository}:latest`, source: { kind: 'BuildOutput' } });
});

test('fails closed on absent artifacts and caller-supplied recipe ids', () => {
  const current = artifact({});
  assert.throws(
    () => planRun({
      recipe: recipeInput(),
      sourceArtifacts: [current],
      versionArtifact: undefined,
      latestArtifact: { kind: 'Missing' },
      versionTag: `${repository}:${upstreamTag}`,
      latestTag: `${repository}:latest`,
    }),
    /Unsafe artifact state/,
  );
  assert.throws(
    () => findMatchingSource([{ kind: 'Error', message: 'registry timeout' }], recipeInput()),
    /registry timeout/,
  );
  assert.throws(
    () => findMatchingSource([{ kind: 'Conflict', message: 'platform mismatch' }], recipeInput()),
    /platform mismatch/,
  );
  assert.throws(
    () => findMatchingSource([current], { ...recipeInput(), recipeId: current.recipeId }),
    /recipeId/,
  );
});

test('build plans provide a complete recipe to build args and source-bearing tag actions', () => {
  const plan = planRun({
    recipe: recipeInput(),
    sourceArtifacts: [],
    versionArtifact: { kind: 'Missing' },
    latestArtifact: { kind: 'Missing' },
    versionTag: `${repository}:${upstreamTag}`,
    latestTag: `${repository}:latest`,
  });
  const buildArgs = buildArgsForRecipe({
    recipe: plan.artifact.recipe,
    nodeImage: `docker.io/library/node@sha256:${hex('1', 64)}`,
    rustImage: `docker.io/library/rust@sha256:${hex('2', 64)}`,
  });

  assert.equal(plan.artifact.kind, 'Build');
  assert.equal(buildArgs.includes(`RECIPE_ID=${plan.artifact.recipe.recipeId}`), true);
  assert.deepEqual(plan.version.source, { kind: 'BuildOutput' });
  assert.deepEqual(plan.latest.source, { kind: 'BuildOutput' });
});

test('refuses tag actions without a valid artifact or planned build output source', () => {
  const different = artifact({ recipe: createRecipe(recipeInput({ nodeIndexDigest: `sha256:${hex('f', 64)}` })) });
  const current = artifact({});

  assert.throws(
    () => ensureTag({
      existing: different,
      recipe: recipeInput(),
      source: { kind: 'NotAnArtifact' },
      destination: `${repository}:latest`,
    }),
    /valid artifact or BuildOutput/,
  );
  assert.throws(
    () => ensureTag({
      existing: { kind: 'Missing' },
      recipe: recipeInput(),
      source: { kind: 'Valid', sourceRef: `${repository}:mutable` },
      destination: `${repository}:latest`,
    }),
    /valid artifact or BuildOutput/,
  );
  assert.throws(
    () => ensureTag({
      existing: { kind: 'Missing' },
      recipe: recipeInput(),
      source: { ...current, sourceRef: `${repository}:mutable` },
      destination: `${repository}:latest`,
    }),
    /valid artifact or BuildOutput/,
  );
  assert.throws(
    () => ensureTag({
      existing: { kind: 'Missing' },
      recipe: recipeInput(),
      source: { kind: 'BuildOutput' },
      destination: 'not a registry reference',
    }),
    /Tag destination/,
  );
  assert.throws(
    () => findMatchingSource([{ kind: 'Unknown' }], recipeInput()),
    /Unsafe artifact state/,
  );
});
