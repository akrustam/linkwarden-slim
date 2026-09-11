import { parseSourceReference } from './reference.mjs';
import { createRecipe } from './recipe.mjs';

export const TARGET_PLATFORMS = ['linux/amd64', 'linux/arm64'];
export const VERSION_LABEL = 'org.opencontainers.image.version';
export const PACKAGING_INPUTS_DIGEST_LABEL = 'org.opencontainers.image.revision';
export const RECIPE_ID_LABEL = 'io.linkwarden-slim.recipe-id';
export const UPSTREAM_REVISION_LABEL = 'io.linkwarden-slim.upstream-revision';
export const PACKAGING_SOURCE_REVISION_LABEL = 'io.linkwarden-slim.packaging-source-revision';
export const NODE_BASE_LABEL = 'io.linkwarden-slim.node-base';
export const RUST_BASE_LABEL = 'io.linkwarden-slim.rust-base';
export const MONOLITH_VERSION_LABEL = 'io.linkwarden-slim.monolith-version';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RECIPE_ID = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const IMAGE_MANIFEST = /^application\/vnd\.(?:oci\.image\.manifest\.v1|docker\.distribution\.manifest\.v2)\+json$/;
const INDEX_MANIFEST = /^application\/vnd\.(?:oci\.image\.index\.v1|docker\.distribution\.manifest\.list\.v2)\+json$/;
const PROVENANCE_LABELS = [
  RECIPE_ID_LABEL,
  VERSION_LABEL,
  PACKAGING_INPUTS_DIGEST_LABEL,
  UPSTREAM_REVISION_LABEL,
  PACKAGING_SOURCE_REVISION_LABEL,
  NODE_BASE_LABEL,
  RUST_BASE_LABEL,
  MONOLITH_VERSION_LABEL,
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equalRecords(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function conflict(message) {
  return { kind: 'Conflict', message };
}

function selectedLabels(config) {
  const labels = config?.config?.Labels;
  if (!isRecord(labels)) {
    return null;
  }
  const selected = Object.fromEntries(PROVENANCE_LABELS.map((name) => [name, labels[name]]));
  if (!RECIPE_ID.test(selected[RECIPE_ID_LABEL] ?? '')
    || typeof selected[VERSION_LABEL] !== 'string' || selected[VERSION_LABEL].length === 0
    || !DIGEST.test(selected[PACKAGING_INPUTS_DIGEST_LABEL] ?? '')
    || !REVISION.test(selected[UPSTREAM_REVISION_LABEL] ?? '')
    || !REVISION.test(selected[PACKAGING_SOURCE_REVISION_LABEL] ?? '')
    || !DIGEST.test(selected[NODE_BASE_LABEL] ?? '')
    || !DIGEST.test(selected[RUST_BASE_LABEL] ?? '')
    || typeof selected[MONOLITH_VERSION_LABEL] !== 'string' || selected[MONOLITH_VERSION_LABEL].length === 0) {
    return null;
  }
  return selected;
}

function descriptorPlatform(descriptor) {
  if (!isRecord(descriptor?.platform)) {
    return null;
  }
  return `${descriptor.platform.os}/${descriptor.platform.architecture}`;
}

function isAttestation(descriptor) {
  return descriptor?.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest';
}

function validAttestation(descriptor) {
  return isRecord(descriptor)
    && DIGEST.test(descriptor.digest ?? '')
    && IMAGE_MANIFEST.test(descriptor.mediaType ?? '')
    && descriptor?.platform?.os === 'unknown'
    && descriptor?.platform?.architecture === 'unknown'
    && isAttestation(descriptor);
}

function recipeFromLabels(labels) {
  return createRecipe({
    schemaVersion: 'v1',
    upstreamTag: labels[VERSION_LABEL],
    upstreamCommit: labels[UPSTREAM_REVISION_LABEL],
    packagingSourceSha: labels[PACKAGING_SOURCE_REVISION_LABEL],
    nodeIndexDigest: labels[NODE_BASE_LABEL],
    rustIndexDigest: labels[RUST_BASE_LABEL],
    packagingInputsDigest: labels[PACKAGING_INPUTS_DIGEST_LABEL],
    monolithVersion: labels[MONOLITH_VERSION_LABEL],
  });
}

/**
 * Validate an OCI index and the configs selected from its target descriptors.
 * Incompatible, but parseable, content is a Conflict; adapters reserve Error
 * for command and response parsing failures.
 *
 * @param {{sourceRef: string, index: object, configs: Record<string, object>}} input
 * @returns {{kind: 'Valid', recipeId: string, sourceRef: string, platformDigests: Record<'linux/amd64'|'linux/arm64', string>, validatedLabels: Record<string, string>} | {kind: 'Conflict', message: string} | {kind: 'Error', message: string}}
 */
export function validateArtifact({ sourceRef, index, configs } = {}) {
  try {
    parseSourceReference(sourceRef);
  } catch {
    return { kind: 'Error', message: 'Invalid artifact source reference' };
  }
  if (!isRecord(index) || !Array.isArray(index.manifests) || !isRecord(configs)) {
    return { kind: 'Error', message: 'Malformed artifact response' };
  }
  if (index.schemaVersion !== 2 || !INDEX_MANIFEST.test(index.mediaType ?? '')) {
    return conflict('Invalid parent index envelope');
  }

  const selected = new Map();
  for (const descriptor of index.manifests) {
    if (isAttestation(descriptor)) {
      if (!validAttestation(descriptor)) {
        return conflict('Invalid attestation descriptor');
      }
      continue;
    }
    if (!isRecord(descriptor) || !DIGEST.test(descriptor.digest ?? '')) {
      return conflict('Invalid manifest descriptor');
    }
    if (!IMAGE_MANIFEST.test(descriptor.mediaType ?? '')) {
      return conflict('Application descriptor must be an image manifest');
    }
    const platform = descriptorPlatform(descriptor);
    if (!TARGET_PLATFORMS.includes(platform)) {
      return conflict(`Unexpected application platform ${platform ?? 'unknown'}`);
    }
    if (selected.has(platform)) {
      return conflict(`Duplicate application platform ${platform}`);
    }
    selected.set(platform, descriptor.digest);
  }

  if (selected.size !== TARGET_PLATFORMS.length || TARGET_PLATFORMS.some((platform) => !selected.has(platform))) {
    return conflict('Artifact must contain exactly linux/amd64 and linux/arm64 application manifests');
  }
  if (Object.keys(configs).some((platform) => !TARGET_PLATFORMS.includes(platform))) {
    return conflict('Unexpected selected platform config');
  }

  let validatedLabels;
  for (const platform of TARGET_PLATFORMS) {
    const config = configs[platform];
    const [os, architecture] = platform.split('/');
    if (!isRecord(config) || config.os !== os || config.architecture !== architecture) {
      return conflict(`Config does not match ${platform}`);
    }
    const labels = selectedLabels(config);
    if (!labels) {
      return conflict(`Missing or invalid labels for ${platform}`);
    }
    if (validatedLabels && !equalRecords(validatedLabels, labels)) {
      return conflict('Target platform labels differ');
    }
    validatedLabels = labels;
  }

  let recipe;
  try {
    recipe = recipeFromLabels(validatedLabels);
  } catch {
    return conflict('Invalid recipe provenance labels');
  }
  if (recipe.recipeId !== validatedLabels[RECIPE_ID_LABEL]) {
    return conflict('Recipe id does not match provenance labels');
  }

  return {
    kind: 'Valid',
    recipeId: recipe.recipeId,
    sourceRef,
    platformDigests: Object.fromEntries(TARGET_PLATFORMS.map((platform) => [platform, selected.get(platform)])),
    validatedLabels,
  };
}

/**
 * Compare the immutable artifact content relevant to reuse. The parent index
 * digest is intentionally ignored because attestations can change it.
 *
 * @param {{kind: string, recipeId?: string, platformDigests?: Record<string, string>, validatedLabels?: Record<string, string>}} left
 * @param {{kind: string, recipeId?: string, platformDigests?: Record<string, string>, validatedLabels?: Record<string, string>}} right
 * @returns {boolean}
 */
export function compareArtifacts(left, right) {
  return left?.kind === 'Valid'
    && right?.kind === 'Valid'
    && left.recipeId === right.recipeId
    && equalRecords(left.platformDigests, right.platformDigests)
    && equalRecords(left.validatedLabels, right.validatedLabels);
}
