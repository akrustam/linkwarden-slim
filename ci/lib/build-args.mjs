import { createRecipe } from './recipe.mjs';

const DIGEST_REFERENCE = /^[^@\s]+@sha256:[a-f0-9]{64}$/;

function requireDigestReference(name, value) {
  if (typeof value !== 'string' || !DIGEST_REFERENCE.test(value)) {
    throw new TypeError(`Invalid ${name}: expected a digest-qualified image reference`);
  }
}

/**
 * Build the complete, ordered Docker build-arg values for a recipe.
 *
 * @param {{recipe: object, nodeImage: string, rustImage: string}} input
 * @returns {string[]}
 */
export function buildArgsForRecipe({ recipe, nodeImage, rustImage } = {}) {
  const value = createRecipe(recipe);
  requireDigestReference('nodeImage', nodeImage);
  requireDigestReference('rustImage', rustImage);

  return [
    `NODE_IMAGE=${nodeImage}`,
    `RUST_IMAGE=${rustImage}`,
    `MONOLITH_VERSION=${value.monolithVersion}`,
    `UPSTREAM_TAG=${value.upstreamTag}`,
    `UPSTREAM_SHA=${value.upstreamCommit}`,
    `RECIPE_ID=${value.recipeId}`,
    `PACKAGING_INPUTS_DIGEST=${value.packagingInputsDigest}`,
    `PACKAGING_SOURCE_SHA=${value.packagingSourceSha}`,
    `NODE_BASE_DIGEST=${value.nodeIndexDigest}`,
    `RUST_BASE_DIGEST=${value.rustIndexDigest}`,
  ];
}

/**
 * Convert build-arg values to alternating Docker CLI argv elements.
 *
 * @param {string[]} values
 * @returns {string[]}
 */
export function buildArgPairs(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new TypeError('Build arguments must be an array of strings');
  }
  return values.flatMap((value) => ['--build-arg', value]);
}
