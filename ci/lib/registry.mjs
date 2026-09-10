import { spawn } from 'node:child_process';

import { TARGET_PLATFORMS, validateArtifact } from './artifact.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DIGEST_REFERENCE = /^[^@\s]+@sha256:[a-f0-9]{64}$/;

function defaultRun(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function resultText(result) {
  return [result?.stderr, result?.stdout, result?.message].filter(Boolean).join('\n');
}

function exitCode(result) {
  return result?.exitCode ?? result?.code ?? result?.status ?? 0;
}

function isMissing(result) {
  const text = resultText(result);
  return result?.statusCode === 404
    || /\bMANIFEST_UNKNOWN\b/i.test(text)
    || /\b(?:status(?:\s+code)?|http)\s*[:=]?\s*404\b/i.test(text)
    || /\(404\)/.test(text);
}

function repositoryFor(reference) {
  const withoutDigest = reference.split('@', 1)[0];
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function error(message) {
  return { kind: 'Error', message };
}

async function invoke(run, command, args, env) {
  try {
    const result = await run(command, args, { env });
    if (exitCode(result) !== 0) {
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
  if (typeof regctlPath !== 'string' || regctlPath.length === 0 || typeof reference !== 'string' || reference.length === 0) {
    return error('regctlPath and reference are required');
  }
  const head = await invoke(run, regctlPath, ['manifest', 'head', '--require-digest', reference], env);
  if (head.failure) {
    return isMissing(head.failure)
      ? { kind: 'Missing' }
      : error(`Unable to inspect ${reference}: ${resultText(head.failure) || 'regctl failed'}`);
  }

  const parentDigest = typeof head.result.stdout === 'string'
    ? head.result.stdout.match(/(?:^|\n)\s*Digest:\s*(sha256:[a-f0-9]{64})\s*$/m)?.[1]
    : undefined;
  if (!parentDigest || !DIGEST.test(parentDigest)) {
    return error(`Malformed manifest head response for ${reference}`);
  }
  const sourceRef = `${repositoryFor(reference)}@${parentDigest}`;
  const manifest = await invoke(run, regctlPath, ['manifest', 'get', '--format', 'raw-body', sourceRef], env);
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
    const inspected = await invoke(run, regctlPath, ['image', 'inspect', `${repositoryFor(reference)}@${descriptor.digest}`], env);
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
 * Copy an immutable source reference to a tag or another immutable reference.
 *
 * @param {{regctlPath: string, source: string, destination: string, env?: NodeJS.ProcessEnv, run?: Function}} input
 * @returns {Promise<void>}
 */
export async function copyReference({ regctlPath, source, destination, env, run = defaultRun } = {}) {
  if (!DIGEST_REFERENCE.test(source ?? '')) {
    throw new TypeError('Copy source must be a digest-qualified reference');
  }
  if (typeof regctlPath !== 'string' || regctlPath.length === 0 || typeof destination !== 'string' || destination.length === 0) {
    throw new TypeError('regctlPath and destination are required');
  }
  const copied = await invoke(run, regctlPath, ['image', 'copy', source, destination], env);
  if (copied.failure) {
    throw new Error(`Unable to copy ${source}: ${resultText(copied.failure) || 'regctl failed'}`);
  }
}
