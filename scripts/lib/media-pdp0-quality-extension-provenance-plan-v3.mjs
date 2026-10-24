import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.resolve(ROOT, '../ghatana-tools/package.json'));
const OBS = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const SUCCESSOR = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate-v2-provenance-successor.v3.json`;
const SUCCESSOR_SCHEMA = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate-v2-provenance-successor.v3.schema.json`;
const PREDECESSOR_FREEZE = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate-v2-freeze-manifest.v1.json`;
const CANDIDATE = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate.v2.json`;
const CANDIDATE_SCHEMA = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate.v2.schema.json`;
const RECEIPT = `${OBS}/AUD-SPEC-002-quality-extension-apply-hardening-implementation-receipt.v2.json`;
const RECEIPT_SCHEMA = `${OBS}/AUD-SPEC-002-quality-extension-apply-hardening-implementation-receipt.v2.schema.json`;
const PREDECESSOR_SUCCESSOR = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate-v2-provenance-successor.v2.json`;
const ADAPTER = 'scripts/lib/media-pdp0-quality-extension-source-adoption-v2.mjs';
const ADOPTION_TEST = 'tests/media-pdp0-quality-extension-source-adoption-v2.test.mjs';
const ADOPTION_PLANNER = 'scripts/plan-media-pdp0-quality-extension-source-adoption-v2.mjs';
const RESOLVER = 'scripts/lib/media-pdp0-quality-extension-provenance-plan-v3.mjs';
const RESOLVER_CLI = 'scripts/plan-media-pdp0-quality-extension-provenance-v3.mjs';
const RESOLVER_TEST = 'tests/media-pdp0-quality-extension-provenance-plan-v3.test.mjs';
const HASH = /^[a-f0-9]{64}$/u;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function fixedRead(ref) {
  if (typeof ref !== 'string' || !ref || path.isAbsolute(ref)) throw new Error(`invalid repository source reference: ${ref}`);
  const absolute = path.resolve(ROOT, ref);
  const relative = path.relative(ROOT, absolute);
  ensure(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `source reference escapes repository: ${ref}`);
  let current = fs.realpathSync(ROOT);
  ensure(current === ROOT, 'Media source root is not canonical');
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    ensure(!stat.isSymbolicLink(), `source reference contains a symbolic link: ${ref}`);
    if (index < parts.length - 1) ensure(stat.isDirectory(), `source parent is not a directory: ${ref}`);
    else ensure(stat.isFile(), `source reference is not a regular file: ${ref}`);
  }
  const bytes = fs.readFileSync(absolute);
  ensure(bytes.length <= 4 * 1024 * 1024, `source file exceeds the provenance-plan bound: ${ref}`);
  return bytes;
}

function readOptional(readSource, ref) {
  try { return readSource(ref); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

/**
 * Read-only validator for the additive provenance successor. The old candidate
 * freeze remains immutable; its producer-pin currentness is deliberately not
 * promoted by this record.
 */
export function planQualityExtensionProvenanceV3({readSource = fixedRead} = {}) {
  const blockers = [];
  const read = ref => readOptional(readSource, ref);
  const successorBytes = read(SUCCESSOR);
  if (!successorBytes) return {schemaVersion:'media.pdp0.quality-extension-provenance-plan.v3',
    planDisposition:'BLOCKED_PROVENANCE_SUCCESSOR_MISSING', blockers:['PROVENANCE_SUCCESSOR_V3_MISSING'], oldFreezeProducerPinsCurrentness:'NOT_CLAIMED'};

  const successorSchemaBytes = read(SUCCESSOR_SCHEMA);
  const predecessorBytes = read(PREDECESSOR_FREEZE);
  const predecessorSuccessorBytes = read(PREDECESSOR_SUCCESSOR);
  const candidateBytes = read(CANDIDATE);
  const candidateSchemaBytes = read(CANDIDATE_SCHEMA);
  const receiptBytes = read(RECEIPT);
  const receiptSchemaBytes = read(RECEIPT_SCHEMA);
  const successor = parse(successorBytes);
  const schema = parse(successorSchemaBytes);
  const Ajv2020 = require('ajv/dist/2020');
  ensure(successor.schemaRef === SUCCESSOR_SCHEMA && successor.schemaSha256 === sha(successorSchemaBytes),
    'quality provenance successor does not bind its exact schema bytes');
  ensure(new Ajv2020({strict:true}).compile(schema)(successor), 'quality provenance successor v3 is schema-invalid');
  ensure(successor.predecessorProvenanceSuccessor?.ref === PREDECESSOR_SUCCESSOR
    && successor.predecessorProvenanceSuccessor.sha256 === sha(predecessorSuccessorBytes),
  'quality provenance successor does not preserve the exact v2 provenance predecessor');

  const predecessor = parse(predecessorBytes);
  const candidate = parse(candidateBytes);
  const candidateSchema = parse(candidateSchemaBytes);
  ensure(new Ajv2020({strict:true}).compile(candidateSchema)(candidate), 'quality source candidate v2 is schema-invalid');
  ensure(successor.predecessorFreezeManifest?.ref === PREDECESSOR_FREEZE
    && successor.predecessorFreezeManifest.sha256 === sha(predecessorBytes), 'provenance successor does not bind the immutable predecessor freeze');
  ensure(successor.candidate?.ref === CANDIDATE && successor.candidate.sha256 === sha(candidateBytes)
    && successor.candidate.schemaRef === CANDIDATE_SCHEMA && successor.candidate.schemaSha256 === sha(candidateSchemaBytes),
  'provenance successor does not bind the frozen candidate and schema bytes');
  ensure(predecessor.candidateRef === CANDIDATE && predecessor.candidateSha256 === sha(candidateBytes)
    && predecessor.schemaRef === CANDIDATE_SCHEMA && predecessor.schemaSha256 === sha(candidateSchemaBytes),
  'predecessor freeze no longer matches the exact candidate cut');

  const expectedTargets = predecessor.targets.map(({targetRef,preimageSha256,postimageRef,postimageSha256}) =>
    ({targetRef,preimageSha256,postimageRef,postimageSha256}));
  ensure(same(successor.targetPostimages, expectedTargets), 'provenance successor changed the exact target order or postimage bindings');
  for (const row of successor.targetPostimages) {
    ensure(candidate.targets.some(target => target.targetRef === row.targetRef && target.preimageSha256 === row.preimageSha256
      && target.postimageRef === row.postimageRef && target.postimageSha256 === row.postimageSha256),
    `provenance successor target differs from the candidate: ${row.targetRef}`);
    ensure(sha(read(row.postimageRef) ?? Buffer.alloc(0)) === row.postimageSha256, `candidate postimage is stale: ${row.postimageRef}`);
  }

  const semanticPins = successor.semanticProducerPins;
  for (const [ref, expected] of Object.entries(semanticPins)) {
    ensure(HASH.test(expected) && sha(read(ref) ?? Buffer.alloc(0)) === expected, `semantic producer pin is stale: ${ref}`);
  }

  const receipt = parse(receiptBytes);
  const receiptSchema = parse(receiptSchemaBytes);
  ensure(new Ajv2020({strict:true}).compile(receiptSchema)(receipt), 'quality implementation receipt v2 is schema-invalid');
  const evidence = successor.implementationEvidence;
  ensure(evidence?.receiptRef === RECEIPT && evidence.receiptSha256 === sha(receiptBytes), 'provenance successor does not bind the current implementation receipt');
  ensure(evidence.receiptSchemaRef === RECEIPT_SCHEMA && evidence.receiptSchemaSha256 === sha(receiptSchemaBytes),
    'provenance successor does not bind the implementation receipt schema');
  ensure(evidence.adapterRef === ADAPTER && evidence.adapterSha256 === sha(read(ADAPTER) ?? Buffer.alloc(0))
    && evidence.testRef === ADOPTION_TEST && evidence.testSha256 === sha(read(ADOPTION_TEST) ?? Buffer.alloc(0)),
  'provenance successor does not bind the current adapter and focused test bytes');
  ensure(receipt.schemaVersion === 'media.pdp0.quality-extension-apply-hardening-implementation-receipt.v2'
    && receipt.sourceCandidate?.ref === CANDIDATE && receipt.sourceCandidate.sha256 === sha(candidateBytes)
    && receipt.sourceCandidate.freezeManifestRef === PREDECESSOR_FREEZE
    && receipt.sourceCandidate.freezeManifestSha256 === sha(predecessorBytes),
  'implementation receipt does not bind the exact unchanged candidate and predecessor freeze');
  ensure(same(receipt.sourceCandidate.candidatePostimages, successor.targetPostimages.map(row => ({ref:row.postimageRef,sha256:row.postimageSha256})))
    && receipt.implementation?.adapterRef === ADAPTER && receipt.implementation.adapterSha256 === evidence.adapterSha256
    && receipt.implementation.testRef === ADOPTION_TEST && receipt.implementation.testSha256 === evidence.testSha256,
  'implementation receipt does not bind the exact current adapter, tests, and two postimages');
  ensure(receipt.frozenProducerPinState?.oldFreezeManifestPreserved === true
    && receipt.frozenProducerPinState?.oldProducerPinsClaimedCurrent === false
    && successor.equivalence?.oldFreezeManifestCurrentness === 'NOT_CLAIMED'
    && successor.equivalence?.oldProducerPinsCurrentness === 'NOT_CLAIMED',
  'historic producer-pin currentness must remain explicitly unclaimed');

  const planning = successor.planningEvidence;
  ensure(planning?.provenanceResolverRef === RESOLVER && planning.provenanceResolverSha256 === sha(read(RESOLVER) ?? Buffer.alloc(0))
    && planning.provenancePlanCliRef === RESOLVER_CLI && planning.provenancePlanCliSha256 === sha(read(RESOLVER_CLI) ?? Buffer.alloc(0))
    && planning.adoptionPlannerRef === ADOPTION_PLANNER && planning.adoptionPlannerSha256 === sha(read(ADOPTION_PLANNER) ?? Buffer.alloc(0))
    && planning.resolverTestRef === RESOLVER_TEST && planning.resolverTestSha256 === sha(read(RESOLVER_TEST) ?? Buffer.alloc(0)),
  'provenance successor does not bind the current provenance resolver, adoption planner, and resolver tests');

  const currentPlan = {
    schemaVersion:'media.pdp0.quality-extension-provenance-plan.v3',
    planDisposition:blockers.length ? 'BLOCKED_PROVENANCE_EVIDENCE_STALE' : 'CURRENT_PROVENANCE_EVIDENCE_VALIDATED',
    successorRef:SUCCESSOR, successorSha256:sha(successorBytes), predecessorFreezeManifestRef:PREDECESSOR_FREEZE,
    predecessorFreezeManifestSha256:sha(predecessorBytes), candidateRef:CANDIDATE, candidateSha256:sha(candidateBytes),
    targets:successor.targetPostimages.map(row => ({targetRef:row.targetRef,preimageSha256:row.preimageSha256,postimageRef:row.postimageRef,postimageSha256:row.postimageSha256})),
    semanticProducerPins:Object.fromEntries(Object.entries(semanticPins).map(([ref]) => [ref,sha(read(ref))])),
    implementationEvidence:{receiptRef:RECEIPT,receiptSha256:sha(receiptBytes),adapterRef:ADAPTER,adapterSha256:sha(read(ADAPTER)),testRef:ADOPTION_TEST,testSha256:sha(read(ADOPTION_TEST))},
    planningEvidence:{provenanceResolverRef:RESOLVER,provenanceResolverSha256:sha(read(RESOLVER)),
      provenancePlanCliRef:RESOLVER_CLI,provenancePlanCliSha256:sha(read(RESOLVER_CLI)),
      adoptionPlannerRef:ADOPTION_PLANNER,adoptionPlannerSha256:sha(read(ADOPTION_PLANNER)),resolverTestRef:RESOLVER_TEST,resolverTestSha256:sha(read(RESOLVER_TEST))},
    oldFreezeManifestCurrentness:'NOT_CLAIMED',oldProducerPinsCurrentness:'NOT_CLAIMED',canonicalApply:'NOT_PERFORMED',sourceCurrentness:'NOT_CLAIMED',
    independentAcceptance:'NOT_CLAIMED',nativeProof:'NOT_CLAIMED',blockers,
  };
  return {plan:currentPlan,successor,predecessor,candidate,receipt};
}
