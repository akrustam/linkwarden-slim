import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatSourceReference,
  parseDestinationReference,
  parseSourceReference,
} from './reference.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const repository = 'registry.example/team/linkwarden-slim';

test('parses canonical immutable source and mutable destination references', () => {
  assert.deepEqual(parseSourceReference(`${repository}@${digest}`), { repository, digest });
  assert.deepEqual(parseDestinationReference(`${repository}:v2.15.1`), { repository, tag: 'v2.15.1' });
  assert.deepEqual(
    parseDestinationReference('ghcr.io/akrustam/linkwarden-slim:candidate-foo'),
    { repository: 'ghcr.io/akrustam/linkwarden-slim', tag: 'candidate-foo' },
  );
  assert.deepEqual(
    parseDestinationReference('docker.io/user/linkwarden-slim:latest'),
    { repository: 'docker.io/user/linkwarden-slim', tag: 'latest' },
  );
  assert.equal(formatSourceReference(repository, digest), `${repository}@${digest}`);
});

test('rejects unsafe or malformed references', () => {
  for (const source of [
    `-${repository}@${digest}`,
    `${repository}@${digest}@${digest}`,
    `${repository}:latest`,
    `${repository}@sha256:${'A'.repeat(64)}`,
    `registry.example/team/with space@${digest}`,
  ]) {
    assert.throws(() => parseSourceReference(source), /source reference/);
  }
  for (const destination of [
    `-${repository}:latest`,
    `${repository}@${digest}`,
    `${repository}:`,
    `registry.example/team/with space:latest`,
    'linkwarden-slim:latest',
  ]) {
    assert.throws(() => parseDestinationReference(destination), /destination reference/);
  }
});
