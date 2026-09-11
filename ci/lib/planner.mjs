import {
  RECIPE_ID_LABEL,
  TARGET_PLATFORMS,
  UPSTREAM_REVISION_LABEL,
  VERSION_LABEL,
  compareArtifacts,
} from './artifact.mjs';
import { parseDestinationReference, parseSourceReference } from './reference.mjs';
import { createRecipe } from './recipe.mjs';

export { TARGET_PLATFORMS };

function requireRecipe(recipe) {
  if (recipe?.recipeId !== undefined) {
    throw new TypeError('Recipe input must not supply recipeId');
  }
  return createRecipe(recipe);
}

function throwIfUnsafe(artifact) {
  if (!artifact || !['Missing', 'Valid'].includes(artifact.kind)) {
    throw new Error(artifact?.message ?? `Unsafe artifact state: ${artifact?.kind ?? 'absent'}`);
  }
}

function hasUpstreamIdentity(artifact, desired) {
  return artifact?.kind === 'Valid'
    && artifact.validatedLabels[VERSION_LABEL] === desired.upstreamTag
    && artifact.validatedLabels[UPSTREAM_REVISION_LABEL] === desired.upstreamCommit;
}

function validTagSource(source, desired) {
  if (source?.kind === 'BuildOutput') {
    return true;
  }
  if (source?.kind !== 'Valid'
    || source.recipeId !== desired.recipeId
    || source.validatedLabels?.[RECIPE_ID_LABEL] !== desired.recipeId
    || !hasUpstreamIdentity(source, desired)) {
    return false;
  }
  try {
    parseSourceReference(source.sourceRef);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an already validated source that represents exactly the desired build.
 * Missing entries are ignored; Errors and Conflicts intentionally stop planning.
 *
 * @param {object[]} artifacts
 * @param {object} recipe
 * @returns {object | undefined}
 */
export function findMatchingSource(artifacts, recipe) {
  const desired = requireRecipe(recipe);
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
 * @param {{sources: object[], recipe: object}} input
 * @returns {object}
 */
export function ensureArtifact({ sources, recipe } = {}) {
  const desired = requireRecipe(recipe);
  const existing = findMatchingSource(sources, recipe);
  return existing
    ? { kind: 'Reuse', source: existing.sourceRef, artifact: existing }
    : { kind: 'Build', recipe: desired, platforms: [...TARGET_PLATFORMS] };
}

/**
 * Plan one tag independently of registry command execution.
 * Version tags remain immutable after an existing matching upstream artifact;
 * mutable tags are reconciled to the desired artifact content.
 *
 * @param {{existing: object, source?: object, recipe: object, destination: string, immutable?: boolean}} input
 * @returns {object}
 */
export function ensureTag({ existing, source, recipe, destination, immutable = false } = {}) {
  const desired = requireRecipe(recipe);
  try {
    parseDestinationReference(destination);
  } catch {
    throw new TypeError('Tag destination is required');
  }
  throwIfUnsafe(existing);
  if (existing?.kind === 'Missing') {
    if (!validTagSource(source, desired)) {
      throw new Error('SetTag requires a valid artifact or BuildOutput source');
    }
    return { kind: 'SetTag', destination, source };
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
  if (compareArtifacts(existing, source)) {
    return { kind: 'Keep', destination };
  }
  if (!validTagSource(source, desired)) {
    throw new Error('SetTag requires a valid artifact or BuildOutput source');
  }
  return { kind: 'SetTag', destination, source };
}

/**
 * Plan source reuse/build plus immutable version and mutable latest tag actions.
 * The caller executes Build before any SetTag actions when a build is required.
 *
 * @param {{recipe: object, sourceArtifacts: object[], versionArtifact: object, latestArtifact: object, versionTag: string, latestTag: string}} input
 * @returns {{artifact: object, version: object, latest: object}}
 */
export function planRun({
  recipe,
  sourceArtifacts = [],
  versionArtifact,
  latestArtifact,
  versionTag,
  latestTag,
} = {}) {
  const artifact = ensureArtifact({
    sources: [...sourceArtifacts, versionArtifact, latestArtifact].filter(Boolean),
    recipe,
  });
  const source = artifact.kind === 'Reuse' ? artifact.artifact : { kind: 'BuildOutput' };
  return {
    artifact,
    version: ensureTag({
      existing: versionArtifact,
      source,
      recipe,
      destination: versionTag,
      immutable: true,
    }),
    latest: ensureTag({
      existing: latestArtifact,
      source,
      recipe,
      destination: latestTag,
    }),
  };
}
