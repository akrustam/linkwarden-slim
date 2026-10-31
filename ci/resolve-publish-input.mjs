#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { COMMIT_SHA, RELEASE_TAG, readBuildLock } from './lib/build-lock.mjs';
import { resolveInputs } from './resolve-inputs.mjs';

const execute = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export function parseOptions(argv) {
  const { values } = parseArgs({ args: argv, options: {
    out: { type: 'string' }, regctl: { type: 'string' },
    'packaging-url': { type: 'string' }, 'packaging-sha': { type: 'string' },
    'upstream-tag': { type: 'string' }, 'print-fresh-args': { type: 'boolean' },
  } });
  if (!values.regctl || !values['packaging-url']) throw new TypeError('--regctl and --packaging-url are required');
  if (values['packaging-sha'] !== undefined && !COMMIT_SHA.test(values['packaging-sha'])) {
    throw new TypeError('Invalid --packaging-sha');
  }
  if (values['upstream-tag'] !== undefined && !RELEASE_TAG.test(values['upstream-tag'])) {
    throw new TypeError('Invalid --upstream-tag');
  }
  if (values['print-fresh-args']) {
    if (values.out !== undefined || values['packaging-sha'] !== undefined || values['upstream-tag'] !== undefined) {
      throw new TypeError('--print-fresh-args only accepts regctl and packaging URL');
    }
  } else if (!values.out) throw new TypeError('--out is required');
  return values;
}

async function gitRef(url, refs) {
  const { stdout } = await execute('git', ['ls-remote', '--', url, ...refs], { timeout: 120_000 });
  const found = new Map(stdout.trim().split('\n').map((line) => {
    const [sha, ref] = line.split('\t');
    return [ref, sha];
  }));
  const sha = refs.map((ref) => found.get(ref)).find(Boolean);
  if (!COMMIT_SHA.test(sha ?? '')) throw new Error(`Unable to resolve ${refs.join(' or ')}`);
  return sha;
}

export async function resolvePublishInput(options) {
  const packagingUrl = options['packaging-url'];
  const packagingSha = options['packaging-sha'] ?? await gitRef(packagingUrl, ['refs/heads/main']);
  const root = await mkdtemp(join(tmpdir(), 'linkwarden-resolve-'));
  const packaging = join(root, 'packaging');
  try {
    await execute('bash', [join(scriptDirectory, 'materialize-packaging.sh'), packagingUrl, packagingSha, packaging], { timeout: 120_000 });
    // Always read all policy inputs from the selected packaging commit. In a
    // freshness check this is current main, never the initial workflow's env.
    const lock = await readBuildLock(packaging);
    const upstreamTag = options['upstream-tag'] ?? lock.upstream.tag;
    const upstreamSha = await gitRef(lock.upstream.url, [`refs/tags/${upstreamTag}^{}`, `refs/tags/${upstreamTag}`]);
    if (upstreamTag === lock.upstream.tag && upstreamSha !== lock.upstream.commit) {
      throw new Error('Upstream tag differs from the reviewed build lock commit');
    }
    const dockerConfig = join(root, 'docker-config');
    await mkdir(dockerConfig);
    return await resolveInputs({
      '--regctl': options.regctl, '--packaging-url': packagingUrl,
      '--packaging-sha': packagingSha, '--packaging-export': join(packaging, 'export'),
      '--upstream-tag': upstreamTag, '--upstream-sha': upstreamSha, '--upstream-url': lock.upstream.url,
      '--node': lock.images.node, '--rust': lock.images.rust,
      '--postgres': lock.images.postgres, '--meili': lock.images.meili,
      '--monolith-version': lock.monolithVersion,
    }, { registryEnv: { DOCKER_CONFIG: dockerConfig } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options['print-fresh-args']) {
    process.stdout.write(JSON.stringify(['--regctl', options.regctl, '--packaging-url', options['packaging-url']]));
    return;
  }
  const input = await resolvePublishInput(options);
  await mkdir(dirname(resolve(options.out)), { recursive: true });
  await writeFile(resolve(options.out), `${JSON.stringify(input, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((cause) => {
    process.stderr.write(`${cause.message}\n`);
    process.exitCode = 1;
  });
}
