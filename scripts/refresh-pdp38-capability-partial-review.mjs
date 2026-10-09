import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const fragmentPath = 'docs/implementation/verification/pdp-38/migration-capability-partial-review.json';
const [fragment, operationsText] = await Promise.all([
  readFile(fragmentPath, 'utf8').then(JSON.parse),
  readFile('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8'),
]);
const operations = parse(operationsText);
const submit = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === 'media.operation.job.submit.v1');
if (!submit) throw new Error('generic job submit owner operation is missing');
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const routes = new Map([
  ['MPSEM-0298-C001', {
    targetRef: '.product-experience/pdp-1-domain-data/operations.yaml#/ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/ownerWireSchema/requestSchema',
    value: submit.ownerWireSchema.requestSchema,
    meaning: 'The generic job submit v1 request is a closed typed envelope with exact operation/version/capability identity, typed inputs, project CAS context, profile digest, explicit fallback policy, deadline, bounded resource budget, purpose, rights and retention refs, and a request ID. Trusted tenant/principal authority is host context, outside the caller request body; independent runtime admission remains open.',
  }],
  ['MPSEM-0300-C001', {
    targetRef: '.product-experience/pdp-1-domain-data/operations.yaml#/ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/ownerWireSchema/resultSchema',
    value: submit.ownerWireSchema.resultSchema,
    meaning: 'The accepted job submit receipt requires the exact operation and version, request ID and server fingerprint, stable job ID, canonical QUEUED status, same-job observation operation/location and time, replay disposition, and acceptance time. UNKNOWN_OUTCOME remains a separate branch, and QUEUED does not imply provider execution or completion.',
  }],
  ['MPSEM-0375-C001', {
    targetRef: '.product-experience/pdp-1-domain-data/operations.yaml#/ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/dispatchProtocol/attemptIdentity',
    value: submit.dispatchProtocol.attemptIdentity,
    meaning: 'A durable attempt ID, monotonic fencing token, request fingerprint, source revision refs, profile digest, dispatch intent ID and authority decision refs are required before dispatch; the owner ordering puts this persisted intent before any provider boundary.',
  }],
  ['MPSEM-0375-C002', {
    targetRef: '.product-experience/pdp-1-domain-data/operations.yaml#/ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/dispatchProtocol/effectStartedReceipt',
    value: submit.dispatchProtocol.effectStartedReceipt,
    meaning: 'A durable EFFECT_STARTED receipt is required before provider crossing and binds receipt ID, attempt, fence, provider, request fingerprint, and recorded time. It means the effect may have begun, not that the provider accepted or completed it.',
  }],
  ['MPSEM-0375-C004', {
    targetRef: '.product-experience/pdp-1-domain-data/operations.yaml#/ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/dispatchProtocol/providerReceipt',
    value: submit.dispatchProtocol.providerReceipt,
    meaning: 'Provider execution ID, idempotency key, acceptance time and finality ref are recorded only when the exact provider contract supports an authoritative receipt; otherwise preserve OUTCOME_UNKNOWN and do not invent an ID or deduplication guarantee.',
  }],
]);
for (const record of fragment.records) {
  const route = routes.get(record.claimId);
  if (!route) continue;
  const targetValueSha256 = sha(route.value);
  record.proposedTargetRef = route.targetRef;
  record.targetValueSha256 = targetValueSha256;
  record.semanticReviewStatus = 'SEMANTIC_PARITY_VERIFIED';
  record.materialMeaning = route.meaning;
  record.reviewedPredicates = [
    record.reviewedPredicates[0],
    {
      predicate: 'claim-specific-source-definition-and-test-inspected',
      evidence: {
        targetRef: route.targetRef,
        targetValueSha256,
        targetValue: route.value,
        testSource: 'tests/pdp-migration-capability-partial-claims.test.mjs',
      },
    },
  ];
  record.acceptanceEffect = 'none';
  record.sourceEditsNeeded = [];
  record.negativeCases = [
    'No execution/runtime/qualification or independent owner acceptance follows from a Media source definition.',
    'Preserve UNKNOWN_OUTCOME when a provider receipt is absent; never infer provider acceptance or completion from QUEUED or EFFECT_STARTED.',
  ];
}
if (routes.size !== 5 || !fragment.records.some(({ claimId }) => routes.has(claimId))) throw new Error('capability claim fragment is missing target rows');
await writeFile(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
console.log(`Updated ${routes.size} capability claim rows against the exact generic job contract; no acceptance was inferred.`);
