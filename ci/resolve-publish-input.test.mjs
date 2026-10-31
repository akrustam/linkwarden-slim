import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseOptions, resolvePublishInput } from './resolve-publish-input.mjs';
import { validateBuildLock } from './lib/build-lock.mjs';

const execute = promisify(execFile);
const script = new URL('./resolve-publish-input.mjs', import.meta.url).pathname;
const digest = (c) => `sha256:${c.repeat(64)}`;
const canonicalLock = JSON.parse(await readFile(new URL('../build-lock.json', import.meta.url), 'utf8'));

async function git(directory, ...args) {
  const { stdout } = await execute('git', ['-C', directory, ...args]);
  return stdout.trim();
}

async function init(directory) {
  await mkdir(directory);
  await git(directory, 'init', '-q', '-b', 'main');
  await git(directory, 'config', 'user.name', 'test');
  await git(directory, 'config', 'user.email', 'test@example.invalid');
}

async function commit(directory, message) {
  await git(directory, 'add', '.');
  await git(directory, 'commit', '-qm', message);
  return git(directory, 'rev-parse', 'HEAD');
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'linkwarden-resolver-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream repo');
  const packaging = join(root, 'packaging repo');
  await init(upstream);
  await writeFile(join(upstream, 'source'), 'first');
  const sha = await commit(upstream, 'first');
  await git(upstream, 'tag', '-a', 'v1.2.3', '-m', 'annotated release');
  await init(packaging);
  await mkdir(join(packaging, 'ci'));
  for (const path of ['Dockerfile', 'docker-entrypoint.sh', 'patch-next-standalone.js', 'ci/run-source-tests.sh']) {
    await writeFile(join(packaging, path), 'fixture\n');
  }
  const lock = structuredClone(canonicalLock);
  lock.upstream = { url: pathToFileURL(upstream).href, tag: 'v1.2.3', commit: sha };
  const saveLock = async (value = lock) => {
    await writeFile(join(packaging, 'build-lock.json'), JSON.stringify(value));
    return commit(packaging, 'lock inputs');
  };
  const packagingSha = await saveLock();
  const log = join(root, 'registry.log');
  const regctl = join(root, 'regctl');
  await writeFile(regctl, `#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, config: process.env.DOCKER_CONFIG, files: fs.readdirSync(process.env.DOCKER_CONFIG) }) + '\\n');
if (fs.existsSync(${JSON.stringify(join(root, 'registry-error'))})) process.exit(1);
if (args[0] !== 'manifest' || args[1] !== 'get') process.exit(64);
const platforms = fs.existsSync(${JSON.stringify(join(root, 'missing-arm64'))}) ? ['amd64'] : ['amd64', 'arm64'];
console.log(JSON.stringify({ schemaVersion: 2, manifests: platforms.map(architecture => ({
  digest: 'sha256:' + crypto.createHash('sha256').update(args[2] + architecture).digest('hex'),
  platform: { os: 'linux', architecture }
})) }));
`, { mode: 0o755 });
  const options = { regctl, 'packaging-url': pathToFileURL(packaging).href };
  return { root, upstream, packaging, lock, saveLock, log, options, packagingSha, sha };
}

test('lock schema rejects mutable images, partial/unknown fields and invalid values', () => {
  assert.deepEqual(validateBuildLock(canonicalLock), canonicalLock);
  const mutations = [
    (x) => { x.images.node = 'node:lts-bookworm-slim'; },
    (x) => { delete x.images.rust; },
    (x) => { x.images.typo = x.images.node; },
    (x) => { x.upstream.tag = 'latest'; },
    (x) => { x.upstream.commit = [x.upstream.commit]; },
    (x) => { x.upstream.url = 'https://user:secret@example.org/repo.git'; },
    (x) => { x.schemaVersion = 2; },
    (x) => { x.monolithVersion = 'latest'; },
  ];
  for (const mutate of mutations) {
    const lock = structuredClone(canonicalLock);
    mutate(lock);
    assert.throws(() => validateBuildLock(lock));
  }
});

test('CLI rejects invalid options and fresh arguments cannot carry stale build inputs', async () => {
  const base = ['--regctl', 'regctl', '--packaging-url', 'packaging'];
  assert.throws(() => parseOptions(base), /out/);
  assert.throws(() => parseOptions([...base, '--out', 'out', '--node', 'node:lts']), /Unknown option/);
  assert.throws(() => parseOptions([...base, '--out', 'out', '--upstream-tag', 'latest']), /upstream-tag/);
  assert.throws(() => parseOptions([...base, '--out', 'out', '--packaging-sha', 'main']), /packaging-sha/);
  assert.throws(() => parseOptions([...base, '--print-fresh-args', '--upstream-tag', 'v1.2.3']), /only accepts/);
  const { stdout } = await execute(process.execPath, [script, ...base, '--print-fresh-args']);
  assert.deepEqual(JSON.parse(stdout), base);
});

test('real git contexts resolve annotated locked releases and isolate registry credentials', async (t) => {
  const f = await fixture(t);
  const input = await resolvePublishInput(f.options);
  assert.equal(input.upstreamSha, f.sha);
  assert.equal(input.upstreamTag, 'v1.2.3');
  assert.equal(input.recipe.packagingSourceSha, f.packagingSha);
  assert.equal(input.nodeImage, f.lock.images.node);
  assert.equal(input.rustImage, f.lock.images.rust);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 4);
  assert.equal(calls.every(({ args, files }) => args[1] === 'get' && files.length === 0), true);
  await assert.rejects(readFile(calls[0].config + '/config.json'), /ENOENT/);
  await assert.rejects(execute('test', ['-e', calls[0].config]));
});

test('fresh resolution reads changed service and base pins from current main, not old args', async (t) => {
  const f = await fixture(t);
  const initial = await resolvePublishInput(f.options);
  f.lock.images.postgres = `docker.io/library/postgres@${digest('e')}`;
  f.lock.images.node = `docker.io/library/node@${digest('f')}`;
  await f.saveLock();
  const fresh = await resolvePublishInput(f.options);
  assert.notEqual(fresh.validationFingerprint, initial.validationFingerprint);
  assert.notEqual(fresh.recipe.recipeId, initial.recipe.recipeId);
  assert.equal(fresh.nodeImage, f.lock.images.node);
  const original = await resolvePublishInput({ ...f.options, 'packaging-sha': f.packagingSha });
  assert.equal(original.recipe.recipeId, initial.recipe.recipeId);
});

test('moved tags fail even when the manual version matches the reviewed tag', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.upstream, 'source'), 'moved');
  await commit(f.upstream, 'moved');
  await git(f.upstream, 'tag', '-f', 'v1.2.3');
  for (const options of [f.options, { ...f.options, 'upstream-tag': 'v1.2.3' }]) {
    await assert.rejects(resolvePublishInput(options), /differs from the reviewed/);
  }
});

test('manual historical version resolves separately and does not alter the reviewed lock', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.upstream, 'source'), 'historical');
  const sha = await commit(f.upstream, 'historical');
  await git(f.upstream, 'tag', 'v1.2.2');
  const manual = await resolvePublishInput({ ...f.options, 'upstream-tag': 'v1.2.2' });
  assert.equal(manual.upstreamSha, sha);
  const fresh = await resolvePublishInput(f.options);
  assert.equal(fresh.upstreamSha, f.sha);
  assert.notEqual(manual.recipe.recipeId, fresh.recipe.recipeId);
});

test('missing lock, malformed JSON and registry failures produce no successful CLI output', async (t) => {
  const f = await fixture(t);
  const out = join(f.root, 'input.json');
  const cli = [script, '--regctl', f.options.regctl, '--packaging-url', f.options['packaging-url'], '--out', out];
  await writeFile(join(f.root, 'registry-error'), 'fail');
  await assert.rejects(execute(process.execPath, cli), /Unable to fetch/);
  await assert.rejects(readFile(out), /ENOENT/);
  await rm(join(f.root, 'registry-error'));
  await writeFile(join(f.root, 'missing-arm64'), 'fail');
  await assert.rejects(resolvePublishInput(f.options), /does not contain linux\/arm64/);
  await writeFile(join(f.packaging, 'build-lock.json'), '{');
  await commit(f.packaging, 'malformed');
  await assert.rejects(resolvePublishInput(f.options), SyntaxError);
  await git(f.packaging, 'rm', 'build-lock.json');
  await commit(f.packaging, 'missing');
  await assert.rejects(resolvePublishInput(f.options), /ENOENT/);
});


test('opt-in local build uses working-tree lock and files; unavailable Docker fails closed', async (t) => {
  const f = await fixture(t);
  for (const workspace of ['mobile', 'extension']) {
    await mkdir(join(f.upstream, 'apps', workspace), { recursive: true });
    await writeFile(join(f.upstream, 'apps', workspace, 'package.json'), '{}');
  }
  await writeFile(join(f.upstream, 'package.json'), '{}');
  f.lock.upstream.commit = await commit(f.upstream, 'workspaces');
  const workingTree = join(f.root, 'working tree');
  await mkdir(join(workingTree, 'ci'), { recursive: true });
  for (const name of ['Dockerfile', 'docker-entrypoint.sh', 'patch-next-standalone.js',
    'ci/run-source-tests.sh', 'ci/dockerfile-context.test.sh', 'ci/materialize-packaging.sh',
    'ci/materialize-packaging.sh.test.sh', 'ci/prepare-context.sh', 'ci/prepare-context.sh.test.sh']) {
    await copyFile(new URL('../' + name, import.meta.url), join(workingTree, name));
  }
  await writeFile(join(workingTree, 'build-lock.json'), JSON.stringify(f.lock));
  await writeFile(join(workingTree, 'docker-entrypoint.sh'), 'working-tree marker');
  const bin = join(f.root, 'bin');
  const output = join(f.root, 'docker-build.json');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'info') process.exit(process.env.FAIL_DOCKER === '1' ? 1 : 0);
if (args[0] !== 'buildx' || args[1] !== 'build') process.exit(64);
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ args,
  entrypoint: fs.readFileSync(args.at(-1) + '/docker-entrypoint.sh', 'utf8')
}));
`, { mode: 0o755 });
  const command = ['bash', [join(workingTree, 'ci/dockerfile-context.test.sh')]];
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, CI_RUN_NETWORK_TESTS: '1' };
  await execute(...command, { env });
  const built = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(built.entrypoint, 'working-tree marker');
  assert.equal(built.args.includes(`NODE_IMAGE=${f.lock.images.node}`), true);
  assert.equal(built.args.includes(`RUST_IMAGE=${f.lock.images.rust}`), true);
  await rm(output);
  await assert.rejects(execute(...command, { env: { ...env, FAIL_DOCKER: '1' } }), /Docker is required/);
  await assert.rejects(readFile(output), /ENOENT/);
});
