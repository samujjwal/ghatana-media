// TY-03 regression: the committed wire-projection snapshot must equal the
// exact observed wire surface — any added, removed or renamed HTTP route,
// gRPC RPC, message or field is a silent wire break and fails this suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const committed = JSON.parse(readFileSync(
  join(repo, 'docs/implementation/media-wire-projection-snapshot.v1.json'), 'utf8'));

const manifest = JSON.parse(readFileSync(join(repo, 'config/route-manifest.json'), 'utf8'));
const http = manifest.routes.map((r) => ({
  operationId: r.operationId, method: r.method, path: r.path, visibility: r.visibility,
})).sort((a, b) => a.operationId.localeCompare(b.operationId));

const protos = execSync('find . -name "*.proto" -path "*/main/proto/*"')
  .toString().trim().split('\n').sort();
const grpc = []; const fields = {};
for (const p of protos) {
  const src = readFileSync(p, 'utf8');
  for (const m of src.matchAll(/rpc\s+(\w+)\s*\(\s*(?:stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?(\w+)\s*\)/g)) {
    grpc.push({ service: p.split('/').pop(), rpc: m[1], request: m[2], response: m[3] });
  }
  for (const m of src.matchAll(/message\s+(\w+)\s*\{([\s\S]*?)\}/g)) {
    fields[m[1]] = [...m[2].matchAll(/(?:repeated\s+|optional\s+)?[\w.]+\s+(\w+)\s*=\s*\d+/g)]
      .map((f) => f[1]).sort();
  }
}
grpc.sort((a, b) => a.rpc.localeCompare(b.rpc));

test('TY-03: HTTP route surface has not drifted (27 ops)', () => {
  assert.equal(http.length, 27);
  assert.deepEqual(http, committed.http.operations);
});

test('TY-03: gRPC RPC surface has not drifted (43 RPCs)', () => {
  assert.equal(grpc.length, 43);
  assert.deepEqual(grpc, committed.grpc.rpcs);
});

test('TY-03: message field identities have not drifted', () => {
  assert.deepEqual(fields, committed.messages);
});
