import { createHash } from 'node:crypto';

export const RECIPE_HEADER = 'linkwarden-slim-recipe-v1';

const HEX_40 = /^[a-f0-9]{40}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

const FIELDS = [
  ['upstreamTag', isText],
  ['upstreamCommit', (value) => HEX_40.test(value)],
  ['packagingSourceSha', (value) => HEX_40.test(value)],
  ['nodeIndexDigest', (value) => SHA256_DIGEST.test(value)],
  ['rustIndexDigest', (value) => SHA256_DIGEST.test(value)],
  ['packagingInputsDigest', (value) => SHA256_DIGEST.test(value)],
  ['monolithVersion', isText],
];

function isText(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function requireField(name, value, valid) {
  if (!valid(value)) {
    throw new TypeError(`Invalid ${name}`);
  }
}

/**
 * Validate a recipe without adding derived fields.
 *
 * @param {object} recipe
 * @returns {object}
 */
export function validateRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') {
    throw new TypeError('Recipe must be an object');
  }
  if (recipe.schemaVersion !== 'v1') {
    throw new TypeError('Invalid schemaVersion');
  }
  for (const [name, valid] of FIELDS) {
    requireField(name, recipe[name], valid);
  }
  return recipe;
}

/**
 * Return the stable bytes used to derive a v1 recipe id.
 *
 * @param {object} recipe
 * @returns {Buffer}
 */
export function encodeRecipe(recipe) {
  validateRecipe(recipe);
  return Buffer.from([
    RECIPE_HEADER,
    ...FIELDS.map(([name]) => recipe[name]),
  ].join('\0'));
}

/**
 * @param {object} recipe
 * @returns {string}
 */
export function recipeIdFor(recipe) {
  return createHash('sha256').update(encodeRecipe(recipe)).digest('hex');
}

/**
 * Return a validated recipe with its deterministic id.
 *
 * @param {object} recipe
 * @returns {object}
 */
export function createRecipe(recipe) {
  const validated = validateRecipe(recipe);
  const recipeId = recipeIdFor(validated);
  if (validated.recipeId !== undefined && validated.recipeId !== recipeId) {
    throw new TypeError('Invalid recipeId');
  }
  return { ...validated, recipeId };
}

/**
 * Hash packaging files in their caller-defined order. Each path and content
 * buffer is length-prefixed with an unsigned 64-bit big-endian integer, which
 * keeps arbitrary binary bytes unambiguous for ci/run-source-tests.sh.
 *
 * @param {Array<{path: string, bytes: Buffer}>} inputs
 * @returns {string}
 */
export function packagingInputsDigest(inputs) {
  if (!Array.isArray(inputs)) {
    throw new TypeError('Packaging inputs must be an array');
  }
  const hash = createHash('sha256');
  for (const input of inputs) {
    if (!input || !isText(input.path)) {
      throw new TypeError('Invalid packaging input path');
    }
    if (!Buffer.isBuffer(input.bytes)) {
      throw new TypeError('Invalid packaging input bytes');
    }
    const pathBytes = Buffer.from(input.path, 'utf8');
    const pathLength = Buffer.alloc(8);
    const contentLength = Buffer.alloc(8);
    pathLength.writeBigUInt64BE(BigInt(pathBytes.length));
    contentLength.writeBigUInt64BE(BigInt(input.bytes.length));
    hash.update(pathLength).update(pathBytes).update(contentLength).update(input.bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}
