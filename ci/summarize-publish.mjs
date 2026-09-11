#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';

const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const LATEST_STATES = new Set(['published', 'skipped-stale', 'skipped-freshness-error']);

function usage() {
  throw new Error('usage: node ci/summarize-publish.mjs --result FILE --version vX.Y.Z --summary FILE --env FILE');
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--result', '--version', '--summary', '--env'].includes(name) || typeof value !== 'string' || value.length === 0 || options[name] !== undefined) usage();
    options[name] = value;
  }
  if (argv.length !== 8 || Object.keys(options).length !== 4) usage();
  if (!RELEASE_TAG.test(options['--version'])) throw new Error(`Invalid release version: ${options['--version']}`);
  return options;
}

async function readResult(path) {
  let result;
  try {
    result = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Invalid publish result');
  }
  if (!result || typeof result !== 'object' || !LATEST_STATES.has(result.latest)) throw new Error('Invalid publish result');
  return result;
}

function summaryFor(latest, version) {
  if (latest === 'published') {
    return `## Latest moved\n\n- Version \`${version}\` was published or reconciled.\n- The \`latest\` tags were moved to this release.`;
  }
  if (latest === 'skipped-stale') {
    return `## Version published; latest unchanged\n\n- Version \`${version}\` was published or reconciled.\n- The \`latest\` tags were not moved because fresher publish inputs were resolved.`;
  }
  return `## Latest gate resolution failed\n\n- Version \`${version}\` was published or reconciled to GHCR and mirrored to Docker Hub.\n- The \`latest\` tags were not moved; retry this run to resolve the gate.`;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const result = await readResult(options['--result']);
  await appendFile(options['--summary'], `${summaryFor(result.latest, options['--version'])}\n`);
  await appendFile(options['--env'], `LATEST_PUBLISHED=${result.latest === 'published'}\n`);
  if (result.latest === 'skipped-freshness-error') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
