import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createRecipe,
  encodeRecipe,
  packagingInputsDigest,
  recipeIdFor,
} from './recipe.mjs';

const hex = (character, length) => character.repeat(length);

function recipeInput(overrides = {}) {
  return {
    schemaVersion: 'v1',
    upstreamTag: 'v2.15.1',
    upstreamCommit: hex('a', 40),
    packagingSourceSha: hex('b', 40),
    nodeIndexDigest: `sha256:${hex('c', 64)}`,
    rustIndexDigest: `sha256:${hex('d', 64)}`,
    packagingInputsDigest: `sha256:${hex('e', 64)}`,
    monolithVersion: '2.8.3',
    ...overrides,
  };
}

test('encodes v1 recipes as canonical NUL-delimited bytes with digest-qualified fields', () => {
  const recipe = recipeInput();
  const encoded = encodeRecipe(recipe);
  const expected = [
    'linkwarden-slim-recipe-v1',
    recipe.upstreamTag,
    recipe.upstreamCommit,
    recipe.packagingSourceSha,
    recipe.nodeIndexDigest,
    recipe.rustIndexDigest,
    recipe.packagingInputsDigest,
    recipe.monolithVersion,
  ].join('\0');

  assert.deepEqual(encoded, Buffer.from(expected));
  const expectedId = createHash('sha256').update(encoded).digest('hex');
  assert.equal(recipeIdFor(recipe), expectedId);
  assert.equal(createRecipe(recipe).recipeId, expectedId);
});

test('rejects missing, NUL-containing, and non-canonical recipe fields', () => {
  assert.throws(() => encodeRecipe(recipeInput({ upstreamTag: '' })), /upstreamTag/);
  assert.throws(() => encodeRecipe(recipeInput({ monolithVersion: '2\0.8.3' })), /monolithVersion/);
  assert.throws(() => encodeRecipe(recipeInput({ upstreamCommit: hex('A', 40) })), /upstreamCommit/);
  assert.throws(() => encodeRecipe(recipeInput({ nodeIndexDigest: hex('c', 64) })), /nodeIndexDigest/);
  assert.throws(() => encodeRecipe(recipeInput({ rustIndexDigest: `sha256:${hex('D', 64)}` })), /rustIndexDigest/);
  assert.throws(() => encodeRecipe(recipeInput({ schemaVersion: 'v2' })), /schemaVersion/);
  assert.throws(() => encodeRecipe(recipeInput({ packagingSourceSha: undefined })), /packagingSourceSha/);
});

test('hashes packaging inputs with length framing in supplied path order', () => {
  const inputs = [
    { path: 'Dockerfile', bytes: Buffer.from('FROM node\n') },
    { path: 'docker-entrypoint.sh', bytes: Buffer.from('#!/bin/sh\n') },
  ];
  const expected = createHash('sha256')
    .update(Buffer.from([0, 0, 0, 0, 0, 0, 0, 10]))
    .update('Dockerfile')
    .update(Buffer.from([0, 0, 0, 0, 0, 0, 0, 10]))
    .update(Buffer.from('FROM node\n'))
    .update(Buffer.from([0, 0, 0, 0, 0, 0, 0, 20]))
    .update('docker-entrypoint.sh')
    .update(Buffer.from([0, 0, 0, 0, 0, 0, 0, 10]))
    .update(Buffer.from('#!/bin/sh\n'))
    .digest('hex');

  assert.equal(packagingInputsDigest(inputs), `sha256:${expected}`);
  assert.notEqual(packagingInputsDigest([...inputs].reverse()), expected);
  assert.throws(() => packagingInputsDigest([{ path: 'bad\0path', bytes: Buffer.alloc(0) }]), /path/);
  assert.throws(() => packagingInputsDigest([{ path: 'Dockerfile', bytes: 'text' }]), /bytes/);
});

test('distinguishes binary input sequences that collide under NUL delimiter framing', () => {
  const first = [
    { path: 'a', bytes: Buffer.from('x\0b\0c') },
  ];
  const second = [
    { path: 'a', bytes: Buffer.from('x') },
    { path: 'b', bytes: Buffer.from('c') },
  ];
  const oldEncoding = (inputs) => Buffer.concat(inputs.flatMap(({ path, bytes }) => [
    Buffer.from(path), Buffer.from('\0'), bytes, Buffer.from('\0'),
  ]));

  assert.deepEqual(oldEncoding(first), oldEncoding(second));
  assert.notEqual(packagingInputsDigest(first), packagingInputsDigest(second));
});
