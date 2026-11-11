import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

test('current host check runs and records its invocation', async () => {
  const path = process.env.LOCAL_TEST_PASS_CACHE_COUNTER;
  assert.ok(path, 'counter path must be provided');
  let count = 0;
  try { count = Number(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(path, String(count + 1));
});
