#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { buildArgPairs, buildArgsForRecipe } from './lib/build-args.mjs';
import { copyReference, inspectReference } from './lib/registry.mjs';
import { planRun } from './lib/planner.mjs';
import { parseDestinationReference, parseSourceReference } from './lib/reference.mjs';
import { createRecipe } from './lib/recipe.mjs';

const SHA = /^[a-f0-9]{40}$/;

export function buildDockerCommand({ input, context, target, tag }) {
  const args = buildArgPairs(buildArgsForRecipe({ recipe: input.recipe, nodeImage: input.nodeImage, rustImage: input.rustImage }));
  return ['docker', 'build', '--platform', 'linux/amd64', '--load', '--file', join(input.packagingExport, 'Dockerfile'), '--target', target, '--tag', tag, ...args, context];
}

export function buildxStagingCommand({ input, context, staging, metadataFile }) {
  const args = buildArgPairs(buildArgsForRecipe({ recipe: input.recipe, nodeImage: input.nodeImage, rustImage: input.rustImage }));
  return ['docker', 'buildx', 'build', '--platform', 'linux/amd64,linux/arm64', '--push', '--file', join(input.packagingExport, 'Dockerfile'), '--provenance=false', '--sbom=false', '--metadata-file', metadataFile, '--tag', staging, ...args, context];
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

async function readInput(path) {
  const input = JSON.parse(await readFile(resolve(path), 'utf8'));
  input.recipe = createRecipe(input.recipe);
  for (const key of ['nodeImage', 'rustImage', 'postgresImage', 'meiliImage']) parseSourceReference(input[key]);
  if (typeof input.packagingExport !== 'string' || !SHA.test(input.upstreamSha ?? '')) throw new TypeError('Invalid publish input');
  return input;
}

async function prepareContext(input, destination, run) {
  await mustRun('bash', ['ci/prepare-context.sh', input.packagingUrl, input.upstreamSha, input.packagingExport, destination], {}, run);
}

async function materializeDependencies(input, run) {
  await mustRun('bash', ['ci/materialize-image.sh', 'linux/amd64', input.postgresImage, 'linkwarden-ci-postgres:latest'], {}, run);
  await mustRun('bash', ['ci/materialize-image.sh', 'linux/amd64', input.meiliImage, 'linkwarden-ci-meili:latest'], {}, run);
}

export async function validateInput(input, { run = runCommand, workspace } = {}) {
  const createdWorkspace = workspace === undefined;
  const root = workspace ?? await mkdtemp(join(tmpdir(), 'linkwarden-publish-'));
  try {
    const context = join(root, 'context');
    await prepareContext(input, context, run);
    await materializeDependencies(input, run);
    const sourceBuild = buildDockerCommand({ input, context, target: 'source-test', tag: 'linkwarden-ci-source-test:latest' });
    await mustRun(sourceBuild[0], sourceBuild.slice(1), {}, run);
    await mustRun('bash', ['ci/test-stack.sh', 'source'], {
      env: { ...process.env, CI_POSTGRES_IMAGE: 'linkwarden-ci-postgres:latest', CI_MEILI_IMAGE: 'linkwarden-ci-meili:latest', CI_SOURCE_TEST_IMAGE: 'linkwarden-ci-source-test:latest' },
    }, run);
    const appBuild = buildDockerCommand({ input, context, target: 'main-app', tag: 'linkwarden-ci-app:latest' });
    await mustRun(appBuild[0], appBuild.slice(1), {}, run);
    await mustRun('bash', ['ci/test-stack.sh', 'runtime'], {
      env: { ...process.env, CI_POSTGRES_IMAGE: 'linkwarden-ci-postgres:latest', CI_MEILI_IMAGE: 'linkwarden-ci-meili:latest', CI_IMAGE_REF: 'linkwarden-ci-app:latest', CI_PLATFORM: 'linux/amd64' },
    }, run);
    return context;
  } finally {
    if (createdWorkspace) await rm(root, { recursive: true, force: true });
  }
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
  run = runCommand,
  registryRun,
  workspace,
} = {}) {
  const recipe = { ...input.recipe };
  delete recipe.recipeId;
  for (const reference of [staging, ghcrCandidate, ghcrVersion, ghcrLatest, dockerCandidate, dockerVersion, dockerLatest]) parseDestinationReference(reference);
  const [versionArtifact, latestArtifact] = await Promise.all([
    inspectReference({ regctlPath, reference: ghcrVersion, run: registryRun }),
    inspectReference({ regctlPath, reference: ghcrLatest, run: registryRun }),
  ]);
  const plan = planRun({ recipe, sourceArtifacts: [versionArtifact, latestArtifact], versionArtifact, latestArtifact, versionTag: ghcrVersion, latestTag: ghcrLatest });
  if (plan.artifact.kind === 'Reuse') {
    await copyReference({ regctlPath, source: plan.artifact.source, destination: ghcrCandidate, run: registryRun });
  } else {
    await validateInput(input, { run, workspace });
    const stageWorkspace = workspace ?? await mkdtemp(join(tmpdir(), 'linkwarden-stage-'));
    try {
      const context = join(stageWorkspace, 'context');
      await prepareContext(input, context, run);
      const metadataFile = join(stageWorkspace, 'metadata.json');
      const stagingBuild = buildxStagingCommand({ input, context, staging, metadataFile });
      await mustRun(stagingBuild[0], stagingBuild.slice(1), {}, run);
      const staged = await inspectReference({ regctlPath, reference: staging, run: registryRun });
      if (staged.kind !== 'Valid') throw new Error(staged.message ?? 'Staging artifact is invalid');
      for (const [platform, digest] of Object.entries(staged.platformDigests)) {
        await mustRun('bash', ['ci/materialize-image.sh', platform, `${staged.sourceRef.split('@')[0]}@${digest}`, `linkwarden-ci-${platform.replace('/', '-')}:latest`], {}, run);
        await mustRun('bash', ['ci/test-stack.sh', 'runtime'], {
          env: { ...process.env, CI_POSTGRES_IMAGE: 'linkwarden-ci-postgres:latest', CI_MEILI_IMAGE: 'linkwarden-ci-meili:latest', CI_IMAGE_REF: `linkwarden-ci-${platform.replace('/', '-')}:latest`, CI_PLATFORM: platform },
        }, run);
      }
      await copyReference({ regctlPath, source: staged.sourceRef, destination: ghcrCandidate, run: registryRun });
    } finally {
      if (!workspace) await rm(stageWorkspace, { recursive: true, force: true });
    }
  }
  const candidate = await inspectReference({ regctlPath, reference: ghcrCandidate, run: registryRun });
  if (candidate.kind !== 'Valid') throw new Error(candidate.message ?? 'GHCR candidate is invalid');
  await copyReference({ regctlPath, source: candidate.sourceRef, destination: dockerCandidate, run: registryRun });
  const dockerArtifact = await inspectReference({ regctlPath, reference: dockerCandidate, run: registryRun });
  if (dockerArtifact.kind !== 'Valid' || dockerArtifact.sourceRef === undefined) {
    throw new Error(dockerArtifact.message ?? 'Docker Hub candidate is invalid');
  }
  const refreshed = freshInput ?? (freshInputPath ? await readInput(freshInputPath) : undefined);
  if (!refreshed || createRecipe(refreshed.recipe).recipeId !== createRecipe(input.recipe).recipeId) {
    throw new Error('Resolved inputs changed before tagging');
  }
  if (plan.version.kind === 'SetTag') await copyReference({ regctlPath, source: candidate.sourceRef, destination: ghcrVersion, run: registryRun });
  if (plan.latest.kind === 'SetTag') await copyReference({ regctlPath, source: candidate.sourceRef, destination: ghcrLatest, run: registryRun });
  const [dockerVersionArtifact, dockerLatestArtifact] = await Promise.all([
    inspectReference({ regctlPath, reference: dockerVersion, run: registryRun }),
    inspectReference({ regctlPath, reference: dockerLatest, run: registryRun }),
  ]);
  const dockerPlan = planRun({
    recipe,
    sourceArtifacts: [dockerArtifact],
    versionArtifact: dockerVersionArtifact,
    latestArtifact: dockerLatestArtifact,
    versionTag: dockerVersion,
    latestTag: dockerLatest,
  });
  if (dockerPlan.version.kind === 'SetTag') {
    await copyReference({ regctlPath, source: dockerArtifact.sourceRef, destination: dockerVersion, run: registryRun });
  }
  if (dockerPlan.latest.kind === 'SetTag') {
    await copyReference({ regctlPath, source: dockerArtifact.sourceRef, destination: dockerLatest, run: registryRun });
  }
  return candidate;
}

async function main() {
  const [subcommand, inputPath, ...args] = process.argv.slice(2);
  if (!['validate', 'verify-dockerfile', 'publish'].includes(subcommand) || !inputPath) {
    throw new Error('Usage: publish.mjs validate|verify-dockerfile|publish INPUT_JSON [--regctl PATH --staging REF --ghcr-candidate REF --ghcr-version REF --ghcr-latest REF --docker-candidate REF --docker-version REF --docker-latest REF --fresh-input INPUT_JSON]');
  }
  const input = await readInput(inputPath);
  if (subcommand === 'validate') await validateInput(input, { run: runCommand });
  if (subcommand === 'verify-dockerfile') {
    const workspace = await mkdtemp(join(tmpdir(), 'linkwarden-verify-'));
    try {
      const context = join(workspace, 'context');
      await prepareContext(input, context, runCommand);
      const sourceDepsBuild = buildDockerCommand({ input, context, target: 'source-deps', tag: 'linkwarden-ci-source-deps:latest' });
      await mustRun(sourceDepsBuild[0], sourceDepsBuild.slice(1), {}, runCommand);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }
  if (subcommand === 'publish') {
    if (args.length % 2 !== 0) throw new Error('Publish options require values');
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!args[index].startsWith('--') || options[args[index]] !== undefined) throw new Error('Invalid publish options');
      options[args[index]] = args[index + 1];
    }
    for (const flag of ['--regctl', '--staging', '--ghcr-candidate', '--ghcr-version', '--ghcr-latest', '--docker-candidate', '--docker-version', '--docker-latest', '--fresh-input']) {
      if (!options[flag]) throw new Error(`Missing ${flag}`);
    }
    await publishInput(input, {
      regctlPath: options['--regctl'], staging: options['--staging'], ghcrCandidate: options['--ghcr-candidate'], ghcrVersion: options['--ghcr-version'], ghcrLatest: options['--ghcr-latest'], dockerCandidate: options['--docker-candidate'], dockerVersion: options['--docker-version'], dockerLatest: options['--docker-latest'], freshInputPath: options['--fresh-input'],
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
