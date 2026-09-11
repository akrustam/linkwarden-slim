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

function isMissing(result) {
  const text = resultText(result);
  return result?.exitCode === 1
    && result?.signal === null
    && /\bMANIFEST_UNKNOWN\b/i.test(text);
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

/**
 * Inspect one registry reference by first resolving its immutable parent index,
 * then inspecting every required platform manifest from that exact index.
 *
 * @param {{regctlPath: string, reference: string, env?: NodeJS.ProcessEnv, run?: Function}} input
 * @returns {Promise<object>}
 */
export async function inspectReference({ regctlPath, reference, env, run = defaultRun } = {}) {
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
    return isMissing(head.failure)
      ? { kind: 'Missing' }
      : error(`Unable to inspect ${reference}: ${resultText(head.failure) || 'regctl failed'}`);
  }

  const parentDigest = parentDigestFromHead(head.result.stdout);
  if (!parentDigest || !DIGEST.test(parentDigest)) {
    return error(`Malformed manifest head response for ${reference}`);
  }
  const sourceRef = formatSourceReference(parsedReference.repository, parentDigest);
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
    const descriptor = descriptors.find((item) => item?.platform?.os === platform.split('/')[0]
      && item?.platform?.architecture === platform.split('/')[1]
      && item?.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest');
    if (!descriptor || !DIGEST.test(descriptor.digest ?? '')) {
      continue;
    }
    const platformRef = formatSourceReference(parsedReference.repository, descriptor.digest);
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
