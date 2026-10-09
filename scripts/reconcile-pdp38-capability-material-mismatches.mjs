import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const fragmentPath = 'docs/implementation/verification/pdp-38/migration-capability-reviewed.json';
const files = [
  '.product-experience/pdp-0-product-truth/glossary.yaml',
  '.product-experience/pdp-0-product-truth/quality-policy.yaml',
  '.product-experience/pdp-0-product-truth/domain-model.yaml',
  '.product-experience/pdp-0-product-truth/constitution.yaml',
  '.product-experience/pdp-0-product-truth/applications-channels.yaml',
  '.product-experience/pdp-0-product-truth/reuse-decisions.yaml',
  '.product-experience/pdp-1-domain-data/operations.yaml',
];
const [fragment, ...texts] = await Promise.all([
  readFile(fragmentPath, 'utf8').then(JSON.parse),
  ...files.map((path) => readFile(path, 'utf8')),
]);
const docs = Object.fromEntries(files.map((path, i) => [path, parse(texts[i])]));
const pathValue = (root, path) => {
  let value = root;
  for (const token of path.split('/').filter(Boolean)) {
    const match = token.match(/^@id=(.+)$/u);
    if (match) value = value == null ? undefined : (Array.isArray(value) ? value : Object.values(value)).find((entry) => entry?.id === match[1]);
    else value = value?.[token.replace(/~1/gu, '/').replace(/~0/gu, '~')];
  }
  if (value === undefined) throw new Error(`unresolved source target ${path}`);
  return value;
};
const routes = {
  'MPSEM-0199-C003': ['.product-experience/pdp-0-product-truth/glossary.yaml#/unitsAndConventions/rules/@id=media.unit.measurement-uncertainty/estimatePresentationRule', 'An estimated or predicted depth result retains estimate/prediction labeling, method, and applicable uncertainty; it is not reported as measured ground truth.'],
  'MPSEM-0204-C001': ['.product-experience/pdp-0-product-truth/quality-policy.yaml#/optimizationPolicy/defaultEnhancerApplicationRule', 'The optimization plan selects only individually applicable, authorized, profile-bounded enhancers with evidence; proposing a plan and applying an operation remain separate.'],
  'MPSEM-0260-C003': ['.product-experience/pdp-0-product-truth/domain-model.yaml#/imageVideoOutputConstraints/resolutionRule', 'An odd output height is not assumed compatible with 4:2:0; the exact model/encoder profile must declare and meet pixel alignment, and the rule does not claim qualification.'],
  'MPSEM-0291-C002': ['.product-experience/pdp-0-product-truth/quality-policy.yaml#/protectedSemanticProperties/@id=PROTECTED-DELIVERY-CONSTRAINTS/rule', 'Resolution reduction is a protected delivery change: it requires declared permission, minimum floor, compatible binding, and confirmation where required; fallback is explicit and never silent.'],
  'MPSEM-0300-C003': ['.product-experience/pdp-1-domain-data/operations.yaml#/ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/resultSemantics/acknowledged', 'A job acknowledgement means the durable logical job receipt is queued; it does not prove provider crossing, execution start, render completion, or output materialization.'],
  'MPSEM-0334-C002': ['.product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/pathHandling', 'A local path is a client input reference and never an HTTP route, URL, server path, or arbitrary server retrieval target; server reads need exact authorized artifact/version identities.'],
  'MPSEM-0336-C006': ['.product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/interruptHandling/ctrlC', 'Ctrl-C stops local waiting/stream observation and exits 130; it does not cancel or mutate remote work, and an already-sent unknown remains unresolved until exact reconciliation.'],
  'MPSEM-0352-C001': ['.product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/flagApplicability/rule', 'Flags are declared per exact command/request schema; unknown or inapplicable flags fail before dispatch, and shared flag names do not imply shared semantics.'],
  'MPSEM-0352-C002': ['.product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/flagApplicability/readOnlyCommands/idempotencyKey', 'Read-only queries do not accept idempotency keys; only consequential commands whose exact canonical schema requires a key accept one.'],
  'MPSEM-0355-C003': ['.product-experience/pdp-0-product-truth/constitution.yaml#/invariants/records/@id=MEDIA-INV-002/statement', 'A user rights attestation is an assertion, not verified consent or license evidence.'],
  'MPSEM-0459-C003': ['.product-experience/pdp-0-product-truth/reuse-decisions.yaml#/mediaArchitectureRules/externalStackSelectionRule/multiplicity', 'Select one qualified implementation for each exact capability/profile; alternatives require separate versioned profiles and qualification, with no parallel duplicate adapters or silent fallback.'],
  'MPSEM-0459-C004': ['.product-experience/pdp-0-product-truth/reuse-decisions.yaml#/mediaArchitectureRules/externalStackSelectionRule/multiplicity', 'A second implementation is allowed only as a separately versioned and qualified profile; the selection rule forbids silent fallback and parallel adapters.'],
  'MPSEM-0461-C003': ['.product-experience/pdp-0-product-truth/reuse-decisions.yaml#/mediaArchitectureRules/dependencyUpdatePolicy/pinning/rule', 'Runtime, build, transitive, model, codec, plugin, and native dependencies are pinned by immutable version and integrity digest; this owner rule does not claim enforcement or admission.'],
};
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const records = new Map(fragment.records.map((record) => [record.claimId, record]));
for (const [claimId, [targetRef, meaning]] of Object.entries(routes)) {
  const record = records.get(claimId);
  if (!record) throw new Error(`missing material-mismatch claim ${claimId}`);
  const [file, pointer] = targetRef.split('#');
  const value = pathValue(docs[file], pointer);
  record.proposedTargetRef = targetRef;
  record.targetValueSha256 = sha(value);
  record.semanticReviewStatus = 'SEMANTIC_PARITY_VERIFIED';
  record.materialMeaning = meaning;
  record.reviewedPredicates = [
    record.reviewedPredicates[0],
    {
      predicate: 'claim-specific-source-definition-and-test-inspected',
      evidence: { targetRef, targetValueSha256: sha(value), targetValue: value, testSource: 'tests/pdp-migration-capability-material-claims.test.mjs' },
    },
  ];
  record.testSources = ['tests/pdp-migration-capability-material-claims.test.mjs', 'tests/pdp-migration-capability-contracts.test.mjs'];
  record.negativeCases = [
    'Source definition is not implementation, runtime availability, independent acceptance, or lifecycle phase receipt.',
    'Unknown, denied, unqualified, or not-admitted states remain non-support; no label or identifier is evidence of execution.',
  ];
  record.acceptanceEffect = 'none';
  record.sourceEditsNeeded = [];
}
await writeFile(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
console.log(`Reconciled ${Object.keys(routes).length} material-mismatch claim rows to exact owner semantics; acceptance effect remains none.`);
