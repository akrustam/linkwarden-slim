import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./summarize-publish.mjs', import.meta.url);

async function runSummary({ result, version = 'v2.10.1', args = [] }) {
  const directory = await mkdtemp(join(tmpdir(), 'linkwarden-summarize-publish-'));
  const resultPath = join(directory, 'result.json');
  const summaryPath = join(directory, 'summary.md');
  const envPath = join(directory, 'env');
  await writeFile(resultPath, result);
  await writeFile(summaryPath, 'existing summary\n');
  await writeFile(envPath, 'EXISTING=true\n');
  const command = spawnSync(process.execPath, [script.pathname, '--result', resultPath, '--version', version, '--summary', summaryPath, '--env', envPath, ...args], { encoding: 'utf8' });
  return {
    ...command,
    env: await readFile(envPath, 'utf8'),
    summary: await readFile(summaryPath, 'utf8'),
  };
}

test('summarizes a published latest update and marks it published', async () => {
  const result = await runSummary({ result: '{"latest":"published"}\n' });
  assert.equal(result.status, 0);
  assert.equal(result.summary, 'existing summary\n## Latest moved\n\n- Version `v2.10.1` was published or reconciled.\n- The `latest` tags were moved to this release.\n');
  assert.equal(result.env, 'EXISTING=true\nLATEST_PUBLISHED=true\n');
});

test('summarizes a stale latest update without failing the workflow', async () => {
  const result = await runSummary({ result: '{"latest":"skipped-stale"}\n' });
  assert.equal(result.status, 0);
  assert.match(result.summary, /## Version published; latest unchanged/);
  assert.match(result.summary, /fresher publish inputs were resolved/);
  assert.equal(result.env, 'EXISTING=true\nLATEST_PUBLISHED=false\n');
});

test('summarizes a freshness error before failing the workflow', async () => {
  const result = await runSummary({ result: '{"latest":"skipped-freshness-error"}\n' });
  assert.equal(result.status, 1);
  assert.match(result.summary, /## Latest gate resolution failed/);
  assert.match(result.summary, /mirrored to Docker Hub/);
  assert.equal(result.env, 'EXISTING=true\nLATEST_PUBLISHED=false\n');
});

test('rejects malformed results, versions, and CLI modes', async () => {
  const malformed = await runSummary({ result: '{"latest":"unexpected"}\n' });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Invalid publish result/);

  const invalidJson = await runSummary({ result: '{not-json}\n' });
  assert.equal(invalidJson.status, 1);
  assert.match(invalidJson.stderr, /Invalid publish result/);

  const invalidVersion = await runSummary({ result: '{"latest":"published"}\n', version: '2.10.1' });
  assert.equal(invalidVersion.status, 1);
  assert.match(invalidVersion.stderr, /Invalid release version/);

  const extra = await runSummary({ result: '{"latest":"published"}\n', args: ['--unknown', 'value'] });
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /usage:/);
});
