import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  buildDockerCommand,
  buildxStagingCommand,
  parsePublishOptions,
  publishFromOptions,
  publishInput,
  readInput,
  validateSealedContext,
} from './publish.mjs';
import { createRecipe } from './lib/recipe.mjs';

const hex = (character, length) => character.repeat(length);
const recipe = {
  schemaVersion: 'v1',
  upstreamTag: 'v2.10.1',
  upstreamCommit: hex('a', 40),
  packagingSourceSha: hex('b', 40),
  nodeIndexDigest: `sha256:${hex('c', 64)}`,
  rustIndexDigest: `sha256:${hex('d', 64)}`,
  packagingInputsDigest: `sha256:${hex('e', 64)}`,
  monolithVersion: '2.10.1',
};
const input = {
  recipe: createRecipe(recipe),
  nodeImage: `docker.io/library/node@${recipe.nodeIndexDigest}`,
  rustImage: `docker.io/library/rust@${recipe.rustIndexDigest}`,
  postgresImage: `docker.io/library/postgres@sha256:${hex('f', 64)}`,
  meiliImage: `docker.io/getmeili/meilisearch@sha256:${hex('f', 64)}`,
  packagingUrl: 'https://github.com/example/linkwarden-docker.git',
  upstreamSha: recipe.upstreamCommit,
  upstreamUrl: 'https://github.com/example/linkwarden.git',
  validationFingerprint: 'sha256:489292e5b5c50914bd2b545a0acdeda70fbce102eb8908fbe195367024eafadb',
};

function validArtifact(sourceRef) {
  const resolvedRecipe = createRecipe(recipe);
  const labels = {
    'io.linkwarden-slim.recipe-id': resolvedRecipe.recipeId,
    'org.opencontainers.image.version': recipe.upstreamTag,
    'org.opencontainers.image.revision': recipe.packagingInputsDigest,
    'io.linkwarden-slim.upstream-revision': recipe.upstreamCommit,
    'io.linkwarden-slim.packaging-source-revision': recipe.packagingSourceSha,
    'io.linkwarden-slim.node-base': recipe.nodeIndexDigest,
    'io.linkwarden-slim.rust-base': recipe.rustIndexDigest,
    'io.linkwarden-slim.monolith-version': recipe.monolithVersion,
  };
  return {
    kind: 'Valid',
    recipeId: labels['io.linkwarden-slim.recipe-id'],
    sourceRef,
    platformDigests: {
      'linux/amd64': `sha256:${hex('1', 64)}`,
      'linux/arm64': `sha256:${hex('2', 64)}`,
    },
    validatedLabels: labels,
  };
}

test('build commands use the complete recipe argument set', () => {
  const command = buildDockerCommand({ input, context: '/tmp/context', packagingExport: '/tmp/packaging', target: 'main-app', tag: 'local/app:main' });

  assert.deepEqual(command.slice(0, 5), ['docker', 'build', '--platform', 'linux/amd64', '--load']);
  assert.equal(command.includes('--target'), true);
  assert.equal(command.includes('main-app'), true);
  assert.equal(command.includes('--file'), true);
  assert.equal(command.includes('/tmp/packaging/Dockerfile'), true);
  assert.equal(command.includes(`NODE_IMAGE=${input.nodeImage}`), true);
  assert.equal(command.includes(`RUST_BASE_DIGEST=${recipe.rustIndexDigest}`), true);
  assert.equal(command.at(-1), '/tmp/context');
});

test('staging build is multi-platform and disables generated artifacts', () => {
  const command = buildxStagingCommand({ input, context: '/tmp/context', packagingExport: '/tmp/packaging', staging: 'ghcr.io/example/app:staging', metadataFile: '/tmp/metadata.json' });

  assert.deepEqual(command.slice(0, 6), ['docker', 'buildx', 'build', '--platform', 'linux/amd64,linux/arm64', '--push']);
  assert.equal(command.includes('--provenance=false'), true);
  assert.equal(command.includes('--sbom=false'), true);
  assert.equal(command.includes('--metadata-file'), true);
  assert.equal(command.includes('/tmp/metadata.json'), true);
  assert.equal(command.includes('--tag'), true);
  assert.equal(command.includes('ghcr.io/example/app:staging'), true);
});

test('build commands require an explicit packaging export', () => {
  const legacyInput = { ...input, packagingExport: '/tmp/legacy-packaging' };

  assert.throws(
    () => buildDockerCommand({ input: legacyInput, context: '/tmp/context', target: 'main-app', tag: 'local/app:main' }),
    /path|packaging/i,
  );
  assert.throws(
    () => buildxStagingCommand({ input: legacyInput, context: '/tmp/context', staging: 'ghcr.io/example/app:staging', metadataFile: '/tmp/metadata.json' }),
    /path|packaging/i,
  );
});

test('CLI rejects the removed verify-dockerfile command', async () => {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [new URL('./publish.mjs', import.meta.url).pathname, 'verify-dockerfile', 'input.json'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolveResult({ code, stderr }));
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Usage: publish\.mjs validate\|publish/);
  assert.doesNotMatch(result.stderr, /verify-dockerfile/);
});

test('validation builds source and runtime targets from an explicit sealed context', async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { exitCode: 0, signal: null };
  };

  const result = await validateSealedContext(input, {
    context: '/tmp/sealed-context',
    packagingExport: '/tmp/sealed-packaging',
  }, { run });

  assert.equal(result, undefined);

  const dockerCalls = calls.filter((call) => call.command === 'docker');
  assert.equal(dockerCalls.length, 2);
  assert.equal(dockerCalls.every((call) => call.args.includes(`NODE_IMAGE=${input.nodeImage}`)), true);
  assert.equal(dockerCalls.every((call) => call.args.includes('--file')), true);
  assert.equal(dockerCalls.every((call) => call.args.includes('/tmp/sealed-packaging/Dockerfile')), true);
  assert.equal(dockerCalls.every((call) => call.args.at(-1) === '/tmp/sealed-context'), true);
  const bashCalls = calls.filter((call) => call.command === 'bash');
  assert.deepEqual(bashCalls.map((call) => call.args[0]), [
    'ci/materialize-image.sh',
    'ci/materialize-image.sh',
    'ci/test-stack.sh',
    'ci/test-stack.sh',
  ]);
  assert.deepEqual(bashCalls[0].args.slice(1), ['linux/amd64', input.postgresImage, 'linkwarden-ci-postgres:latest']);
  assert.deepEqual(bashCalls[1].args.slice(1), ['linux/amd64', input.meiliImage, 'linkwarden-ci-meili:latest']);
});

test('readInput rejects invalid persisted input fields', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'linkwarden-publish-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'input.json');
  const { validationFingerprint: _validationFingerprint, ...withoutFingerprint } = input;
  await writeFile(path, JSON.stringify(withoutFingerprint));

  await assert.rejects(readInput(path), /validationFingerprint/i);
  await writeFile(path, JSON.stringify({ ...input, validationFingerprint: `sha256:${hex('0', 64)}` }));

  await assert.rejects(readInput(path), /validationFingerprint/i);
  await writeFile(path, JSON.stringify({ ...input, packagingExport: '/tmp/legacy-packaging' }));

  await assert.rejects(readInput(path), /Invalid publish input/);
});

function recipeWithNodeDigest(character) {
  return createRecipe({ ...recipe, nodeIndexDigest: `sha256:${hex(character, 64)}` });
}

function testArtifact(parentCharacter, childCharacters, artifactRecipe = createRecipe(recipe)) {
  const sourceRef = `ghcr.io/example/app@sha256:${hex(parentCharacter, 64)}`;
  const labels = {
    ...validArtifact(sourceRef).validatedLabels,
    'io.linkwarden-slim.recipe-id': artifactRecipe.recipeId,
    'io.linkwarden-slim.node-base': artifactRecipe.nodeIndexDigest,
  };
  return {
    parentDigest: `sha256:${hex(parentCharacter, 64)}`,
    childDigests: {
      'linux/amd64': `sha256:${hex(childCharacters[0], 64)}`,
      'linux/arm64': `sha256:${hex(childCharacters[1], 64)}`,
    },
    labels,
  };
}

function registryFixture({ artifacts, tags = {} }) {
  const byParent = new Map(artifacts.map((current) => [current.parentDigest, current]));
  const byChild = new Map(artifacts.flatMap((current) => Object.entries(current.childDigests).map(([platform, digest]) => [digest, { platform, labels: current.labels }])));
  const currentTags = new Map(Object.entries(tags));
  const calls = [];
  const copies = [];
  const ok = (stdout) => ({ exitCode: 0, signal: null, stdout, stderr: '' });
  const registryRun = async (_command, args) => {
    calls.push(args);
    if (args[0] === 'manifest' && args[1] === 'head') {
      const current = currentTags.get(args[2]);
      return current ? ok(`${current.parentDigest}\n`) : { exitCode: 1, signal: null, stdout: '', stderr: 'MANIFEST_UNKNOWN: manifest unknown' };
    }
    if (args[0] === 'manifest' && args[1] === 'get') {
      const current = byParent.get(args[2].split('@')[1]);
      if (!current) return { exitCode: 1, signal: null, stdout: '', stderr: 'missing source' };
      return ok(JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.index.v1+json',
        manifests: Object.entries(current.childDigests).map(([platform, digest]) => {
          const [os, architecture] = platform.split('/');
          return { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest, platform: { os, architecture } };
        }),
      }));
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const current = byChild.get(args[2].split('@')[1]);
      const [, architecture] = current.platform.split('/');
      return ok(JSON.stringify({ os: 'linux', architecture, config: { Labels: current.labels } }));
    }
    if (args[0] === 'image' && args[1] === 'copy') {
      const source = byParent.get(args[2].split('@')[1]);
      copies.push(args);
      currentTags.set(args[3], source);
      return ok('');
    }
    throw new Error(`Unexpected registry command: ${args.join(' ')}`);
  };
  return { calls, copies, registryRun };
}

function publishOptions(overrides = {}) {
  return {
    regctlPath: 'regctl',
    staging: 'ghcr.io/example/app:run-123',
    ghcrCandidate: 'ghcr.io/example/app:candidate',
    ghcrVersion: 'ghcr.io/example/app:v2.10.1',
    ghcrLatest: 'ghcr.io/example/app:latest',
    dockerCandidate: 'docker.io/example/app:candidate',
    dockerVersion: 'docker.io/example/app:v2.10.1',
    dockerLatest: 'docker.io/example/app:latest',
    freshInput: input,
    workspace: '/tmp',
    digestPackaging: async () => input.recipe.packagingInputsDigest,
    ...overrides,
  };
}

test('promotes only the metadata-derived staging source after a staging tag is retargeted', async () => {
  const staged = testArtifact('3', ['a', 'b']);
  const retargeted = testArtifact('4', ['c', 'd'], recipeWithNodeDigest('f'));
  const registry = registryFixture({ artifacts: [staged, retargeted], tags: { 'ghcr.io/example/app:run-123': retargeted } });
  const commands = [];
  const mutableInput = { ...input };
  const run = async (command, args) => {
    commands.push([command, args]);
    if (command === 'docker' && args[0] === 'build') mutableInput.packagingExport = '/changed-after-validation';
    return { exitCode: 0, signal: null };
  };

  await publishInput(mutableInput, publishOptions({
    registryRun: registry.registryRun,
    run,
    readMetadata: async () => JSON.stringify({ 'containerimage.digest': staged.parentDigest }),
  }));

  const stagedSource = `ghcr.io/example/app@${staged.parentDigest}`;
  assert.equal(registry.calls.some((args) => args[0] === 'manifest' && args[1] === 'head' && args[2] === 'ghcr.io/example/app:run-123'), false);
  assert.equal(registry.copies.every((args) => args[2] === stagedSource), true);
  assert.equal(commands.filter(([command]) => command === 'docker').every(([, args]) => !args.includes('/tmp/packaging/Dockerfile') && !args.includes('/changed-after-validation/Dockerfile')), true);
  assert.equal(commands.filter(([command, args]) => command === 'bash' && args[0] === 'ci/materialize-packaging.sh').length, 1);
  assert.equal(commands.filter(([command, args]) => command === 'bash' && args[0] === 'ci/prepare-context.sh').length, 1);
});

test('mirrors a valid GHCR version artifact to a missing Docker version without replacing it with the desired latest', async () => {
  const canonical = testArtifact('4', ['c', 'd'], recipeWithNodeDigest('f'));
  const desiredCandidate = testArtifact('3', ['a', 'b']);
  const registry = registryFixture({
    artifacts: [canonical, desiredCandidate],
    tags: {
      'ghcr.io/example/app:v2.10.1': canonical,
      'ghcr.io/example/app:candidate': desiredCandidate,
    },
  });
  const run = async () => ({ exitCode: 0, signal: null });

  await publishInput(input, publishOptions({ registryRun: registry.registryRun, run }));

  assert.deepEqual(registry.copies.find((args) => args[3] === 'docker.io/example/app:v2.10.1'), [
    'image', 'copy', `ghcr.io/example/app@${canonical.parentDigest}`, 'docker.io/example/app:v2.10.1',
  ]);
  assert.equal(registry.copies.some((args) => args[3] === 'ghcr.io/example/app:v2.10.1'), false);
  assert.equal(registry.copies.filter((args) => args[3].endsWith(':latest')).every((args) => args[2] === `ghcr.io/example/app@${desiredCandidate.parentDigest}`), true);
});

test('fails before registry writes when GHCR and Docker version artifacts diverge', async () => {
  const ghcrVersion = testArtifact('4', ['c', 'd']);
  const dockerVersion = testArtifact('5', ['e', 'f'], recipeWithNodeDigest('f'));
  const registry = registryFixture({
    artifacts: [ghcrVersion, dockerVersion],
    tags: {
      'ghcr.io/example/app:v2.10.1': ghcrVersion,
      'docker.io/example/app:v2.10.1': dockerVersion,
    },
  });

  await assert.rejects(
    publishInput(input, publishOptions({ registryRun: registry.registryRun, run: async () => ({ exitCode: 0, signal: null }) })),
    /diverge|match/i,
  );
  assert.deepEqual(registry.copies, []);
});

test('keeps matching immutable versions while the desired candidate updates latest', async () => {
  const canonical = testArtifact('4', ['c', 'd'], recipeWithNodeDigest('f'));
  const desired = testArtifact('3', ['a', 'b']);
  const registry = registryFixture({
    artifacts: [canonical, desired],
    tags: {
      'ghcr.io/example/app:v2.10.1': canonical,
      'docker.io/example/app:v2.10.1': canonical,
      'ghcr.io/example/app:candidate': desired,
    },
  });

  await publishInput(input, publishOptions({ registryRun: registry.registryRun, run: async () => ({ exitCode: 0, signal: null }) }));

  assert.equal(registry.copies.some((args) => args[3].endsWith(':v2.10.1')), false);
  assert.equal(registry.copies.filter((args) => args[3].endsWith(':latest')).every((args) => args[2] === `ghcr.io/example/app@${desired.parentDigest}`), true);
});

test('reuses the current full-recipe version artifact before rebuilding a missing candidate', async () => {
  const canonical = testArtifact('4', ['c', 'd']);
  const registry = registryFixture({
    artifacts: [canonical],
    tags: {
      'ghcr.io/example/app:v2.10.1': canonical,
      'docker.io/example/app:v2.10.1': canonical,
    },
  });
  const commands = [];

  await publishInput(input, publishOptions({
    registryRun: registry.registryRun,
    run: async (command, args) => {
      commands.push([command, args]);
      return { exitCode: 0, signal: null };
    },
  }));

  assert.equal(commands.some(([command, args]) => command === 'docker' && args[0] === 'buildx'), false);
  assert.deepEqual(registry.copies.map((args) => args[3]), [
    'ghcr.io/example/app:candidate',
    'docker.io/example/app:candidate',
    'ghcr.io/example/app:latest',
    'docker.io/example/app:latest',
  ]);
});

test('does not recopy an already matching candidate when reusing the current full-recipe version', async () => {
  const canonical = testArtifact('4', ['c', 'd']);
  const registry = registryFixture({
    artifacts: [canonical],
    tags: {
      'ghcr.io/example/app:candidate': canonical,
      'ghcr.io/example/app:v2.10.1': canonical,
      'docker.io/example/app:v2.10.1': canonical,
    },
  });

  await publishInput(input, publishOptions({
    registryRun: registry.registryRun,
    run: async () => ({ exitCode: 0, signal: null }),
  }));

  assert.equal(registry.copies.some((args) => args[3] === 'ghcr.io/example/app:candidate'), false);
});

test('publishes a requested historical version when fresh inputs supersede latest', async () => {
  const desired = testArtifact('3', ['a', 'b']);
  const registry = registryFixture({
    artifacts: [desired],
    tags: { 'ghcr.io/example/app:candidate': desired },
  });
  const freshRecipe = recipeWithNodeDigest('f');
  const freshInput = {
    ...input,
    recipe: freshRecipe,
    nodeImage: `docker.io/library/node@${freshRecipe.nodeIndexDigest}`,
  };

  const result = await publishInput(input, publishOptions({
    freshInput,
    registryRun: registry.registryRun,
    run: async () => ({ exitCode: 0, signal: null }),
  }));

  assert.equal(result.latest, 'skipped-stale');
  assert.equal(result.artifact.sourceRef, `ghcr.io/example/app@${desired.parentDigest}`);
  assert.equal(result.versionArtifact.sourceRef, `ghcr.io/example/app@${desired.parentDigest}`);
  assert.deepEqual(registry.copies.map((args) => args[3]), [
    'docker.io/example/app:candidate',
    'ghcr.io/example/app:v2.10.1',
    'docker.io/example/app:v2.10.1',
  ]);
});

test('keeps immutable versions and skips latest when only the fresh Postgres child changes', async () => {
  const desired = testArtifact('3', ['a', 'b']);
  const registry = registryFixture({
    artifacts: [desired],
    tags: { 'ghcr.io/example/app:candidate': desired },
  });
  const freshInput = {
    ...input,
    postgresImage: `docker.io/library/postgres@sha256:${hex('a', 64)}`,
    validationFingerprint: 'sha256:c5f826b2f39143909f286203d5fd42a1d786e54a822c0b57f42d9562f99a1eab',
  };

  const result = await publishInput(input, publishOptions({
    freshInput,
    registryRun: registry.registryRun,
    run: async () => ({ exitCode: 0, signal: null }),
  }));

  assert.equal(result.latest, 'skipped-stale');
  assert.deepEqual(registry.copies.map((args) => args[3]), [
    'docker.io/example/app:candidate',
    'ghcr.io/example/app:v2.10.1',
    'docker.io/example/app:v2.10.1',
  ]);
});

test('keeps immutable versions and skips latest when only the fresh Meilisearch child changes', async () => {
  const desired = testArtifact('3', ['a', 'b']);
  const registry = registryFixture({
    artifacts: [desired],
    tags: { 'ghcr.io/example/app:candidate': desired },
  });
  const freshInput = {
    ...input,
    meiliImage: `docker.io/getmeili/meilisearch@sha256:${hex('b', 64)}`,
    validationFingerprint: 'sha256:de61531f164fc9d39c7f4b606286f1268ff8b64571481f4d63bc8786d7074513',
  };

  const result = await publishInput(input, publishOptions({
    freshInput,
    registryRun: registry.registryRun,
    run: async () => ({ exitCode: 0, signal: null }),
  }));

  assert.equal(result.latest, 'skipped-stale');
  assert.deepEqual(registry.copies.map((args) => args[3]), [
    'docker.io/example/app:candidate',
    'ghcr.io/example/app:v2.10.1',
    'docker.io/example/app:v2.10.1',
  ]);
});

test('refreshes inputs after candidate and version promotion before updating latest', async () => {
  const desired = testArtifact('3', ['a', 'b']);
  const registry = registryFixture({ artifacts: [desired] });
  const order = [];

  const result = await publishInput(input, publishOptions({
    freshInput: undefined,
    refreshInput: async () => {
      order.push('refresh');
      return { ...input };
    },
    registryRun: async (command, args) => {
      if (args[0] === 'image' && args[1] === 'copy') order.push(`copy:${args[3]}`);
      return registry.registryRun(command, args);
    },
    run: async (command, args) => {
      if (command === 'docker' && args[0] === 'buildx') order.push('staging');
      return { exitCode: 0, signal: null };
    },
    readMetadata: async () => JSON.stringify({ 'containerimage.digest': desired.parentDigest }),
  }));

  assert.equal(result.latest, 'published');
  assert.deepEqual(order, [
    'staging',
    'copy:ghcr.io/example/app:candidate',
    'copy:docker.io/example/app:candidate',
    'copy:ghcr.io/example/app:v2.10.1',
    'copy:docker.io/example/app:v2.10.1',
    'refresh',
    'copy:ghcr.io/example/app:latest',
    'copy:docker.io/example/app:latest',
  ]);
});

test('keeps version promotion and skips latest when refreshed input is malformed', async () => {
  const desired = testArtifact('3', ['a', 'b']);
  const registry = registryFixture({ artifacts: [desired] });

  const result = await publishInput(input, publishOptions({
    freshInput: undefined,
    refreshInput: async () => ({ recipe: {} }),
    registryRun: registry.registryRun,
    run: async () => ({ exitCode: 0, signal: null }),
    readMetadata: async () => JSON.stringify({ 'containerimage.digest': desired.parentDigest }),
  }));

  assert.equal(result.latest, 'skipped-freshness-error');
  assert.match(result.freshnessError, /invalid schemaVersion/i);
  assert.deepEqual(registry.copies.map((args) => args[3]), [
    'ghcr.io/example/app:candidate',
    'docker.io/example/app:candidate',
    'ghcr.io/example/app:v2.10.1',
    'docker.io/example/app:v2.10.1',
  ]);
});

test('records a failed freshness refresh after version promotion', async () => {
  const desired = testArtifact('3', ['a', 'b']);
  const registry = registryFixture({ artifacts: [desired] });

  const result = await publishInput(input, publishOptions({
    freshInput: undefined,
    refreshInput: async () => { throw new Error('fresh resolver failed'); },
    registryRun: registry.registryRun,
    run: async () => ({ exitCode: 0, signal: null }),
    readMetadata: async () => JSON.stringify({ 'containerimage.digest': desired.parentDigest }),
  }));

  assert.equal(result.latest, 'skipped-freshness-error');
  assert.equal(result.freshnessError, 'fresh resolver failed');
  assert.deepEqual(registry.copies.map((args) => args[3]), [
    'ghcr.io/example/app:candidate',
    'docker.io/example/app:candidate',
    'ghcr.io/example/app:v2.10.1',
    'docker.io/example/app:v2.10.1',
  ]);
});

test('parses fresh command publishing options and rejects competing fresh input modes', () => {
  const required = [
    '--regctl', 'regctl',
    '--staging', 'ghcr.io/example/app:staging',
    '--ghcr-candidate', 'ghcr.io/example/app:candidate',
    '--ghcr-version', 'ghcr.io/example/app:v2.10.1',
    '--ghcr-latest', 'ghcr.io/example/app:latest',
    '--docker-candidate', 'docker.io/example/app:candidate',
    '--docker-version', 'docker.io/example/app:v2.10.1',
    '--docker-latest', 'docker.io/example/app:latest',
  ];

  assert.deepEqual(parsePublishOptions([...required, '--fresh-command', 'ci/resolve-publish-input.sh', '--fresh-args', '["--latest-upstream"]', '--result-out', 'publish-result.json']), {
    '--regctl': 'regctl',
    '--staging': 'ghcr.io/example/app:staging',
    '--ghcr-candidate': 'ghcr.io/example/app:candidate',
    '--ghcr-version': 'ghcr.io/example/app:v2.10.1',
    '--ghcr-latest': 'ghcr.io/example/app:latest',
    '--docker-candidate': 'docker.io/example/app:candidate',
    '--docker-version': 'docker.io/example/app:v2.10.1',
    '--docker-latest': 'docker.io/example/app:latest',
    '--fresh-command': 'ci/resolve-publish-input.sh',
    '--fresh-args': ['--latest-upstream'],
    '--result-out': 'publish-result.json',
  });
  assert.throws(
    () => parsePublishOptions([...required, '--fresh-input', 'fresh.json', '--result-out', '--fresh-command']),
    /invalid value for --result-out/i,
  );
  assert.throws(
    () => parsePublishOptions([...required, '--fresh-input', 'fresh.json', '--result-out', '   ']),
    /invalid value for --result-out/i,
  );
  assert.throws(
    () => parsePublishOptions([...required, '--fresh-input', 'fresh.json', '--fresh-command', 'ci/resolve-inputs.sh']),
    /exactly one.*fresh-input.*fresh-command/i,
  );
  assert.throws(
    () => parsePublishOptions([...required, '--fresh-command', 'ci/resolve-publish-input.sh']),
    /--fresh-args/i,
  );
  assert.throws(
    () => parsePublishOptions([...required, '--fresh-command', 'ci/resolve-publish-input.sh', '--fresh-args', '{}']),
    /--fresh-args/i,
  );
});

test('runs the configured fresh command with its output path and configured arguments', async () => {
  const required = [
    '--regctl', 'regctl',
    '--staging', 'ghcr.io/example/app:staging',
    '--ghcr-candidate', 'ghcr.io/example/app:candidate',
    '--ghcr-version', 'ghcr.io/example/app:v2.10.1',
    '--ghcr-latest', 'ghcr.io/example/app:latest',
    '--docker-candidate', 'docker.io/example/app:candidate',
    '--docker-version', 'docker.io/example/app:v2.10.1',
    '--docker-latest', 'docker.io/example/app:latest',
  ];
  let publishOptions;

  await publishFromOptions(input, [
    ...required,
    '--fresh-command', 'ci/resolve-publish-input.sh',
    '--fresh-args', '["--latest-upstream","--packaging-main"]',
  ], {
    run: async (command, args) => {
      assert.equal(command, 'bash');
      assert.deepEqual(args.slice(0, 2), ['ci/resolve-publish-input.sh', '--out']);
      assert.match(args[2], /linkwarden-fresh-.*\/input\.json$/);
      assert.deepEqual(args.slice(3), ['--latest-upstream', '--packaging-main']);
      await writeFile(args[2], JSON.stringify(input));
      return { exitCode: 0, signal: null };
    },
    publish: async (_publishInput, options) => {
      publishOptions = options;
      await options.refreshInput();
      return { latest: 'published' };
    },
  });

  assert.equal(publishOptions.freshInputPath, undefined);
});

test('writes the publish result to the requested output file', async () => {
  const resultDirectory = await mkdtemp(join(tmpdir(), 'linkwarden-publish-result-'));
  const resultPath = join(resultDirectory, 'result.json');
  const required = [
    '--regctl', 'regctl',
    '--staging', 'ghcr.io/example/app:staging',
    '--ghcr-candidate', 'ghcr.io/example/app:candidate',
    '--ghcr-version', 'ghcr.io/example/app:v2.10.1',
    '--ghcr-latest', 'ghcr.io/example/app:latest',
    '--docker-candidate', 'docker.io/example/app:candidate',
    '--docker-version', 'docker.io/example/app:v2.10.1',
    '--docker-latest', 'docker.io/example/app:latest',
  ];
  const expected = {
    latest: 'skipped-freshness-error',
    freshnessError: 'freshness resolver unavailable',
    artifact: { sourceRef: 'ghcr.io/example/app@sha256:artifact' },
    versionArtifact: { sourceRef: 'ghcr.io/example/app@sha256:version' },
    unexpected: 'must not be written',
  };
  try {
    await publishFromOptions(input, [...required, '--fresh-input', 'fresh.json', '--result-out', resultPath], {
      publish: async (_publishInput, options) => {
        assert.equal(options.freshInputPath, 'fresh.json');
        return expected;
      },
    });

    assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), {
      latest: expected.latest,
      freshnessError: expected.freshnessError,
      artifact: expected.artifact,
      versionArtifact: expected.versionArtifact,
    });
  } finally {
    await rm(resultDirectory, { recursive: true, force: true });
  }
});

test('rejects a reused candidate that matches only the recipe id but not its complete recipe labels', async () => {
  const candidate = testArtifact('3', ['a', 'b']);
  candidate.labels['io.linkwarden-slim.node-base'] = `sha256:${hex('f', 64)}`;
  const registry = registryFixture({ artifacts: [candidate], tags: { 'ghcr.io/example/app:candidate': candidate } });
  const commands = [];

  await assert.rejects(
    publishInput(input, publishOptions({
      registryRun: registry.registryRun,
      run: async (command, args) => {
        commands.push([command, args]);
        return { exitCode: 0, signal: null };
      },
      readMetadata: async () => JSON.stringify({ 'containerimage.digest': candidate.parentDigest }),
    })),
    /recipe id|resolved recipe/i,
  );
  assert.equal(commands.some(([command]) => command === 'docker'), false);
  assert.deepEqual(registry.copies, []);
});
