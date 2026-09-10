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
import { copyReference, inspectReference } from './registry.mjs';

const hex = (character, length) => character.repeat(length);
const recipeId = hex('a', 64);
const parentDigest = `sha256:${hex('b', 64)}`;
const amd64Digest = `sha256:${hex('c', 64)}`;
const arm64Digest = `sha256:${hex('d', 64)}`;
const repository = 'registry.example/linkwarden-slim';
const labels = {
  [RECIPE_ID_LABEL]: recipeId,
  [VERSION_LABEL]: 'v2.15.1',
  [PACKAGING_INPUTS_DIGEST_LABEL]: `sha256:${hex('e', 64)}`,
  [UPSTREAM_REVISION_LABEL]: hex('f', 40),
  [PACKAGING_SOURCE_REVISION_LABEL]: hex('1', 40),
  [NODE_BASE_LABEL]: `sha256:${hex('2', 64)}`,
  [RUST_BASE_LABEL]: `sha256:${hex('3', 64)}`,
  [MONOLITH_VERSION_LABEL]: '2.8.3',
};

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
    ['fake-regctl', ['manifest', 'head', '--require-digest', `${repository}:v2.15.1`], { REGCTL_LOG: 'warn' }],
    ['fake-regctl', ['manifest', 'get', '--format', 'raw-body', `${repository}@${parentDigest}`], { REGCTL_LOG: 'warn' }],
    ['fake-regctl', ['image', 'inspect', `${repository}@${amd64Digest}`], { REGCTL_LOG: 'warn' }],
    ['fake-regctl', ['image', 'inspect', `${repository}@${arm64Digest}`], { REGCTL_LOG: 'warn' }],
  ]);
});

test('classifies only manifest unknown or actual 404 responses as missing', async () => {
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

  assert.equal(missing.kind, 'Missing');
  assert.equal(unauthorized.kind, 'Error');
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
    /digest-qualified/,
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
