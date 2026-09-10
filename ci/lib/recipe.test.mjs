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
    nodeIndexDigest: hex('c', 64),
    rustIndexDigest: hex('d', 64),
    packagingInputsDigest: hex('e', 64),
    monolithVersion: '2.8.3',
    ...overrides,
  };
}

test('encodes v1 recipes as canonical NUL-delimited bytes and hashes those bytes', () => {
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
  assert.throws(() => encodeRecipe(recipeInput({ nodeIndexDigest: `sha256:${hex('c', 64)}` })), /nodeIndexDigest/);
  assert.throws(() => encodeRecipe(recipeInput({ schemaVersion: 'v2' })), /schemaVersion/);
  assert.throws(() => encodeRecipe(recipeInput({ packagingSourceSha: undefined })), /packagingSourceSha/);
});

test('hashes packaging inputs in the supplied path order using path NUL bytes NUL', () => {
  const inputs = [
    { path: 'Dockerfile', bytes: Buffer.from('FROM node\n') },
    { path: 'docker-entrypoint.sh', bytes: Buffer.from('#!/bin/sh\n') },
  ];
  const expected = createHash('sha256')
    .update('Dockerfile\0')
    .update(Buffer.from('FROM node\n'))
    .update('\0docker-entrypoint.sh\0')
    .update(Buffer.from('#!/bin/sh\n'))
    .update('\0')
    .digest('hex');

  assert.equal(packagingInputsDigest(inputs), expected);
  assert.notEqual(packagingInputsDigest([...inputs].reverse()), expected);
  assert.throws(() => packagingInputsDigest([{ path: 'bad\0path', bytes: Buffer.alloc(0) }]), /path/);
  assert.throws(() => packagingInputsDigest([{ path: 'Dockerfile', bytes: 'text' }]), /bytes/);
});
