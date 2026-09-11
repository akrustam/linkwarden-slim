#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { parseSourceReference } from './lib/reference.mjs';
import { createRecipe, packagingInputsDigest } from './lib/recipe.mjs';
import { resolveImageReference } from './lib/registry.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const PACKAGING_PATHS = [
  'Dockerfile',
  'docker-entrypoint.sh',
  'patch-next-standalone.js',
  'ci/run-source-tests.sh',
];
const VALIDATION_FINGERPRINT_HEADER = 'linkwarden-slim-validation-fingerprint-v1';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || options[flag] !== undefined) {
      fail('Usage: resolve-inputs.mjs --regctl PATH --packaging-url URL --packaging-sha SHA --packaging-export DIR --upstream-tag TAG --upstream-url URL --upstream-sha SHA --postgres REF --meili REF --node REF --rust REF --monolith-version VERSION --out FILE');
    }
    options[flag] = value;
  }
  for (const flag of [
    '--regctl', '--packaging-url', '--packaging-sha', '--packaging-export', '--upstream-tag',
    '--upstream-url', '--upstream-sha', '--postgres', '--meili', '--node', '--rust', '--monolith-version', '--out',
  ]) {
    if (!options[flag]) fail(`Missing ${flag}`);
  }
  if (!SHA.test(options['--packaging-sha'])) fail('Invalid --packaging-sha');
  if (!SHA.test(options['--upstream-sha'])) fail('Invalid --upstream-sha');
  return options;
}

export async function digestPackagingInputs(packagingExport) {
  const inputs = await Promise.all(PACKAGING_PATHS.map(async (path) => ({
    path,
    bytes: await readFile(resolve(packagingExport, path)),
  })));
  return packagingInputsDigest(inputs);
}

/**
 * Derive the runtime-validation dependency identity from the exact resolved
 * amd64 service references. This remains outside the application build recipe.
 */
export function validationFingerprintFor({ postgresImage, meiliImage }) {
  const hash = createHash('sha256');
  hash.update(Buffer.from(VALIDATION_FINGERPRINT_HEADER, 'utf8'));
  for (const [name, reference] of [['postgresImage', postgresImage], ['meiliImage', meiliImage]]) {
    parseSourceReference(reference);
    const nameBytes = Buffer.from(name, 'utf8');
    const referenceBytes = Buffer.from(reference, 'utf8');
    const nameLength = Buffer.alloc(8);
    const referenceLength = Buffer.alloc(8);
    nameLength.writeBigUInt64BE(BigInt(nameBytes.length));
    referenceLength.writeBigUInt64BE(BigInt(referenceBytes.length));
    hash.update(nameLength).update(nameBytes).update(referenceLength).update(referenceBytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function resolveInputs(options, { run } = {}) {
  const [postgres, meili, node, rust, packagingInputs] = await Promise.all([
    resolveImageReference({ regctlPath: options['--regctl'], reference: options['--postgres'], platforms: ['linux/amd64'], run }),
    resolveImageReference({ regctlPath: options['--regctl'], reference: options['--meili'], platforms: ['linux/amd64'], run }),
    resolveImageReference({ regctlPath: options['--regctl'], reference: options['--node'], platforms: ['linux/amd64', 'linux/arm64'], run }),
    resolveImageReference({ regctlPath: options['--regctl'], reference: options['--rust'], platforms: ['linux/amd64', 'linux/arm64'], run }),
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
  const postgresImage = postgres.platformRefs['linux/amd64'];
  const meiliImage = meili.platformRefs['linux/amd64'];
  return {
    meiliImage,
    nodeImage: node.sourceRef,
    packagingExport: resolve(options['--packaging-export']),
    packagingUrl: options['--packaging-url'],
    postgresImage,
    recipe,
    rustImage: rust.sourceRef,
    upstreamSha: options['--upstream-sha'],
    upstreamTag: options['--upstream-tag'],
    upstreamUrl: options['--upstream-url'],
    validationFingerprint: validationFingerprintFor({ postgresImage, meiliImage }),
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
