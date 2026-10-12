import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const parse = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml').parse;
const readYaml = (file) => parse(fs.readFileSync(path.join(root, file), 'utf8'));
const files = (dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith('.yaml') && name !== 'README.md').sort();

// Definition-only fixtures are intentionally produced from the exact identity and
// type references in PDP-3's existing records. They never emulate a business result.
function buildFixtureRegistry() {
  const http = files('.product-experience/pdp-3-product-experience/api/operations').map((name) => {
    const sourcePath = `.product-experience/pdp-3-product-experience/api/operations/${name}`;
    const source = readYaml(sourcePath);
    const id = source.operationId;
    const requestTypes = source.request?.schemaRefs ?? [];
    const responseTypes = Object.entries(source.response?.schemaRefsByStatus ?? {})
      .flatMap(([status, refs]) => refs.map((ref) => ({ status, ref })));
    return {
      channel: 'HTTP', id, sourcePath,
      identity: source.protocolIdentity,
      requestTypes: [{ sourceDeclaration: source.request ?? { declaredNoRequestShape: true }, schemaRefs: requestTypes }],
      responseTypes: responseTypes.length ? responseTypes : [{ sourceDeclaration: source.response ?? { declaredNoResponseShape: true } }],
      sourceComplete: Boolean(source.interfaceDefinition && source.interfaceDefinition.runtimeAdmission === 'NOT_ADMITTED'),
    };
  });
  const grpc = files('.product-experience/pdp-3-product-experience/grpc/operations').map((name) => {
    const sourcePath = `.product-experience/pdp-3-product-experience/grpc/operations/${name}`;
    const source = readYaml(sourcePath);
    return {
      channel: 'gRPC', id: source.operationId, sourcePath,
      identity: source.protocolIdentity,
      requestTypes: [{ protobufMessage: source.request?.protobufMessage, schemaRef: source.request?.schemaRef }],
      responseTypes: [{ protobufMessage: source.response?.protobufMessage, schemaRef: source.response?.schemaRef }],
      sourceComplete: false,
    };
  });
  const sdkRecord = readYaml('.product-experience/pdp-3-product-experience/sdk/operation-registry.yaml');
  const sdk = sdkRecord.methods.map((source) => ({
    channel: 'SDK', id: source.id,
    sourcePath: source.source,
    identity: { method: source.method, declaringClass: source.declaringClass },
    requestTypes: [{ sourceMethod: `${source.source}#${source.declaringClass}.${source.method}:parameters` }],
    responseTypes: [{ sourceMethod: `${source.source}#${source.declaringClass}.${source.method}:return` }],
    sourceComplete: Boolean(source.boundedInterfaceDefinition || source.experienceBinding?.startsWith('SOURCE_COMPATIBLE_BUT_NOT_ADMITTED')),
  }));

  return [...http, ...grpc, ...sdk].map((record) => ({
    ...record,
    disposition: record.sourceComplete ? 'SOURCE_CONTRACT_PRESENT_RUNTIME_NOT_ADMITTED' : 'NOT_ADMITTED',
    fixture: {
      mode: 'definition-only',
      dispatch: 'forbidden',
      outcome: 'UNKNOWN',
      retry: 'same-identity-inspection-only; no-replay',
      assertsOnly: ['exact-source-identity', 'exact-request-response-type-references', 'non-admission', 'no-dispatch', 'unknown-outcome', 'no-replay'],
    },
  }));
}

const registry = buildFixtureRegistry();

test('P3-07 fixture registry covers every current HTTP, gRPC, and SDK source identity exactly once', () => {
  assert.equal(registry.filter((entry) => entry.channel === 'HTTP').length, 27);
  assert.equal(registry.filter((entry) => entry.channel === 'gRPC').length, 43);
  assert.equal(registry.filter((entry) => entry.channel === 'SDK').length, 33);
  assert.equal(new Set(registry.map(({ channel, id }) => `${channel}:${id}`)).size, 103);
  assert.equal(registry.filter((entry) => entry.channel === 'HTTP' && !entry.sourceComplete).length, 22);
  assert.equal(registry.filter((entry) => entry.channel === 'gRPC' && !entry.sourceComplete).length, 43);
  assert.equal(registry.filter((entry) => entry.channel === 'SDK' && !entry.sourceComplete).length, 26);
});

test('every definition-only fixture checks exact source types and remains non-dispatching, unknown, and non-replaying', () => {
  for (const entry of registry.filter((candidate) => !candidate.sourceComplete)) {
    assert.ok(entry.id, `${entry.channel} source identity`);
    assert.ok(fs.existsSync(path.join(root, entry.sourcePath)), `${entry.id} source file exists`);
    assert.ok(entry.identity && Object.keys(entry.identity).length, `${entry.id} identity`);
    assert.ok(entry.requestTypes.length && entry.requestTypes[0], `${entry.id} source request declaration`);
    assert.ok(entry.responseTypes.length && entry.responseTypes[0], `${entry.id} source response declaration`);
    assert.equal(entry.disposition, 'NOT_ADMITTED', `${entry.id} disposition`);
    assert.equal(entry.fixture.mode, 'definition-only');
    assert.equal(entry.fixture.dispatch, 'forbidden');
    assert.equal(entry.fixture.outcome, 'UNKNOWN');
    assert.match(entry.fixture.retry, /no-replay/);
  }
});

test('HTTP and gRPC fixtures retain exact schema references from their operation records', () => {
  for (const entry of registry.filter(({ channel }) => channel !== 'SDK')) {
    assert.ok(entry.sourcePath.endsWith('.yaml'));
    assert.ok(entry.requestTypes.length && entry.responseTypes.length, entry.id);
    if (entry.channel === 'HTTP') {
      assert.equal(entry.identity.protocol, 'HTTP');
      assert.ok(entry.identity.method && entry.identity.path && entry.identity.operationId);
    } else {
      assert.equal(entry.identity.protocol, 'gRPC');
      assert.ok(entry.identity.service && entry.identity.method);
      assert.ok(entry.requestTypes[0].schemaRef && entry.responseTypes[0].schemaRef);
    }
  }
  const sdkSourceFiles = new Map();
  for (const entry of registry.filter(({ channel }) => channel === 'SDK')) {
    let sourceText = sdkSourceFiles.get(entry.sourcePath);
    if (!sourceText) {
      sourceText = fs.readFileSync(path.join(root, entry.sourcePath), 'utf8');
      sdkSourceFiles.set(entry.sourcePath, sourceText);
    }
    assert.ok(sourceText.includes(entry.identity.method), `${entry.id} source member exists`);
  }
});
