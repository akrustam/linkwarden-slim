import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSourceReference } from './reference.mjs';

export const RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
export const COMMIT_SHA = /^[a-f0-9]{40}$/;

function requireKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new TypeError(`Invalid ${name} fields`);
  }
}

export function validateBuildLock(lock) {
  requireKeys(lock, ['schemaVersion', 'upstream', 'images', 'monolithVersion'], 'build lock');
  if (lock.schemaVersion !== 1) throw new TypeError('Unsupported build lock schemaVersion');
  requireKeys(lock.upstream, ['url', 'tag', 'commit'], 'upstream');
  if (typeof lock.upstream.url !== 'string') throw new TypeError('Invalid upstream URL');
  const url = new URL(lock.upstream.url);
  if (!['https:', 'file:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Invalid upstream URL');
  }
  if (typeof lock.upstream.tag !== 'string' || !RELEASE_TAG.test(lock.upstream.tag)) throw new TypeError('Invalid upstream tag');
  if (typeof lock.upstream.commit !== 'string' || !COMMIT_SHA.test(lock.upstream.commit)) throw new TypeError('Invalid upstream commit');
  requireKeys(lock.images, ['node', 'rust', 'postgres', 'meili'], 'images');
  for (const reference of Object.values(lock.images)) parseSourceReference(reference);
  if (typeof lock.monolithVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(lock.monolithVersion)) {
    throw new TypeError('Invalid monolithVersion');
  }
  return lock;
}

export async function readBuildLock(directory) {
  return validateBuildLock(JSON.parse(await readFile(join(directory, 'build-lock.json'), 'utf8')));
}
