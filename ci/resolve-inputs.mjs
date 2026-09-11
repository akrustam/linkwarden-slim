#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { formatSourceReference, parseDestinationReference } from './lib/reference.mjs';
import { createRecipe, packagingInputsDigest } from './lib/recipe.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const PACKAGING_PATHS = [
  'Dockerfile',
  'docker-entrypoint.sh',
  'patch-next-standalone.js',
  'ci/run-source-tests.sh',
];
const MAX_OUTPUT_BYTES = 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || options[flag] !== undefined) {
      fail('Usage: resolve-inputs.mjs --regctl PATH --packaging-url URL --packaging-sha SHA --packaging-export DIR --upstream-tag TAG --upstream-sha SHA --postgres REF --meili REF --node REF --rust REF --monolith-version VERSION --out FILE');
    }
    options[flag] = value;
  }
  for (const flag of [
    '--regctl', '--packaging-url', '--packaging-sha', '--packaging-export', '--upstream-tag',
    '--upstream-sha', '--postgres', '--meili', '--node', '--rust', '--monolith-version', '--out',
  ]) {
    if (!options[flag]) fail(`Missing ${flag}`);
  }
  if (!SHA.test(options['--packaging-sha'])) fail('Invalid --packaging-sha');
  if (!SHA.test(options['--upstream-sha'])) fail('Invalid --upstream-sha');
  return options;
}

export function runCommand(command, args, { env = process.env, cwd } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let exceeded = false;
    const append = (current, chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (Buffer.byteLength(current) + bytes.length > MAX_OUTPUT_BYTES) {
        exceeded = true;
        child.kill();
        return current;
      }
      return current + bytes.toString();
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal, stdout, stderr, exceeded }));
  });
}

async function regctl(command, args, run) {
  const result = await run(command, args);
  if (result.exceeded) fail('Registry output limit exceeded');
  if (result.exitCode !== 0 || result.signal !== null) {
    fail(`regctl ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(0, 4000)}`);
  }
  return result.stdout;
}

function parseHead(stdout, reference) {
  const digest = stdout.trim().match(/^sha256:[a-f0-9]{64}$/)?.[0]
    ?? stdout.match(/(?:^|\n)\s*(?:Digest|Docker-Content-Digest):\s*(sha256:[a-f0-9]{64})\s*$/im)?.[1];
  if (!digest || !DIGEST.test(digest)) fail(`Malformed manifest head response for ${reference}`);
  return digest;
}

function descriptor(index, platform, reference) {
  const [os, architecture] = platform.split('/');
  const matching = index.manifests?.find((item) => item?.platform?.os === os
    && item?.platform?.architecture === architecture
    && item?.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest');
  if (!matching || !DIGEST.test(matching.digest ?? '')) {
    fail(`Manifest for ${reference} does not contain ${platform}`);
  }
  return matching.digest;
}

function normalizeTagReference(reference) {
  if (typeof reference !== 'string' || reference.startsWith('-') || /\s|@/.test(reference)) {
    fail(`Invalid image tag reference: ${reference}`);
  }
  const segments = reference.split('/');
  const name = segments.at(-1);
  if (!name?.includes(':')) fail(`Invalid image tag reference: ${reference}`);
  if (segments.length === 1) return `docker.io/library/${reference}`;
  if (!segments[0].includes('.') && !segments[0].includes(':') && segments[0] !== 'localhost') {
    return `docker.io/${reference}`;
  }
  return reference;
}

/** Resolve a tag to its index and selected child manifests without trusting mutable refs. */
export async function resolveImage({ regctlPath, reference, run = runCommand } = {}) {
  const normalizedReference = normalizeTagReference(reference);
  let parsed;
  try {
    parsed = parseDestinationReference(normalizedReference);
  } catch {
    fail(`Invalid image tag reference: ${reference}`);
  }
  const parentDigest = parseHead(await regctl(regctlPath, ['manifest', 'head', normalizedReference, '--require-digest'], run), normalizedReference);
  const sourceRef = formatSourceReference(parsed.repository, parentDigest);
  let index;
  try {
    index = JSON.parse(await regctl(regctlPath, ['manifest', 'get', sourceRef, '--format', 'raw-body'], run));
  } catch (cause) {
    if (cause instanceof SyntaxError) fail(`Malformed manifest response for ${sourceRef}`);
    throw cause;
  }
  if (!index || typeof index !== 'object' || !Array.isArray(index.manifests)) {
    fail(`Malformed manifest response for ${sourceRef}`);
  }
  return {
    sourceRef,
    indexDigest: parentDigest,
    amd64Ref: formatSourceReference(parsed.repository, descriptor(index, 'linux/amd64', sourceRef)),
    arm64Ref: formatSourceReference(parsed.repository, descriptor(index, 'linux/arm64', sourceRef)),
  };
}

export async function digestPackagingInputs(packagingExport) {
  const inputs = await Promise.all(PACKAGING_PATHS.map(async (path) => ({
    path,
    bytes: await readFile(resolve(packagingExport, path)),
  })));
  return packagingInputsDigest(inputs);
}

export async function resolveInputs(options, { run = runCommand } = {}) {
  const [postgres, meili, node, rust, packagingInputs] = await Promise.all([
    resolveImage({ regctlPath: options['--regctl'], reference: options['--postgres'], run }),
    resolveImage({ regctlPath: options['--regctl'], reference: options['--meili'], run }),
    resolveImage({ regctlPath: options['--regctl'], reference: options['--node'], run }),
    resolveImage({ regctlPath: options['--regctl'], reference: options['--rust'], run }),
    digestPackagingInputs(options['--packaging-export']),
  ]);
  const recipe = createRecipe({
    schemaVersion: 'v1',
    upstreamTag: options['--upstream-tag'],
    upstreamCommit: options['--upstream-sha'],
    packagingSourceSha: options['--packaging-sha'],
    nodeIndexDigest: node.indexDigest,
    rustIndexDigest: rust.indexDigest,
    packagingInputsDigest: packagingInputs,
    monolithVersion: options['--monolith-version'],
  });
  return {
    meiliImage: meili.amd64Ref,
    nodeImage: node.sourceRef,
    packagingExport: resolve(options['--packaging-export']),
    packagingUrl: options['--packaging-url'],
    postgresImage: postgres.amd64Ref,
    recipe,
    rustImage: rust.sourceRef,
    upstreamSha: options['--upstream-sha'],
    upstreamTag: options['--upstream-tag'],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = await resolveInputs(options);
  await mkdir(dirname(resolve(options['--out'])), { recursive: true });
  await writeFile(resolve(options['--out']), `${JSON.stringify(output, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
