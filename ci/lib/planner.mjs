import {
  RECIPE_ID_LABEL,
  TARGET_PLATFORMS,
  UPSTREAM_REVISION_LABEL,
  VERSION_LABEL,
  compareArtifacts,
} from './artifact.mjs';

export { TARGET_PLATFORMS };

function requirePlatforms(platforms) {
  if (!Array.isArray(platforms)
    || platforms.length !== TARGET_PLATFORMS.length
    || TARGET_PLATFORMS.some((platform) => !platforms.includes(platform))) {
    throw new TypeError('Requested platforms must include exactly linux/amd64 and linux/arm64');
  }
}

function requireDesired(desired) {
  if (!desired || typeof desired.recipeId !== 'string' || typeof desired.upstreamTag !== 'string' || typeof desired.upstreamCommit !== 'string') {
    throw new TypeError('Desired recipeId, upstreamTag, and upstreamCommit are required');
  }
}

function throwIfUnsafe(artifact) {
  if (artifact?.kind === 'Error' || artifact?.kind === 'Conflict') {
    throw new Error(artifact.message ?? `Unsafe artifact state: ${artifact.kind}`);
  }
}

function hasUpstreamIdentity(artifact, desired) {
  return artifact?.kind === 'Valid'
    && artifact.validatedLabels[VERSION_LABEL] === desired.upstreamTag
    && artifact.validatedLabels[UPSTREAM_REVISION_LABEL] === desired.upstreamCommit;
}

/**
 * Find an already validated source that represents exactly the desired build.
 * Missing entries are ignored; Errors and Conflicts intentionally stop planning.
 *
 * @param {object[]} artifacts
 * @param {{recipeId: string, upstreamTag: string, upstreamCommit: string}} desired
 * @returns {object | undefined}
 */
export function findMatchingSource(artifacts, desired) {
  requireDesired(desired);
  if (!Array.isArray(artifacts)) {
    throw new TypeError('Artifacts must be an array');
  }
  for (const artifact of artifacts) {
    throwIfUnsafe(artifact);
    if (artifact?.kind === 'Valid'
      && artifact.recipeId === desired.recipeId
      && artifact.validatedLabels[RECIPE_ID_LABEL] === desired.recipeId
      && hasUpstreamIdentity(artifact, desired)) {
      return artifact;
    }
  }
  return undefined;
}

/**
 * Choose an existing source or require a build for exactly both target platforms.
 *
 * @param {{sources: object[], desired: object, platforms: string[]}} input
 * @returns {object}
 */
export function ensureArtifact({ sources, desired, platforms } = {}) {
  requirePlatforms(platforms);
  const existing = findMatchingSource(sources, desired);
  return existing
    ? { kind: 'Reuse', source: existing.sourceRef, artifact: existing }
    : { kind: 'Build', recipe: desired, platforms: [...TARGET_PLATFORMS] };
}

/**
 * Plan one tag independently of registry command execution.
 * Version tags remain immutable after an existing matching upstream artifact;
 * mutable tags are reconciled to the desired artifact content.
 *
 * @param {{existing: object, desiredArtifact?: object, desired: object, destination: string, immutable?: boolean}} input
 * @returns {object}
 */
export function ensureTag({ existing, desiredArtifact, desired, destination, immutable = false } = {}) {
  requireDesired(desired);
  if (typeof destination !== 'string' || destination.length === 0) {
    throw new TypeError('Tag destination is required');
  }
  throwIfUnsafe(existing);
  if (existing?.kind === 'Missing' || existing === undefined) {
    return { kind: 'SetTag', destination };
  }
  if (existing?.kind !== 'Valid') {
    throw new Error('Unsafe artifact state');
  }
  if (immutable) {
    if (!hasUpstreamIdentity(existing, desired)) {
      throw new Error(`Existing immutable tag ${destination} has different upstream identity`);
    }
    return { kind: 'Keep', destination };
  }
  return compareArtifacts(existing, desiredArtifact)
    ? { kind: 'Keep', destination }
    : { kind: 'SetTag', destination };
}

/**
 * Plan source reuse/build plus immutable version and mutable latest tag actions.
 * The caller executes Build before any SetTag actions when a build is required.
 *
 * @param {{desired: object, platforms: string[], sourceArtifacts: object[], versionArtifact: object, latestArtifact: object, versionTag: string, latestTag: string}} input
 * @returns {{artifact: object, version: object, latest: object}}
 */
export function planRun({
  desired,
  platforms,
  sourceArtifacts = [],
  versionArtifact,
  latestArtifact,
  versionTag,
  latestTag,
} = {}) {
  requirePlatforms(platforms);
  const artifact = ensureArtifact({
    sources: [...sourceArtifacts, versionArtifact, latestArtifact].filter(Boolean),
    desired,
    platforms,
  });
  const desiredArtifact = artifact.kind === 'Reuse' ? artifact.artifact : undefined;
  return {
    artifact,
    version: ensureTag({
      existing: versionArtifact,
      desiredArtifact,
      desired,
      destination: versionTag,
      immutable: true,
    }),
    latest: ensureTag({
      existing: latestArtifact,
      desiredArtifact,
      desired,
      destination: latestTag,
    }),
  };
}
