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

export function buildDockerCommand({ input, context, target, tag, packagingExport = input.packagingExport }) {
  const args = buildArgPairs(buildArgsForRecipe({ recipe: input.recipe, nodeImage: input.nodeImage, rustImage: input.rustImage }));
  return ['docker', 'build', '--platform', 'linux/amd64', '--load', '--file', join(packagingExport, 'Dockerfile'), '--target', target, '--tag', tag, ...args, context];
}

export function buildxStagingCommand({ input, context, staging, metadataFile, packagingExport = input.packagingExport }) {
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

export async function validateInput(input, {
  run = runCommand,
  workspace,
  context,
  packagingExport,
  digestPackaging,
} = {}) {
  const sealed = context && packagingExport ? undefined : await sealContext(input, { run, workspace, digestPackaging });
  const sealedContext = context ?? sealed.context;
  const sealedPackagingExport = packagingExport ?? sealed.packagingExport;
  try {
    await materializeDependencies(input, run);
    const sourceBuild = buildDockerCommand({ input, context: sealedContext, packagingExport: sealedPackagingExport, target: 'source-test', tag: 'linkwarden-ci-source-test:latest' });
    await mustRun(sourceBuild[0], sourceBuild.slice(1), {}, run);
    await mustRun('bash', ['ci/test-stack.sh', 'source'], {
      env: { ...process.env, CI_POSTGRES_IMAGE: 'linkwarden-ci-postgres:latest', CI_MEILI_IMAGE: 'linkwarden-ci-meili:latest', CI_SOURCE_TEST_IMAGE: 'linkwarden-ci-source-test:latest' },
    }, run);
    const appBuild = buildDockerCommand({ input, context: sealedContext, packagingExport: sealedPackagingExport, target: 'main-app', tag: 'linkwarden-ci-app:latest' });
    await mustRun(appBuild[0], appBuild.slice(1), {}, run);
    await mustRun('bash', ['ci/test-stack.sh', 'runtime'], {
      env: { ...process.env, CI_POSTGRES_IMAGE: 'linkwarden-ci-postgres:latest', CI_MEILI_IMAGE: 'linkwarden-ci-meili:latest', CI_IMAGE_REF: 'linkwarden-ci-app:latest', CI_PLATFORM: 'linux/amd64' },
    }, run);
    return sealedContext;
  } finally {
    if (sealed) await rm(sealed.root, { recursive: true, force: true });
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

function selectCanonicalVersion({ ghcrVersion, dockerVersion, recipe }) {
  requireSafeInspection(ghcrVersion, 'GHCR version');
  requireSafeInspection(dockerVersion, 'Docker version');
  if (ghcrVersion.kind === 'Valid' && dockerVersion.kind === 'Valid') {
    if (!compareArtifacts(ghcrVersion, dockerVersion)) throw new Error('GHCR and Docker version artifacts diverge');
    if (!artifactMatchesUpstream(ghcrVersion, recipe)) throw new Error('Existing version artifact has a different upstream identity');
    return { artifact: ghcrVersion, missing: [] };
  }
  if (ghcrVersion.kind === 'Valid') {
    if (!artifactMatchesUpstream(ghcrVersion, recipe)) throw new Error('Existing GHCR version artifact has a different upstream identity');
    return { artifact: ghcrVersion, missing: ['docker'] };
  }
  if (dockerVersion.kind === 'Valid') {
    if (!artifactMatchesUpstream(dockerVersion, recipe)) throw new Error('Existing Docker version artifact has a different upstream identity');
    return { artifact: dockerVersion, missing: ['ghcr'] };
  }
  return { artifact: undefined, missing: ['ghcr', 'docker'] };
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

async function copyAndVerifyArtifact({ regctlPath, source, destination, expected, run }) {
  await copyReference({ regctlPath, source, destination, run });
  const copied = await inspectReference({ regctlPath, reference: destination, run });
  if (!compareArtifacts(expected, copied)) {
    throw new Error(`${destination} does not match the canonical artifact`);
  }
}

async function requireCandidate({ regctlPath, reference, expected, run }) {
  const candidate = await inspectReference({ regctlPath, reference, run });
  if (!compareArtifacts(expected, candidate)) {
    throw new Error(`${reference} does not match the verified artifact`);
  }
  return candidate;
}

async function refreshInputFromCommand({ freshCommand, run, workspace }) {
  const root = await mkdtemp(join(workspace ?? tmpdir(), 'linkwarden-fresh-'));
  const outputPath = join(root, 'input.json');
  try {
    await mustRun('bash', [freshCommand, outputPath], {}, run);
    return await readInput(outputPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function freshnessErrorResult(artifact, versionArtifact, cause) {
  return {
    artifact,
    versionArtifact,
    latest: 'skipped-freshness-error',
    freshnessError: cause instanceof Error ? cause.message : String(cause),
  };
}

export async function publishInput(input, {
  regctlPath,
  staging,
  ghcrCandidate,
  ghcrVersion,
  ghcrLatest,
  dockerCandidate,
  dockerVersion,
  dockerLatest,
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
  for (const reference of [staging, ghcrCandidate, ghcrVersion, ghcrLatest, dockerCandidate, dockerVersion, dockerLatest]) parseDestinationReference(reference);
  const [initialGhcrCandidate, initialDockerCandidate, ghcrVersionArtifact, dockerVersionArtifact] = await Promise.all([
    inspectReference({ regctlPath, reference: ghcrCandidate, run: registryRun }),
    inspectReference({ regctlPath, reference: dockerCandidate, run: registryRun }),
    inspectReference({ regctlPath, reference: ghcrVersion, run: registryRun }),
    inspectReference({ regctlPath, reference: dockerVersion, run: registryRun }),
  ]);
  for (const [artifact, reference] of [
    [initialGhcrCandidate, ghcrCandidate], [initialDockerCandidate, dockerCandidate],
    [ghcrVersionArtifact, ghcrVersion], [dockerVersionArtifact, dockerVersion],
  ]) requireSafeInspection(artifact, reference);
  const canonicalVersion = selectCanonicalVersion({
    ghcrVersion: ghcrVersionArtifact,
    dockerVersion: dockerVersionArtifact,
    recipe,
  });

  let desiredArtifact;
  let promotionSource;
  if (artifactMatchesRecipe(initialGhcrCandidate, recipe)) {
    desiredArtifact = initialGhcrCandidate;
    promotionSource = initialGhcrCandidate.sourceRef;
    await testArtifactRuntime(desiredArtifact, input, run);
  } else {
    const sealed = await sealContext(input, { run, workspace, digestPackaging });
    try {
      await validateInput(input, { run, context: sealed.context, packagingExport: sealed.packagingExport });
      const metadataFile = join(sealed.root, 'metadata.json');
      const stagingBuild = buildxStagingCommand({ input, context: sealed.context, packagingExport: sealed.packagingExport, staging, metadataFile });
      await mustRun(stagingBuild[0], stagingBuild.slice(1), {}, run);
      promotionSource = stagingSourceFromMetadata(staging, await readMetadata(metadataFile));
      desiredArtifact = await inspectSourceReference({ regctlPath, sourceRef: promotionSource, run: registryRun });
      if (!artifactMatchesRecipe(desiredArtifact, recipe)) throw new Error(desiredArtifact.message ?? 'Staging artifact does not match the resolved recipe');
      await testArtifactRuntime(desiredArtifact, input, run);
      await copyReference({ regctlPath, source: promotionSource, destination: ghcrCandidate, run: registryRun });
    } finally {
      await rm(sealed.root, { recursive: true, force: true });
    }
  }
  await requireCandidate({ regctlPath, reference: ghcrCandidate, expected: desiredArtifact, run: registryRun });
  await copyReference({ regctlPath, source: promotionSource, destination: dockerCandidate, run: registryRun });
  await requireCandidate({ regctlPath, reference: dockerCandidate, expected: desiredArtifact, run: registryRun });
  const canonicalSource = canonicalVersion.artifact?.sourceRef ?? promotionSource;
  const canonicalArtifact = canonicalVersion.artifact ?? desiredArtifact;
  if (canonicalVersion.missing.includes('ghcr')) {
    await copyAndVerifyArtifact({ regctlPath, source: canonicalSource, destination: ghcrVersion, expected: canonicalArtifact, run: registryRun });
  }
  if (canonicalVersion.missing.includes('docker')) {
    await copyAndVerifyArtifact({ regctlPath, source: canonicalSource, destination: dockerVersion, expected: canonicalArtifact, run: registryRun });
  }
  let refreshed;
  try {
    refreshed = refreshInput
      ? await refreshInput()
      : freshInput ?? (freshInputPath ? await readInput(freshInputPath) : undefined);
    validateInputShape(refreshed);
  } catch (cause) {
    return freshnessErrorResult(desiredArtifact, canonicalArtifact, cause);
  }
  if (refreshed.recipe.recipeId !== recipe.recipeId
    || refreshed.validationFingerprint !== input.validationFingerprint) {
    return { artifact: desiredArtifact, versionArtifact: canonicalArtifact, latest: 'skipped-stale' };
  }
  const [ghcrLatestArtifact, dockerLatestArtifact] = await Promise.all([
    inspectReference({ regctlPath, reference: ghcrLatest, run: registryRun }),
    inspectReference({ regctlPath, reference: dockerLatest, run: registryRun }),
  ]);
  requireSafeInspection(ghcrLatestArtifact, ghcrLatest);
  requireSafeInspection(dockerLatestArtifact, dockerLatest);
  if (!compareArtifacts(ghcrLatestArtifact, desiredArtifact)) await copyReference({ regctlPath, source: promotionSource, destination: ghcrLatest, run: registryRun });
  if (!compareArtifacts(dockerLatestArtifact, desiredArtifact)) await copyReference({ regctlPath, source: promotionSource, destination: dockerLatest, run: registryRun });
  return { artifact: desiredArtifact, versionArtifact: canonicalArtifact, latest: 'published' };
}

export function parsePublishOptions(args) {
  if (args.length % 2 !== 0) throw new Error('Publish options require values');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith('--') || options[args[index]] !== undefined) throw new Error('Invalid publish options');
    options[args[index]] = args[index + 1];
  }
  for (const flag of ['--regctl', '--staging', '--ghcr-candidate', '--ghcr-version', '--ghcr-latest', '--docker-candidate', '--docker-version', '--docker-latest']) {
    if (!options[flag]) throw new Error(`Missing ${flag}`);
  }
  if (Boolean(options['--fresh-input']) === Boolean(options['--fresh-command'])) {
    throw new Error('Specify exactly one of --fresh-input or --fresh-command');
  }
  if (options['--result-out'] !== undefined && (!options['--result-out'].trim() || options['--result-out'].startsWith('--'))) {
    throw new Error('Invalid value for --result-out');
  }
  return options;
}

export async function publishFromOptions(input, args, {
  publish = publishInput,
  run = runCommand,
} = {}) {
  const options = parsePublishOptions(args);
  const result = await publish(input, {
    regctlPath: options['--regctl'], staging: options['--staging'], ghcrCandidate: options['--ghcr-candidate'], ghcrVersion: options['--ghcr-version'], ghcrLatest: options['--ghcr-latest'], dockerCandidate: options['--docker-candidate'], dockerVersion: options['--docker-version'], dockerLatest: options['--docker-latest'], freshInputPath: options['--fresh-input'],
    refreshInput: options['--fresh-command']
      ? () => refreshInputFromCommand({ freshCommand: options['--fresh-command'], run })
      : undefined,
  });
  if (options['--result-out']) {
    const output = { latest: result.latest };
    if (result.freshnessError !== undefined) output.freshnessError = result.freshnessError;
    if (result.artifact !== undefined) output.artifact = result.artifact;
    if (result.versionArtifact !== undefined) output.versionArtifact = result.versionArtifact;
    await writeFile(resolve(options['--result-out']), `${JSON.stringify(output)}\n`);
  }
  return result;
}

async function main() {
  const [subcommand, inputPath, ...args] = process.argv.slice(2);
  if (!['validate', 'verify-dockerfile', 'publish'].includes(subcommand) || !inputPath) {
    throw new Error('Usage: publish.mjs validate|verify-dockerfile|publish INPUT_JSON [--regctl PATH --staging REF --ghcr-candidate REF --ghcr-version REF --ghcr-latest REF --docker-candidate REF --docker-version REF --docker-latest REF (--fresh-input INPUT_JSON | --fresh-command PATH) [--result-out FILE]]');
  }
  const input = await readInput(inputPath);
  if (subcommand === 'validate') await validateInput(input, { run: runCommand });
  if (subcommand === 'verify-dockerfile') {
    const sealed = await sealContext(input, { run: runCommand });
    try {
      const sourceDepsBuild = buildDockerCommand({ input, context: sealed.context, packagingExport: sealed.packagingExport, target: 'source-deps', tag: 'linkwarden-ci-source-deps:latest' });
      await mustRun(sourceDepsBuild[0], sourceDepsBuild.slice(1), {}, runCommand);
    } finally { await rm(sealed.root, { recursive: true, force: true }); }
  }
  if (subcommand === 'publish') {
    await publishFromOptions(input, args);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
