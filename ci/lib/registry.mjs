import { spawn } from 'node:child_process';

import { TARGET_PLATFORMS, validateArtifact } from './artifact.mjs';
import {
  formatSourceReference,
  parseDestinationReference,
  parseSourceReference,
} from './reference.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
export const MAX_OUTPUT_BYTES = 1024 * 1024;

function collectOutput(stream, child, limit) {
  let output = '';
  let exceeded = false;
  stream.on('data', (chunk) => {
    if (exceeded) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (Buffer.byteLength(output) + bytes.length > limit) {
      exceeded = true;
      child.kill();
      return;
    }
    output += bytes.toString();
  });
  return {
    value: () => output,
    exceeded: () => exceeded,
  };
}

function defaultRun(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = collectOutput(child.stdout, child, MAX_OUTPUT_BYTES);
    const stderr = collectOutput(child.stderr, child, MAX_OUTPUT_BYTES);
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({
      exitCode,
      signal,
      stdout: stdout.value(),
      stderr: stderr.value(),
      outputExceeded: stdout.exceeded() || stderr.exceeded(),
    }));
  });
}

function resultText(result) {
  return [result?.stderr, result?.stdout, result?.message].filter(Boolean).join('\n');
}

function isMissing(result, allowNotFound) {
  const text = resultText(result);
  return result?.exitCode === 1
    && result?.signal === null
    && ( /\bMANIFEST_UNKNOWN\b/i.test(text)
      || (allowNotFound === true && /request failed: not found \[http 404\]:/i.test(text)));
}

function parentDigestFromHead(stdout) {
  if (typeof stdout !== 'string') {
    return undefined;
  }
  const directDigest = stdout.trim();
  if (DIGEST.test(directDigest)) {
    return directDigest;
  }
  return stdout.match(/(?:^|\r?\n)\s*(?:Digest|Docker-Content-Digest):\s*(sha256:[a-f0-9]{64})\s*$/im)?.[1];
}

function normalizeTagReference(reference) {
  if (typeof reference !== 'string' || reference.startsWith('-') || /\s|@/.test(reference)) {
    throw new TypeError(`Invalid image tag reference: ${reference}`);
  }
  const segments = reference.split('/');
  const name = segments.at(-1);
  if (!name?.includes(':')) throw new TypeError(`Invalid image tag reference: ${reference}`);
  if (segments.length === 1) return `docker.io/library/${reference}`;
  if (!segments[0].includes('.') && !segments[0].includes(':') && segments[0] !== 'localhost') {
    return `docker.io/${reference}`;
  }
  return reference;
}

function descriptorForPlatform(index, platform, reference) {
  const [os, architecture] = platform.split('/');
  const descriptor = index.manifests?.find((item) => item?.platform?.os === os
    && item?.platform?.architecture === architecture
    && item?.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest');
  if (!descriptor || !DIGEST.test(descriptor.digest ?? '')) {
    throw new TypeError(`Manifest for ${reference} does not contain ${platform}`);
  }
  return descriptor.digest;
}

function error(message) {
  return { kind: 'Error', message };
}

/**
 * Run one regctl command. Injected runners must return an object with a
 * literal numeric `exitCode`, `signal` (null on normal exit), and string
 * `stdout`/`stderr`; only `{ exitCode: 0, signal: null }` succeeds.
 */
async function invoke(run, command, args, env) {
  try {
    const result = await run(command, args, { env });
    if (result?.outputExceeded === true
      || (typeof result?.stdout === 'string' && Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES)
      || (typeof result?.stderr === 'string' && Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES)) {
      return { failure: { ...result, message: 'Registry output limit exceeded' } };
    }
    if (!result || result.exitCode !== 0 || result.signal !== null) {
      return { failure: result };
    }
    return { result };
  } catch (cause) {
    return { failure: { message: cause instanceof Error ? cause.message : String(cause) } };
  }
}

function parseJson(stdout, description) {
  try {
    const value = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SyntaxError('expected object');
    }
    return value;
  } catch {
    throw new TypeError(`Malformed ${description} response`);
  }
}

function requireRegistryResult(invocation, description) {
  if (invocation.failure) {
    throw new Error(`Unable to ${description}: ${resultText(invocation.failure) || 'regctl failed'}`);
  }
  return invocation.result.stdout;
}

/** Resolve one mutable image tag into its immutable index and requested platform manifests. */
export async function resolveImageReference({ regctlPath, reference, platforms, env, run = defaultRun } = {}) {
  if (typeof regctlPath !== 'string' || regctlPath.length === 0 || !Array.isArray(platforms) || platforms.length === 0) {
    throw new TypeError('regctlPath, reference, and platforms are required');
  }
  const normalizedReference = normalizeTagReference(reference);
  let parsed;
  try {
    parsed = parseDestinationReference(normalizedReference);
  } catch {
    throw new TypeError(`Invalid image tag reference: ${reference}`);
  }
  const head = await invoke(run, regctlPath, ['manifest', 'head', normalizedReference, '--require-digest'], env);
  const parentDigest = parentDigestFromHead(requireRegistryResult(head, `resolve ${normalizedReference}`));
  if (!parentDigest || !DIGEST.test(parentDigest)) {
    throw new TypeError(`Malformed manifest head response for ${normalizedReference}`);
  }
  const sourceRef = formatSourceReference(parsed.repository, parentDigest);
  const manifest = await invoke(run, regctlPath, ['manifest', 'get', sourceRef, '--format', 'raw-body'], env);
  const index = parseJson(requireRegistryResult(manifest, `fetch ${sourceRef}`), 'manifest');
  if (!Array.isArray(index.manifests)) throw new TypeError(`Malformed manifest response for ${sourceRef}`);
  return {
    sourceRef,
    indexDigest: parentDigest,
    platformRefs: Object.fromEntries(platforms.map((platform) => [
      platform,
      formatSourceReference(parsed.repository, descriptorForPlatform(index, platform, sourceRef)),
    ])),
  };
}

/**
 * Inspect a digest-qualified source without resolving any mutable tag.
 *
 * @param {{regctlPath: string, sourceRef: string, env?: NodeJS.ProcessEnv, run?: Function}} input
 * @returns {Promise<object>}
 */
export async function inspectSourceReference({ regctlPath, sourceRef, env, run = defaultRun } = {}) {
  let parsedSource;
  try {
    parsedSource = parseSourceReference(sourceRef);
  } catch {
    return error('Invalid registry source reference');
  }
  if (typeof regctlPath !== 'string' || regctlPath.length === 0) {
    return error('regctlPath and sourceRef are required');
  }
  const manifest = await invoke(run, regctlPath, ['manifest', 'get', sourceRef, '--format', 'raw-body'], env);
  if (manifest.failure) {
    return error(`Unable to fetch ${sourceRef}: ${resultText(manifest.failure) || 'regctl failed'}`);
  }

  let index;
  try {
    index = parseJson(manifest.result.stdout, 'manifest');
  } catch (cause) {
    return error(cause.message);
  }
  const descriptors = index.manifests;
  if (!Array.isArray(descriptors)) {
    return error(`Malformed manifest response for ${sourceRef}`);
  }
  const configs = {};
  for (const platform of TARGET_PLATFORMS) {
    let digest;
    try {
      digest = descriptorForPlatform(index, platform, sourceRef);
    } catch {
      continue;
    }
    const platformRef = formatSourceReference(parsedSource.repository, digest);
    const inspected = await invoke(run, regctlPath, ['image', 'inspect', platformRef], env);
    if (inspected.failure) {
      return error(`Unable to inspect ${platform} manifest: ${resultText(inspected.failure) || 'regctl failed'}`);
    }
    try {
      configs[platform] = parseJson(inspected.result.stdout, `${platform} image inspect`);
    } catch (cause) {
      return error(cause.message);
    }
  }
  return validateArtifact({ sourceRef, index, configs });
}

/**
 * Resolve a mutable tag once, then inspect its immutable parent source.
 *
 * @param {{regctlPath: string, reference: string, allowNotFound?: boolean, env?: NodeJS.ProcessEnv, run?: Function}} input
 * @returns {Promise<object>}
 */
export async function inspectReference({ regctlPath, reference, allowNotFound = false, env, run = defaultRun } = {}) {
  let parsedReference;
  try {
    parsedReference = parseDestinationReference(reference);
  } catch {
    return error('Invalid registry reference');
  }
  if (typeof regctlPath !== 'string' || regctlPath.length === 0) {
    return error('regctlPath and reference are required');
  }
  const head = await invoke(run, regctlPath, ['manifest', 'head', reference, '--require-digest'], env);
  if (head.failure) {
    return isMissing(head.failure, allowNotFound)
      ? { kind: 'Missing' }
      : error(`Unable to inspect ${reference}: ${resultText(head.failure) || 'regctl failed'}`);
  }
  const parentDigest = parentDigestFromHead(head.result.stdout);
  if (!parentDigest || !DIGEST.test(parentDigest)) {
    return error(`Malformed manifest head response for ${reference}`);
  }
  return inspectSourceReference({
    regctlPath,
    sourceRef: formatSourceReference(parsedReference.repository, parentDigest),
    env,
    run,
  });
}

/**
 * Copy an immutable source reference to a mutable tag.
 *
 * @param {{regctlPath: string, source: string, destination: string, env?: NodeJS.ProcessEnv, run?: Function}} input
 * @returns {Promise<void>}
 */
export async function copyReference({ regctlPath, source, destination, env, run = defaultRun } = {}) {
  try {
    parseSourceReference(source);
    parseDestinationReference(destination);
  } catch {
    throw new TypeError('Copy source and destination must be valid registry references');
  }
  if (typeof regctlPath !== 'string' || regctlPath.length === 0) {
    throw new TypeError('regctlPath and destination are required');
  }
  const copied = await invoke(run, regctlPath, ['image', 'copy', source, destination], env);
  if (copied.failure) {
    throw new Error(`Unable to copy ${source}: ${resultText(copied.failure) || 'regctl failed'}`);
  }
}
