import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDockerCommand,
  buildxStagingCommand,
  publishInput,
  validateInput,
} from './publish.mjs';
import { createRecipe } from './lib/recipe.mjs';

const hex = (character, length) => character.repeat(length);
const recipe = {
  schemaVersion: 'v1',
  upstreamTag: 'v2.10.1',
  upstreamCommit: hex('a', 40),
  packagingSourceSha: hex('b', 40),
  nodeIndexDigest: `sha256:${hex('c', 64)}`,
  rustIndexDigest: `sha256:${hex('d', 64)}`,
  packagingInputsDigest: `sha256:${hex('e', 64)}`,
  monolithVersion: '2.10.1',
};
const input = {
  recipe: createRecipe(recipe),
  nodeImage: `docker.io/library/node@${recipe.nodeIndexDigest}`,
  rustImage: `docker.io/library/rust@${recipe.rustIndexDigest}`,
  packagingExport: '/tmp/packaging',
};

function validArtifact(sourceRef) {
  const resolvedRecipe = createRecipe(recipe);
  const labels = {
    'io.linkwarden-slim.recipe-id': resolvedRecipe.recipeId,
    'org.opencontainers.image.version': recipe.upstreamTag,
    'org.opencontainers.image.revision': recipe.packagingInputsDigest,
    'io.linkwarden-slim.upstream-revision': recipe.upstreamCommit,
    'io.linkwarden-slim.packaging-source-revision': recipe.packagingSourceSha,
    'io.linkwarden-slim.node-base': recipe.nodeIndexDigest,
    'io.linkwarden-slim.rust-base': recipe.rustIndexDigest,
    'io.linkwarden-slim.monolith-version': recipe.monolithVersion,
  };
  return {
    kind: 'Valid',
    recipeId: labels['io.linkwarden-slim.recipe-id'],
    sourceRef,
    platformDigests: {
      'linux/amd64': `sha256:${hex('1', 64)}`,
      'linux/arm64': `sha256:${hex('2', 64)}`,
    },
    validatedLabels: labels,
  };
}

test('build commands use the complete recipe argument set', () => {
  const command = buildDockerCommand({ input, context: '/tmp/context', target: 'main-app', tag: 'local/app:main' });

  assert.deepEqual(command.slice(0, 5), ['docker', 'build', '--platform', 'linux/amd64', '--load']);
  assert.equal(command.includes('--target'), true);
  assert.equal(command.includes('main-app'), true);
  assert.equal(command.includes('--file'), true);
  assert.equal(command.includes('/tmp/packaging/Dockerfile'), true);
  assert.equal(command.includes(`NODE_IMAGE=${input.nodeImage}`), true);
  assert.equal(command.includes(`RUST_BASE_DIGEST=${recipe.rustIndexDigest}`), true);
  assert.equal(command.at(-1), '/tmp/context');
});

test('staging build is multi-platform and disables generated artifacts', () => {
  const command = buildxStagingCommand({ input, context: '/tmp/context', staging: 'ghcr.io/example/app:staging', metadataFile: '/tmp/metadata.json' });

  assert.deepEqual(command.slice(0, 6), ['docker', 'buildx', 'build', '--platform', 'linux/amd64,linux/arm64', '--push']);
  assert.equal(command.includes('--provenance=false'), true);
  assert.equal(command.includes('--sbom=false'), true);
  assert.equal(command.includes('--metadata-file'), true);
  assert.equal(command.includes('/tmp/metadata.json'), true);
  assert.equal(command.includes('--tag'), true);
  assert.equal(command.includes('ghcr.io/example/app:staging'), true);
});

test('validation builds source and runtime targets with recipe args before stack gates', async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { exitCode: 0, signal: null };
  };

  await validateInput(input, { run, workspace: '/tmp/publish-validation' });

  const dockerCalls = calls.filter((call) => call.command === 'docker');
  assert.equal(dockerCalls.length, 2);
  assert.equal(dockerCalls.every((call) => call.args.includes(`NODE_IMAGE=${input.nodeImage}`)), true);
  assert.equal(dockerCalls.every((call) => call.args.includes('--file')), true);
  const bashCalls = calls.filter((call) => call.command === 'bash');
  assert.deepEqual(bashCalls.map((call) => call.args[0]), [
    'ci/prepare-context.sh',
    'ci/materialize-image.sh',
    'ci/materialize-image.sh',
    'ci/test-stack.sh',
    'ci/test-stack.sh',
  ]);
  assert.deepEqual(bashCalls[1].args.slice(1), ['linux/amd64', input.postgresImage, 'linkwarden-ci-postgres:latest']);
  assert.deepEqual(bashCalls[2].args.slice(1), ['linux/amd64', input.meiliImage, 'linkwarden-ci-meili:latest']);
});

test('promotion tests staged children before copying through GHCR and Docker Hub candidates', async () => {
  const commands = [];
  const copies = [];
  const staged = validArtifact(`ghcr.io/example/app@sha256:${hex('3', 64)}`);
  const ghcrCandidate = validArtifact(`ghcr.io/example/app@sha256:${hex('4', 64)}`);
  const dockerCandidate = validArtifact(`docker.io/example/app@sha256:${hex('5', 64)}`);
  const registryRun = async (_command, args) => {
    const reference = args.at(-2) ?? args.at(-1);
    if (args[0] === 'manifest' && args[1] === 'head') {
      if (!reference.includes(':staging') && !reference.includes(':candidate')) {
        return { exitCode: 1, signal: null, stdout: '', stderr: 'MANIFEST_UNKNOWN: manifest unknown' };
      }
      const digest = reference.includes(':staging') ? hex('3', 64)
        : reference.includes(':candidate') && reference.startsWith('ghcr.io') ? hex('4', 64)
          : reference.includes(':candidate') ? hex('5', 64) : hex('f', 64);
      return { exitCode: 0, signal: null, stdout: `sha256:${digest}\n`, stderr: '' };
    }
    if (args[0] === 'manifest' && args[1] === 'get') {
      return { exitCode: 0, signal: null, stdout: JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [
          { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${hex('1', 64)}`, platform: { os: 'linux', architecture: 'amd64' } },
          { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${hex('2', 64)}`, platform: { os: 'linux', architecture: 'arm64' } },
        ],
      }), stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const architecture = args[2].endsWith(hex('1', 64)) ? 'amd64' : 'arm64';
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ os: 'linux', architecture, config: { Labels: staged.validatedLabels } }), stderr: '' };
    }
    copies.push(args);
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  };
  const run = async (command, args) => {
    commands.push([command, args]);
    return { exitCode: 0, signal: null };
  };

  await publishInput(input, {
    regctlPath: 'regctl',
    staging: 'ghcr.io/example/app:staging',
    ghcrCandidate: 'ghcr.io/example/app:candidate',
    ghcrVersion: 'ghcr.io/example/app:v2.10.1',
    ghcrLatest: 'ghcr.io/example/app:latest',
    dockerCandidate: 'docker.io/example/app:candidate',
    dockerVersion: 'docker.io/example/app:v2.10.1',
    dockerLatest: 'docker.io/example/app:latest',
    freshInput: input,
    run,
    registryRun,
    workspace: '/tmp/publish-promotion',
  });

  assert.equal(commands.some(([command, args]) => command === 'bash' && args[0] === 'ci/materialize-image.sh' && args[1] === 'linux/arm64'), true);
  assert.deepEqual(copies.slice(0, 2), [
    ['image', 'copy', staged.sourceRef, 'ghcr.io/example/app:candidate'],
    ['image', 'copy', ghcrCandidate.sourceRef, 'docker.io/example/app:candidate'],
  ]);
});

test('promotion preserves matching Docker Hub version and latest tags', async () => {
  const copies = [];
  const labels = validArtifact(`ghcr.io/example/app@sha256:${hex('3', 64)}`).validatedLabels;
  const registryRun = async (_command, args) => {
    if (args[0] === 'manifest' && args[1] === 'head') {
      return { exitCode: 0, signal: null, stdout: `sha256:${hex('3', 64)}\n`, stderr: '' };
    }
    if (args[0] === 'manifest' && args[1] === 'get') {
      return { exitCode: 0, signal: null, stdout: JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: [
          { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${hex('1', 64)}`, platform: { os: 'linux', architecture: 'amd64' } },
          { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${hex('2', 64)}`, platform: { os: 'linux', architecture: 'arm64' } },
        ],
      }), stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      return { exitCode: 0, signal: null, stdout: JSON.stringify({
        os: 'linux',
        architecture: args[2].endsWith(hex('1', 64)) ? 'amd64' : 'arm64',
        config: { Labels: labels },
      }), stderr: '' };
    }
    copies.push(args);
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  };

  await publishInput(input, {
    regctlPath: 'regctl',
    staging: 'ghcr.io/example/app:staging',
    ghcrCandidate: 'ghcr.io/example/app:candidate',
    ghcrVersion: 'ghcr.io/example/app:v2.10.1',
    ghcrLatest: 'ghcr.io/example/app:latest',
    dockerCandidate: 'docker.io/example/app:candidate',
    dockerVersion: 'docker.io/example/app:v2.10.1',
    dockerLatest: 'docker.io/example/app:latest',
    freshInput: input,
    registryRun,
  });

  assert.deepEqual(copies.map((args) => args.at(-1)), [
    'ghcr.io/example/app:candidate',
    'docker.io/example/app:candidate',
  ]);
});
