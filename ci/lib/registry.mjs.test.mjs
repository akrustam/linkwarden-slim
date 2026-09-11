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
  compareArtifacts,
  validateArtifact,
} from './artifact.mjs';
import { createRecipe } from './recipe.mjs';
import {
  MAX_OUTPUT_BYTES,
  copyReference,
  inspectReference,
  inspectSourceReference,
  resolveImageReference,
} from './registry.mjs';

const hex = (character, length) => character.repeat(length);
const parentDigest = `sha256:${hex('b', 64)}`;
const amd64Digest = `sha256:${hex('c', 64)}`;
const arm64Digest = `sha256:${hex('d', 64)}`;
const repository = 'registry.example/linkwarden-slim';
function recipeInput(overrides = {}) {
  return {
    schemaVersion: 'v1',
    upstreamTag: 'v2.15.1',
    upstreamCommit: hex('f', 40),
    packagingSourceSha: hex('1', 40),
    nodeIndexDigest: `sha256:${hex('2', 64)}`,
    rustIndexDigest: `sha256:${hex('3', 64)}`,
    packagingInputsDigest: `sha256:${hex('e', 64)}`,
    monolithVersion: '2.8.3',
    ...overrides,
  };
}

function labelsFor(recipe = createRecipe(recipeInput())) {
  return {
    [RECIPE_ID_LABEL]: recipe.recipeId,
    [VERSION_LABEL]: recipe.upstreamTag,
    [PACKAGING_INPUTS_DIGEST_LABEL]: recipe.packagingInputsDigest,
    [UPSTREAM_REVISION_LABEL]: recipe.upstreamCommit,
    [PACKAGING_SOURCE_REVISION_LABEL]: recipe.packagingSourceSha,
    [NODE_BASE_LABEL]: recipe.nodeIndexDigest,
    [RUST_BASE_LABEL]: recipe.rustIndexDigest,
    [MONOLITH_VERSION_LABEL]: recipe.monolithVersion,
  };
}

const labels = labelsFor();

function index(manifests = targetDescriptors()) {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests,
  };
}

function targetDescriptors() {
  return [
    {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: amd64Digest,
      platform: { os: 'linux', architecture: 'amd64' },
    },
    {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: arm64Digest,
      platform: { os: 'linux', architecture: 'arm64' },
    },
  ];
}

function config(architecture, configLabels = labels) {
  return { os: 'linux', architecture, config: { Labels: configLabels } };
}

function ok(stdout, overrides = {}) {
  return { exitCode: 0, signal: null, stdout, stderr: '', ...overrides };
}

test('inspects a parent index, then its exact target manifests, retaining the parent source reference', async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'manifest' && args[1] === 'head') {
      return ok(`Digest: ${parentDigest}\n`);
    }
    if (args[0] === 'manifest' && args[1] === 'get') {
      return ok(JSON.stringify(index()));
    }
    if (args.at(-1).endsWith(amd64Digest)) {
      return ok(JSON.stringify(config('amd64')));
    }
    return ok(JSON.stringify(config('arm64')));
  };

  const result = await inspectReference({
    regctlPath: 'fake-regctl',
    reference: `${repository}:v2.15.1`,
    env: { REGCTL_LOG: 'warn' },
    run,
  });

  assert.equal(result.kind, 'Valid');
  assert.equal(result.sourceRef, `${repository}@${parentDigest}`);
  assert.deepEqual(result.platformDigests, {
    'linux/amd64': amd64Digest,
    'linux/arm64': arm64Digest,
  });
  assert.deepEqual(calls.map(({ command, args, options }) => [command, args, options.env]), [
    ['fake-regctl', ['manifest', 'head', `${repository}:v2.15.1`, '--require-digest'], { REGCTL_LOG: 'warn' }],
    ['fake-regctl', ['manifest', 'get', `${repository}@${parentDigest}`, '--format', 'raw-body'], { REGCTL_LOG: 'warn' }],
    ['fake-regctl', ['image', 'inspect', `${repository}@${amd64Digest}`], { REGCTL_LOG: 'warn' }],
    ['fake-regctl', ['image', 'inspect', `${repository}@${arm64Digest}`], { REGCTL_LOG: 'warn' }],
  ]);
});

test('inspects an immutable source reference without resolving a mutable tag', async () => {
  const calls = [];
  const sourceRef = `${repository}@${parentDigest}`;
  const result = await inspectSourceReference({
    regctlPath: 'fake-regctl',
    sourceRef,
    run: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'manifest' && args[1] === 'get') return ok(JSON.stringify(index()));
      return ok(JSON.stringify(args.at(-1).endsWith(amd64Digest) ? config('amd64') : config('arm64')));
    },
  });

  assert.equal(result.kind, 'Valid');
  assert.equal(result.sourceRef, sourceRef);
  assert.equal(calls.some(([, args]) => args[0] === 'manifest' && args[1] === 'head'), false);
  assert.deepEqual(calls[0], ['fake-regctl', ['manifest', 'get', sourceRef, '--format', 'raw-body']]);
});

test('accepts the digest output form from manifest head', async () => {
  const result = await inspectReference({
    regctlPath: 'regctl',
    reference: `${repository}:v2.15.1`,
    run: async (_command, args) => {
      if (args[0] === 'manifest' && args[1] === 'head') return ok(`${parentDigest}\n`);
      if (args[0] === 'manifest' && args[1] === 'get') return ok(JSON.stringify(index()));
      return ok(JSON.stringify(args.at(-1).endsWith(amd64Digest) ? config('amd64') : config('arm64')));
    },
  });

  assert.equal(result.kind, 'Valid');
  assert.equal(result.sourceRef, `${repository}@${parentDigest}`);
});

test('classifies only manifest unknown responses as missing by default', async () => {
  const missing = await inspectReference({
    regctlPath: 'regctl',
    reference: `${repository}:missing`,
    run: async () => ok('', { exitCode: 1, stderr: 'MANIFEST_UNKNOWN: manifest unknown' }),
  });
  const unauthorized = await inspectReference({
    regctlPath: 'regctl',
    reference: `${repository}:private`,
    run: async () => ok('', { exitCode: 1, stderr: 'unauthorized: authentication required (401)' }),
  });
  const generic404 = await inspectReference({
    regctlPath: 'regctl',
    reference: `${repository}:unknown`,
    run: async () => ok('', { exitCode: 1, statusCode: 404, stderr: 'HTTP 404' }),
  });

  assert.equal(missing.kind, 'Missing');
  assert.equal(unauthorized.kind, 'Error');
  assert.equal(generic404.kind, 'Error');
});

test('allows only the known regctl not-found response when explicitly requested', async () => {
  const knownNotFound = 'failed to request manifest head registry.example/linkwarden-slim:missing: request failed: not found [http 404]: ';
  const defaultResult = await inspectReference({
    regctlPath: 'regctl',
    reference: `${repository}:missing`,
    run: async () => ok('', { exitCode: 1, stderr: knownNotFound }),
  });
  const allowedResult = await inspectReference({
    regctlPath: 'regctl',
    reference: `${repository}:missing`,
    allowNotFound: true,
    run: async () => ok('', { exitCode: 1, stderr: knownNotFound }),
  });
  const wrong404 = await inspectReference({
    regctlPath: 'regctl',
    reference: `${repository}:missing`,
    allowNotFound: true,
    run: async () => ok('', { exitCode: 1, stderr: 'request failed: unavailable [http 404]:' }),
  });

  assert.equal(defaultResult.kind, 'Error');
  assert.equal(allowedResult.kind, 'Missing');
  assert.equal(wrong404.kind, 'Error');
});

test('reports malformed manifest-head output as an error instead of throwing', async () => {
  const result = await inspectReference({
    regctlPath: 'regctl',
    reference: `${repository}:broken`,
    run: async () => ok(undefined),
  });

  assert.deepEqual(result, {
    kind: 'Error',
    message: `Malformed manifest head response for ${repository}:broken`,
  });
});

test('fails closed when an injected runner omits, nulls, or signals a process result', async () => {
  const invalidResults = [
    ok(`Digest: ${parentDigest}\n`, { exitCode: undefined }),
    ok(`Digest: ${parentDigest}\n`, { exitCode: null }),
    ok('MANIFEST_UNKNOWN: manifest unknown', { signal: 'SIGTERM' }),
  ];

  for (const result of invalidResults) {
    const outcome = await inspectReference({
      regctlPath: 'regctl',
      reference: `${repository}:interrupted`,
      run: async () => result,
    });
    assert.equal(outcome.kind, 'Error');
  }
});

test('allows attestation descriptors only alongside exactly two target app manifests', () => {
  const attestation = {
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: `sha256:${hex('f', 64)}`,
    platform: { os: 'unknown', architecture: 'unknown' },
    annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
  };
  const valid = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: index([...targetDescriptors(), attestation]),
    configs: { 'linux/amd64': config('amd64'), 'linux/arm64': config('arm64') },
  });
  const conflict = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: index([...targetDescriptors(), {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${hex('f', 64)}`,
      platform: { os: 'linux', architecture: 's390x' },
    }]),
    configs: { 'linux/amd64': config('amd64'), 'linux/arm64': config('arm64') },
  });

  assert.equal(valid.kind, 'Valid');
  assert.equal(conflict.kind, 'Conflict');
});

test('rejects structurally malformed attestation descriptors', () => {
  const malformed = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: index([...targetDescriptors(), {
      digest: `sha256:${hex('f', 64)}`,
      annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
    }]),
    configs: { 'linux/amd64': config('amd64'), 'linux/arm64': config('arm64') },
  });

  assert.equal(malformed.kind, 'Conflict');
});

test('rejects platform descriptors that are not image manifests', () => {
  const invalidMediaType = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: index(targetDescriptors().map((descriptor) => ({
      ...descriptor,
      mediaType: 'application/vnd.oci.image.index.v1+json',
    }))),
    configs: { 'linux/amd64': config('amd64'), 'linux/arm64': config('arm64') },
  });

  assert.equal(invalidMediaType.kind, 'Conflict');
});

test('rejects indexes with a missing or unsupported envelope', () => {
  const missingSchema = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: { ...index(), schemaVersion: undefined },
    configs: { 'linux/amd64': config('amd64'), 'linux/arm64': config('arm64') },
  });
  const wrongMediaType = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: { ...index(), mediaType: 'application/vnd.oci.image.manifest.v1+json' },
    configs: { 'linux/amd64': config('amd64'), 'linux/arm64': config('arm64') },
  });

  assert.equal(missingSchema.kind, 'Conflict');
  assert.equal(wrongMediaType.kind, 'Conflict');
});

test('requires every approved provenance label in both target configs', () => {
  const missingNodeBase = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: index(),
    configs: {
      'linux/amd64': config('amd64'),
      'linux/arm64': config('arm64', { ...labels, [NODE_BASE_LABEL]: undefined }),
    },
  });

  assert.equal(missingNodeBase.kind, 'Conflict');
});

test('ignores incidental inherited labels when comparing target provenance', () => {
  const valid = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: index(),
    configs: {
      'linux/amd64': config('amd64', { ...labels, 'org.opencontainers.image.created': '2026-09-10T00:00:00Z' }),
      'linux/arm64': config('arm64', { ...labels, 'org.opencontainers.image.created': '2026-09-11T00:00:00Z' }),
    },
  });

  assert.equal(valid.kind, 'Valid');
  assert.deepEqual(valid.validatedLabels, labels);
});

test('rejects a recipe id label that does not match its provenance labels', () => {
  const mismatchedRecipeId = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: index(),
    configs: {
      'linux/amd64': config('amd64', { ...labels, [RECIPE_ID_LABEL]: hex('a', 64) }),
      'linux/arm64': config('arm64', { ...labels, [RECIPE_ID_LABEL]: hex('a', 64) }),
    },
  });

  assert.equal(mismatchedRecipeId.kind, 'Conflict');
});

test('rejects an invalid packaging inputs digest label', () => {
  const invalidDigest = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: index(),
    configs: {
      'linux/amd64': config('amd64'),
      'linux/arm64': config('arm64', { ...labels, [PACKAGING_INPUTS_DIGEST_LABEL]: hex('e', 64) }),
    },
  });

  assert.equal(invalidDigest.kind, 'Conflict');
});

test('detects divergent labels and compares valid artifacts without their source index digest', () => {
  const first = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: index(),
    configs: { 'linux/amd64': config('amd64'), 'linux/arm64': config('arm64') },
  });
  const second = { ...first, sourceRef: `${repository}@sha256:${hex('f', 64)}` };
  const mismatch = validateArtifact({
    sourceRef: `${repository}@${parentDigest}`,
    index: index(),
    configs: {
      'linux/amd64': config('amd64'),
      'linux/arm64': config('arm64', { ...labels, [VERSION_LABEL]: 'v2.15.2' }),
    },
  });

  assert.equal(first.kind, 'Valid');
  assert.equal(mismatch.kind, 'Conflict');
  assert.equal(compareArtifacts(first, second), true);
});

test('copies only immutable digest-qualified source references', async () => {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    return ok('');
  };

  await copyReference({
    regctlPath: 'regctl',
    source: `${repository}@${parentDigest}`,
    destination: `${repository}:latest`,
    run,
  });
  assert.deepEqual(calls, [['regctl', ['image', 'copy', `${repository}@${parentDigest}`, `${repository}:latest`]]]);
  await assert.rejects(
    copyReference({ regctlPath: 'regctl', source: `${repository}:v2.15.1`, destination: `${repository}:latest`, run }),
    /valid registry references/,
  );
  await assert.rejects(
    copyReference({
      regctlPath: 'regctl',
      source: `${repository}@${parentDigest}`,
      destination: `${repository}:latest`,
      run: async () => ok('', { exitCode: 1, stderr: 'copy failed' }),
    }),
    /copy failed/,
  );
});

test('caps injected registry command output before parsing it', async () => {
  for (const result of [
    ok('x'.repeat(MAX_OUTPUT_BYTES + 1)),
    ok('', { stderr: 'x'.repeat(MAX_OUTPUT_BYTES + 1) }),
  ]) {
    const inspected = await inspectReference({
      regctlPath: 'regctl',
      reference: `${repository}:too-large`,
      run: async () => result,
    });
    assert.equal(inspected.kind, 'Error');
    assert.match(inspected.message, /output limit/);
  }
});

test('normalizes Docker Hub tag sources before resolving generic platform references', async () => {
  const references = [
    ['node:lts-bookworm-slim', 'docker.io/library/node:lts-bookworm-slim'],
    ['postgres:16-alpine', 'docker.io/library/postgres:16-alpine'],
    ['getmeili/meilisearch:v1.13.3', 'docker.io/getmeili/meilisearch:v1.13.3'],
  ];

  for (const [reference, normalized] of references) {
    const calls = [];
    const resolved = await resolveImageReference({
      regctlPath: 'regctl',
      reference,
      platforms: ['linux/amd64'],
      run: async (_command, args) => {
        calls.push(args);
        if (args[1] === 'head') return ok(`${parentDigest}\n`);
        return ok(JSON.stringify(index()));
      },
    });

    assert.deepEqual(resolved, {
      sourceRef: `${normalized.split(':')[0]}@${parentDigest}`,
      indexDigest: parentDigest,
      platformRefs: { 'linux/amd64': `${normalized.split(':')[0]}@${amd64Digest}` },
    });
    assert.deepEqual(calls, [
      ['manifest', 'head', normalized, '--require-digest'],
      ['manifest', 'get', `${normalized.split(':')[0]}@${parentDigest}`, '--format', 'raw-body'],
    ]);
  }
});

test('rejects a source index missing a requested platform', async () => {
  await assert.rejects(
    resolveImageReference({
      regctlPath: 'regctl',
      reference: 'node:lts-bookworm-slim',
      platforms: ['linux/amd64', 'linux/arm64'],
      run: async (_command, args) => (args[1] === 'head'
        ? ok(`${parentDigest}\n`)
        : ok(JSON.stringify(index([targetDescriptors()[0]])))),
    }),
    /does not contain linux\/arm64/,
  );
});
