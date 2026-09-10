export const TARGET_PLATFORMS = ['linux/amd64', 'linux/arm64'];
export const RECIPE_ID_LABEL = 'org.opencontainers.image.recipe-id';
export const VERSION_LABEL = 'org.opencontainers.image.version';
export const REVISION_LABEL = 'org.opencontainers.image.revision';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RECIPE_ID = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const IMAGE_MANIFEST = /^application\/vnd\.(?:oci\.image\.manifest\.v1|docker\.distribution\.manifest\.v2)\+json$/;

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
  if (!isRecord(labels) || Object.values(labels).some((value) => typeof value !== 'string')) {
    return null;
  }
  if (!RECIPE_ID.test(labels[RECIPE_ID_LABEL] ?? '')) {
    return null;
  }
  if (typeof labels[VERSION_LABEL] !== 'string' || labels[VERSION_LABEL].length === 0) {
    return null;
  }
  if (!REVISION.test(labels[REVISION_LABEL] ?? '')) {
    return null;
  }
  return { ...labels };
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

/**
 * Validate an OCI index and the configs selected from its target descriptors.
 * Incompatible, but parseable, content is a Conflict; adapters reserve Error
 * for command and response parsing failures.
 *
 * @param {{sourceRef: string, index: object, configs: Record<string, object>}} input
 * @returns {{kind: 'Valid', recipeId: string, sourceRef: string, platformDigests: Record<string, string>, validatedLabels: Record<string, string>} | {kind: 'Conflict', message: string} | {kind: 'Error', message: string}}
 */
export function validateArtifact({ sourceRef, index, configs } = {}) {
  if (typeof sourceRef !== 'string' || !/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(sourceRef)) {
    return { kind: 'Error', message: 'Invalid artifact source reference' };
  }
  if (!isRecord(index) || !Array.isArray(index.manifests) || !isRecord(configs)) {
    return { kind: 'Error', message: 'Malformed artifact response' };
  }

  const selected = new Map();
  for (const descriptor of index.manifests) {
    if (!isRecord(descriptor) || !DIGEST.test(descriptor.digest ?? '')) {
      return conflict('Invalid manifest descriptor');
    }
    if (isAttestation(descriptor)) {
      continue;
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

  return {
    kind: 'Valid',
    recipeId: validatedLabels[RECIPE_ID_LABEL],
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
