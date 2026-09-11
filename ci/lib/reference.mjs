const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.)+[a-z0-9.-]+(?::[0-9]+)?\/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)+(?:\/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*))*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function invalid(kind) {
  throw new TypeError(`Invalid ${kind} reference`);
}

function validRepository(value) {
  return typeof value === 'string'
    && !value.startsWith('-')
    && !/\s|@/.test(value)
    && REPOSITORY.test(value);
}

/**
 * Parse a canonical immutable registry reference.
 *
 * @param {string} value
 * @returns {{repository: string, digest: string}}
 */
export function parseSourceReference(value) {
  if (typeof value !== 'string' || value.startsWith('-') || value.split('@').length !== 2) {
    invalid('source');
  }
  const [repository, digest] = value.split('@');
  if (!validRepository(repository) || !DIGEST.test(digest)) {
    invalid('source');
  }
  return { repository, digest };
}

/**
 * Format a canonical immutable registry reference.
 *
 * @param {string} repository
 * @param {string} digest
 * @returns {string}
 */
export function formatSourceReference(repository, digest) {
  return `${parseSourceReference(`${repository}@${digest}`).repository}@${digest}`;
}

/**
 * Parse a mutable registry tag reference used as a copy destination.
 *
 * @param {string} value
 * @returns {{repository: string, tag: string}}
 */
export function parseDestinationReference(value) {
  if (typeof value !== 'string' || value.startsWith('-') || /\s|@/.test(value)) {
    invalid('destination');
  }
  const slash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  if (colon <= slash) {
    invalid('destination');
  }
  const repository = value.slice(0, colon);
  const tag = value.slice(colon + 1);
  if (!validRepository(repository) || !TAG.test(tag)) {
    invalid('destination');
  }
  return { repository, tag };
}
