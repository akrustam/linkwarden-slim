#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { buildArgPairs, buildArgsForRecipe } from './lib/build-args.mjs';
import { compareArtifacts } from './lib/artifact.mjs';
import { copyReference, inspectReference, inspectSourceReference } from './lib/registry.mjs';
import { formatSourceReference, parseDestinationReference, parseSourceReference } from './lib/reference.mjs';
import { createRecipe } from './lib/recipe.mjs';
import { digestPackagingInputs, validationFingerprintFor } from './resolve-inputs.mjs';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function buildDockerCommand({ input, context, target, tag, packagingExport }) {
  const args = buildArgPairs(buildArgsForRecipe({ recipe: input.recipe, nodeImage: input.nodeImage, rustImage: input.rustImage }));
  return ['docker', 'build', '--platform', 'linux/amd64', '--load', '--file', join(packagingExport, 'Dockerfile'), '--target', target, '--tag', tag, ...args, context];
}

export function buildxStagingCommand({ input, context, staging, metadataFile, packagingExport }) {
  const args = buildArgPairs(buildArgsForRecipe({ recipe: input.recipe, nodeImage: input.nodeImage, rustImage: input.rustImage }));
  return ['docker', 'buildx', 'build', '--platform', 'linux/amd64,linux/arm64', '--push', '--file', join(packagingExport, 'Dockerfile'), '--provenance=false', '--sbom=false', '--metadata-file', metadataFile, '--tag', staging, ...args, context];
}

export function runCommand(command, args, { env = process.env, cwd } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal }));
  });
}

async function mustRun(command, args, options, run) {
  const result = await run(command, args, options);
  if (result.exitCode !== 0 || result.signal !== null) throw new Error(`${command} failed`);
}

function validateInputShape(input) {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid publish input');
  if (Object.hasOwn(input, 'packagingExport')) throw new TypeError('Invalid publish input');
  input.recipe = createRecipe(input.recipe);
  for (const key of ['nodeImage', 'rustImage', 'postgresImage', 'meiliImage']) parseSourceReference(input[key]);
  if (typeof input.packagingUrl !== 'string' || input.packagingUrl.length === 0
    || typeof input.upstreamUrl !== 'string' || input.upstreamUrl.length === 0
    || !SHA.test(input.upstreamSha ?? '')) {
    throw new TypeError('Invalid publish input');
  }
  const validationFingerprint = validationFingerprintFor(input);
  if (!DIGEST.test(input.validationFingerprint ?? '') || input.validationFingerprint !== validationFingerprint) {
    throw new TypeError('Invalid validationFingerprint');
  }
  return input;
}

export async function readInput(path) {
  return validateInputShape(JSON.parse(await readFile(resolve(path), 'utf8')));
}

async function sealContext(input, { run, workspace, digestPackaging = digestPackagingInputs } = {}) {
  if (workspace !== undefined) await mkdir(workspace, { recursive: true });
  const root = await mkdtemp(join(workspace ?? tmpdir(), 'linkwarden-publish-'));
  const packagingDir = join(root, 'packaging');
  const packagingExport = join(packagingDir, 'export');
  const context = join(root, 'context');
  try {
    await mustRun('bash', ['ci/materialize-packaging.sh', input.packagingUrl, input.recipe.packagingSourceSha, packagingDir], {}, run);
    const actualDigest = await digestPackaging(packagingExport);
    if (actualDigest !== input.recipe.packagingInputsDigest) {
      throw new Error('Materialized packaging inputs do not match the resolved recipe');
    }
    await mustRun('bash', ['ci/prepare-context.sh', input.upstreamUrl, input.upstreamSha, packagingExport, context], {}, run);
    return { context, packagingExport, root };
  } catch (cause) {
    await rm(root, { recursive: true, force: true });
    throw cause;
  }
}

async function materializeDependencies(input, run) {
  await mustRun('bash', ['ci/materialize-image.sh', 'linux/amd64', input.postgresImage, 'linkwarden-ci-postgres:latest'], {}, run);
  await mustRun('bash', ['ci/materialize-image.sh', 'linux/amd64', input.meiliImage, 'linkwarden-ci-meili:latest'], {}, run);
}

export async function validateSealedContext(input, sealed, { run = runCommand } = {}) {
  if (!sealed || typeof sealed.context !== 'string' || typeof sealed.packagingExport !== 'string') {
    throw new TypeError('A sealed context and packaging export are required');
  }
  await materializeDependencies(input, run);
  const sourceBuild = buildDockerCommand({ input, context: sealed.context, packagingExport: sealed.packagingExport, target: 'source-test', tag: 'linkwarden-ci-source-test:latest' });
  await mustRun(sourceBuild[0], sourceBuild.slice(1), {}, run);
  await mustRun('bash', ['ci/test-stack.sh', 'source'], {
    env: { ...process.env, CI_POSTGRES_IMAGE: 'linkwarden-ci-postgres:latest', CI_MEILI_IMAGE: 'linkwarden-ci-meili:latest', CI_SOURCE_TEST_IMAGE: 'linkwarden-ci-source-test:latest' },
  }, run);
  const appBuild = buildDockerCommand({ input, context: sealed.context, packagingExport: sealed.packagingExport, target: 'main-app', tag: 'linkwarden-ci-app:latest' });
  await mustRun(appBuild[0], appBuild.slice(1), {}, run);
  await mustRun('bash', ['ci/test-stack.sh', 'runtime'], {
    env: { ...process.env, CI_POSTGRES_IMAGE: 'linkwarden-ci-postgres:latest', CI_MEILI_IMAGE: 'linkwarden-ci-meili:latest', CI_IMAGE_REF: 'linkwarden-ci-app:latest', CI_PLATFORM: 'linux/amd64' },
  }, run);
}

async function validate(input, { run = runCommand, workspace, digestPackaging } = {}) {
  const sealed = await sealContext(input, { run, workspace, digestPackaging });
  try {
    await validateSealedContext(input, sealed, { run });
  } finally {
    await rm(sealed.root, { recursive: true, force: true });
  }
}

function artifactMatchesRecipe(artifact, recipe) {
  return artifact?.kind === 'Valid'
    && artifact.recipeId === recipe.recipeId
    && artifact.validatedLabels?.['io.linkwarden-slim.recipe-id'] === recipe.recipeId
    && artifact.validatedLabels?.['org.opencontainers.image.version'] === recipe.upstreamTag
    && artifact.validatedLabels?.['io.linkwarden-slim.upstream-revision'] === recipe.upstreamCommit;
}

function artifactMatchesUpstream(artifact, recipe) {
  return artifact?.kind === 'Valid'
    && artifact.validatedLabels?.['org.opencontainers.image.version'] === recipe.upstreamTag
    && artifact.validatedLabels?.['io.linkwarden-slim.upstream-revision'] === recipe.upstreamCommit;
}

function requireSafeInspection(artifact, reference) {
  if (!artifact || !['Missing', 'Valid'].includes(artifact.kind)) {
    throw new Error(artifact?.message ?? `Unable to inspect ${reference}`);
  }
}

async function testArtifactRuntime(artifact, input, run) {
  await materializeDependencies(input, run);
  for (const [platform, digest] of Object.entries(artifact.platformDigests)) {
    await mustRun('bash', ['ci/materialize-image.sh', platform, `${artifact.sourceRef.split('@')[0]}@${digest}`, `linkwarden-ci-${platform.replace('/', '-')}:latest`], {}, run);
    await mustRun('bash', ['ci/test-stack.sh', 'runtime'], {
      env: { ...process.env, CI_POSTGRES_IMAGE: 'linkwarden-ci-postgres:latest', CI_MEILI_IMAGE: 'linkwarden-ci-meili:latest', CI_IMAGE_REF: `linkwarden-ci-${platform.replace('/', '-')}:latest`, CI_PLATFORM: platform },
    }, run);
  }
}

function stagingSourceFromMetadata(staging, metadataText) {
  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch {
    throw new Error('Malformed Buildx metadata');
  }
  const digest = metadata?.['containerimage.digest'];
  if (!DIGEST.test(digest ?? '')) throw new Error('Buildx metadata does not contain a valid container image digest');
  return formatSourceReference(parseDestinationReference(staging).repository, digest);
}

async function createImmutableArtifact({ regctlPath, source, destination, expected, run }) {
  // Registries do not expose a portable conditional create, so reject a tag
  // that appears during the final pre-copy check instead of replacing it.
  const rechecked = await inspectReference({ regctlPath, reference: destination, run });
  requireSafeInspection(rechecked, destination);
  if (rechecked.kind === 'Valid') {
    if (!compareArtifacts(expected, rechecked)) {
      throw new Error(`${destination} differs from the expected immutable artifact`);
    }
    return rechecked;
  }
  await copyReference({ regctlPath, source, destination, run });
  const copied = await inspectReference({ regctlPath, reference: destination, run });
  if (!compareArtifacts(expected, copied)) {
    throw new Error(`${destination} does not match the expected immutable artifact`);
  }
  return copied;
}

async function copyAndVerifyArtifact({ regctlPath, source, destination, expected, run }) {
  await copyReference({ regctlPath, source, destination, run });
  const copied = await inspectReference({ regctlPath, reference: destination, run });
  if (!compareArtifacts(expected, copied)) {
    throw new Error(`${destination} does not match the expected artifact`);
  }
}

async function requireCandidate({ regctlPath, reference, expected, run }) {
  const candidate = await inspectReference({ regctlPath, reference, run });
  if (!compareArtifacts(expected, candidate)) {
    throw new Error(`${reference} does not match the verified artifact`);
  }
  return candidate;
}

async function refreshInputFromCommand({ freshCommand, freshArgs, run, workspace }) {
  const root = await mkdtemp(join(workspace ?? tmpdir(), 'linkwarden-fresh-'));
  const outputPath = join(root, 'input.json');
  try {
    await mustRun('bash', [freshCommand, '--out', outputPath, ...freshArgs], {}, run);
    return await readInput(outputPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function freshnessErrorResult(artifact, versionArtifact, cause) {
  return {
    desiredArtifact: artifact,
    desiredSource: artifact.sourceRef,
    versionArtifact,
    versionSource: versionArtifact.sourceRef,
    latest: 'skipped-freshness-error',
    freshnessError: cause instanceof Error ? cause.message : String(cause),
  };
}

function publishResult({ desiredArtifact, versionArtifact, latest, freshnessError }) {
  return {
    desiredArtifact,
    desiredSource: desiredArtifact.sourceRef,
    versionArtifact,
    versionSource: versionArtifact.sourceRef,
    latest,
    ...(freshnessError === undefined ? {} : { freshnessError }),
  };
}

export async function publishGhcrInput(input, {
  regctlPath,
  staging,
  ghcrCandidate,
  ghcrVersion,
  ghcrLatest,
  freshInput,
  freshInputPath,
  refreshInput,
  run = runCommand,
  registryRun,
  workspace,
  readMetadata = (path) => readFile(path, 'utf8'),
  digestPackaging,
} = {}) {
  validateInputShape(input);
  const recipe = input.recipe;
  for (const reference of [staging, ghcrCandidate, ghcrVersion, ghcrLatest]) parseDestinationReference(reference);
  const [initialGhcrCandidate, initialGhcrVersion] = await Promise.all([
    inspectReference({ regctlPath, reference: ghcrCandidate, run: registryRun }),
    inspectReference({ regctlPath, reference: ghcrVersion, run: registryRun }),
  ]);
  for (const [artifact, reference] of [
    [initialGhcrCandidate, ghcrCandidate], [initialGhcrVersion, ghcrVersion],
  ]) requireSafeInspection(artifact, reference);
  if (initialGhcrVersion.kind === 'Valid' && !artifactMatchesUpstream(initialGhcrVersion, recipe)) {
    throw new Error('Existing GHCR version artifact has a different upstream identity');
  }

  let desiredArtifact;
  if (artifactMatchesRecipe(initialGhcrCandidate, recipe)) {
    desiredArtifact = initialGhcrCandidate;
    await testArtifactRuntime(desiredArtifact, input, run);
  } else {
    const sealed = await sealContext(input, { run, workspace, digestPackaging });
    try {
      await validateSealedContext(input, sealed, { run });
      const metadataFile = join(sealed.root, 'metadata.json');
      const stagingBuild = buildxStagingCommand({ input, context: sealed.context, packagingExport: sealed.packagingExport, staging, metadataFile });
      await mustRun(stagingBuild[0], stagingBuild.slice(1), {}, run);
      const stagingSource = stagingSourceFromMetadata(staging, await readMetadata(metadataFile));
      desiredArtifact = await inspectSourceReference({ regctlPath, sourceRef: stagingSource, run: registryRun });
      if (!artifactMatchesRecipe(desiredArtifact, recipe)) throw new Error(desiredArtifact.message ?? 'Staging artifact does not match the resolved recipe');
      await testArtifactRuntime(desiredArtifact, input, run);
      await copyAndVerifyArtifact({ regctlPath, source: stagingSource, destination: ghcrCandidate, expected: desiredArtifact, run: registryRun });
    } finally {
      await rm(sealed.root, { recursive: true, force: true });
    }
  }
  desiredArtifact = await requireCandidate({ regctlPath, reference: ghcrCandidate, expected: desiredArtifact, run: registryRun });
  let versionArtifact = initialGhcrVersion;
  if (versionArtifact.kind === 'Missing') {
    versionArtifact = await createImmutableArtifact({
      regctlPath,
      source: desiredArtifact.sourceRef,
      destination: ghcrVersion,
      expected: desiredArtifact,
      run: registryRun,
    });
  }
  let refreshed;
  try {
    refreshed = refreshInput
      ? await refreshInput()
      : freshInput ?? (freshInputPath ? await readInput(freshInputPath) : undefined);
    validateInputShape(refreshed);
  } catch (cause) {
    return freshnessErrorResult(desiredArtifact, versionArtifact, cause);
  }
  if (refreshed.recipe.recipeId !== recipe.recipeId
    || refreshed.validationFingerprint !== input.validationFingerprint) {
    return publishResult({ desiredArtifact, versionArtifact, latest: 'skipped-stale' });
  }
  const ghcrLatestArtifact = await inspectReference({ regctlPath, reference: ghcrLatest, run: registryRun });
  requireSafeInspection(ghcrLatestArtifact, ghcrLatest);
  if (!compareArtifacts(ghcrLatestArtifact, desiredArtifact)) {
    await copyAndVerifyArtifact({ regctlPath, source: desiredArtifact.sourceRef, destination: ghcrLatest, expected: desiredArtifact, run: registryRun });
  }
  return publishResult({ desiredArtifact, versionArtifact, latest: 'published' });
}

function parseOptions(args, { allowed, required, name }) {
  if (args.length % 2 !== 0) throw new Error('Publish options require values');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith('--') || !allowed.includes(args[index]) || options[args[index]] !== undefined) {
      throw new Error(`Invalid ${name} option`);
    }
    options[args[index]] = args[index + 1];
  }
  for (const flag of required) {
    if (!options[flag]) throw new Error(`Missing ${flag}`);
  }
  return options;
}

function validateResultPath(options, flag) {
  if (!options[flag]?.trim() || options[flag].startsWith('--')) {
    throw new Error(`Invalid value for ${flag}`);
  }
}

export function parsePublishGhcrOptions(args) {
  const options = parseOptions(args, {
    name: 'publish-ghcr',
    allowed: ['--regctl', '--staging', '--ghcr-candidate', '--ghcr-version', '--ghcr-latest', '--fresh-input', '--fresh-command', '--fresh-args', '--result-out'],
    required: ['--regctl', '--staging', '--ghcr-candidate', '--ghcr-version', '--ghcr-latest', '--result-out'],
  });
  if (Boolean(options['--fresh-input']) === Boolean(options['--fresh-command'])) {
    throw new Error('Specify exactly one of --fresh-input or --fresh-command');
  }
  if (options['--fresh-command']) {
    try {
      const freshArgs = JSON.parse(options['--fresh-args'] ?? '');
      if (!Array.isArray(freshArgs) || !freshArgs.every((value) => typeof value === 'string' && value.length > 0)) throw new TypeError();
      options['--fresh-args'] = freshArgs;
    } catch {
      throw new Error('--fresh-args must be a JSON array of command arguments');
    }
  } else if (options['--fresh-args'] !== undefined) {
    throw new Error('--fresh-args requires --fresh-command');
  }
  if (options['--result-out'] !== undefined) validateResultPath(options, '--result-out');
  return options;
}

export function parseMirrorDockerOptions(args) {
  const options = parseOptions(args, {
    name: 'mirror-docker',
    allowed: ['--regctl', '--ghcr-candidate', '--ghcr-version', '--ghcr-latest', '--docker-version', '--docker-latest', '--result-in', '--result-out'],
    required: ['--regctl', '--ghcr-candidate', '--ghcr-version', '--ghcr-latest', '--docker-version', '--docker-latest', '--result-in', '--result-out'],
  });
  validateResultPath(options, '--result-in');
  validateResultPath(options, '--result-out');
  return options;
}

function requirePublishResult(result) {
  if (!result || !['published', 'skipped-stale', 'skipped-freshness-error'].includes(result.latest)) {
    throw new TypeError('Invalid GHCR publish result');
  }
  for (const key of ['desiredArtifact', 'versionArtifact']) {
    if (result[key]?.kind !== 'Valid') throw new TypeError('Invalid GHCR publish result');
  }
  for (const key of ['desiredSource', 'versionSource']) {
    try {
      parseSourceReference(result[key]);
    } catch {
      throw new TypeError('Invalid GHCR publish result');
    }
  }
  return result;
}

export async function mirrorDockerInput(input, {
  regctlPath,
  ghcrCandidate,
  ghcrVersion,
  ghcrLatest,
  dockerVersion,
  dockerLatest,
  result,
  registryRun,
} = {}) {
  validateInputShape(input);
  requirePublishResult(result);
  for (const reference of [ghcrCandidate, ghcrVersion, ghcrLatest, dockerVersion, dockerLatest]) parseDestinationReference(reference);
  const [checkedGhcrVersion, checkedDockerVersion] = await Promise.all([
    inspectReference({ regctlPath, reference: ghcrVersion, run: registryRun }),
    inspectReference({ regctlPath, reference: dockerVersion, run: registryRun }),
  ]);
  requireSafeInspection(checkedGhcrVersion, ghcrVersion);
  requireSafeInspection(checkedDockerVersion, dockerVersion);
  if (checkedGhcrVersion.kind !== 'Valid' || !compareArtifacts(checkedGhcrVersion, result.versionArtifact)) {
    throw new Error('GHCR version does not match the canonical version artifact');
  }
  let ghcrCandidateArtifact;
  let ghcrLatestArtifact;
  let dockerLatestArtifact;
  if (result.latest === 'published') {
    [ghcrCandidateArtifact, ghcrLatestArtifact, dockerLatestArtifact] = await Promise.all([
      inspectReference({ regctlPath, reference: ghcrCandidate, run: registryRun }),
      inspectReference({ regctlPath, reference: ghcrLatest, run: registryRun }),
      inspectReference({ regctlPath, reference: dockerLatest, run: registryRun }),
    ]);
    requireSafeInspection(ghcrCandidateArtifact, ghcrCandidate);
    requireSafeInspection(ghcrLatestArtifact, ghcrLatest);
    requireSafeInspection(dockerLatestArtifact, dockerLatest);
    if (!compareArtifacts(ghcrCandidateArtifact, result.desiredArtifact)
      || !compareArtifacts(ghcrLatestArtifact, result.desiredArtifact)) {
      throw new Error('GHCR latest does not match the verified candidate artifact');
    }
  }
  if (checkedDockerVersion.kind === 'Valid' && !compareArtifacts(checkedDockerVersion, checkedGhcrVersion)) {
    throw new Error('GHCR and Docker version artifacts diverge');
  }
  if (checkedDockerVersion.kind === 'Missing') {
    await createImmutableArtifact({
      regctlPath,
      source: checkedGhcrVersion.sourceRef,
      destination: dockerVersion,
      expected: checkedGhcrVersion,
      run: registryRun,
    });
  }
  if (result.latest === 'published' && !compareArtifacts(dockerLatestArtifact, ghcrCandidateArtifact)) {
    await copyAndVerifyArtifact({
      regctlPath,
      source: ghcrCandidateArtifact.sourceRef,
      destination: dockerLatest,
      expected: ghcrCandidateArtifact,
      run: registryRun,
    });
  }
  return result;
}

function serializablePublishResult(result) {
  const output = {
    latest: result.latest,
    desiredArtifact: result.desiredArtifact,
    desiredSource: result.desiredSource,
    versionArtifact: result.versionArtifact,
    versionSource: result.versionSource,
  };
  if (result.freshnessError !== undefined) output.freshnessError = result.freshnessError;
  return output;
}

export async function publishGhcrFromOptions(input, args, {
  publish = publishGhcrInput,
  run = runCommand,
} = {}) {
  const options = parsePublishGhcrOptions(args);
  const result = await publish(input, {
    regctlPath: options['--regctl'], staging: options['--staging'], ghcrCandidate: options['--ghcr-candidate'], ghcrVersion: options['--ghcr-version'], ghcrLatest: options['--ghcr-latest'], freshInputPath: options['--fresh-input'],
    refreshInput: options['--fresh-command']
      ? () => refreshInputFromCommand({ freshCommand: options['--fresh-command'], freshArgs: options['--fresh-args'], run })
      : undefined,
  });
  if (options['--result-out']) {
    await writeFile(resolve(options['--result-out']), `${JSON.stringify(serializablePublishResult(result))}\n`);
  }
  return result;
}

export async function mirrorDockerFromOptions(input, args, {
  mirror = mirrorDockerInput,
} = {}) {
  const options = parseMirrorDockerOptions(args);
  const result = requirePublishResult(JSON.parse(await readFile(resolve(options['--result-in']), 'utf8')));
  const mirrored = await mirror(input, {
    regctlPath: options['--regctl'], ghcrCandidate: options['--ghcr-candidate'], ghcrVersion: options['--ghcr-version'], ghcrLatest: options['--ghcr-latest'], dockerVersion: options['--docker-version'], dockerLatest: options['--docker-latest'], result,
  });
  await writeFile(resolve(options['--result-out']), `${JSON.stringify(serializablePublishResult(mirrored))}\n`);
  return mirrored;
}

async function main() {
  const [subcommand, inputPath, ...args] = process.argv.slice(2);
  if (!['validate', 'publish-ghcr', 'mirror-docker'].includes(subcommand) || !inputPath) {
    throw new Error('Usage: publish.mjs validate|publish-ghcr|mirror-docker INPUT_JSON [OPTIONS]');
  }
  const input = await readInput(inputPath);
  if (subcommand === 'validate') await validate(input, { run: runCommand });
  if (subcommand === 'publish-ghcr') await publishGhcrFromOptions(input, args);
  if (subcommand === 'mirror-docker') await mirrorDockerFromOptions(input, args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
