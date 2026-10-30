// TY-03: generate the stable wire-projection identity snapshot — 27 HTTP
// operations (route manifest authority) + 43 gRPC RPCs with field names.
// These are OBSERVED wire projections, not a new semantic source; fields
// without a PDP binding are tagged UNBOUND, never admitted.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(repo, 'config/route-manifest.json'), 'utf8'));
const http = manifest.routes.map((r) => ({
  operationId: r.operationId, method: r.method, path: r.path, visibility: r.visibility,
})).sort((a, b) => a.operationId.localeCompare(b.operationId));

const protos = execSync('find . -name "*.proto" -path "*/main/proto/*"')
  .toString().trim().split('\n').sort();
const grpc = [];
for (const p of protos) {
  const src = readFileSync(p, 'utf8');
  for (const m of src.matchAll(/rpc\s+(\w+)\s*\(\s*(?:stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?(\w+)\s*\)/g)) {
    grpc.push({ service: p.split('/').pop(), rpc: m[1], request: m[2], response: m[3] });
  }
}
grpc.sort((a, b) => a.rpc.localeCompare(b.rpc));

const fields = {};
for (const p of protos) {
  const src = readFileSync(p, 'utf8');
  for (const m of src.matchAll(/message\s+(\w+)\s*\{([\s\S]*?)\}/g)) {
    fields[m[1]] = [...m[2].matchAll(/(?:repeated\s+|optional\s+)?[\w.]+\s+(\w+)\s*=\s*\d+/g)]
      .map((f) => f[1]).sort();
  }
}

const snapshot = {
  schemaVersion: 'media.wire-projection-snapshot.v1',
  semantics: 'OBSERVED_PROJECTION_NOT_SOURCE',
  note: 'fields/routes/RPCs are wire projections; absent PDP binding = UNBOUND, never admitted',
  http: { count: http.length, operations: http },
  grpc: { count: grpc.length, rpcs: grpc },
  messages: fields,
};
writeFileSync(join(repo, 'docs/implementation/media-wire-projection-snapshot.v1.json'),
  JSON.stringify(snapshot, null, 2) + '\n');
console.log(`snapshot: ${http.length} HTTP ops, ${grpc.length} RPCs, ${Object.keys(fields).length} messages`);
