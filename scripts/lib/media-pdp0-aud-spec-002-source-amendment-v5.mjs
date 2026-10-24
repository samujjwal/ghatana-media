import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = createRequire(path.resolve(ROOT, '../ghatana-tools/package.json'))('yaml');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const FOLDER = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const DECISION_REF = '.product-experience/decision-log.md#PXD-226';
const ROOT_DECISION_REF = 'ghatana-lifecycle:docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-version-population-root-decision.json';
const CAP_PATH = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const REQ_PATH = '.product-experience/pdp-0-product-truth/requirements.yaml';
const CROSSWALK_PATH = `${FOLDER}/pdp0-501-disposition-crosswalk.json`;
const REVIEW_PATH = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';
const CAMPAIGN_PATH = '.product-experience/pdp-0-product-truth/campaign-extensions.yaml';
const LOG_PATH = '.product-experience/decision-log.md';
const CAPABILITY_ID = 'media.recipe.specification.compile';
const HISTORICAL_BASE_COUNT = 462;
const CURRENT_EXTENSION_COUNT = 1;
const FUTURE_PROPOSAL_COUNT = 6;
const CURRENT_VERSION_COUNT = HISTORICAL_BASE_COUNT + CURRENT_EXTENSION_COUNT;
const DEFINITION_EXTENSION_COUNT = CURRENT_EXTENSION_COUNT + FUTURE_PROPOSAL_COUNT;
const TOTAL_SOURCE_DEFINITIONS = HISTORICAL_BASE_COUNT + DEFINITION_EXTENSION_COUNT;

function ensure(condition, message) { if (!condition) throw new Error(message); }
function one(rows, predicate, label) {
  const found = rows.filter(predicate);
  ensure(found.length === 1, `expected one ${label}, found ${found.length}`);
  return found[0];
}
function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  ensure(start >= 0 && end > start, `missing or reordered source section ${startMarker}`);
  return source.slice(start, end);
}
function parseFrozenRecord(source, startMarker, endMarker, recordMarker) {
  const selectedSection = section(source, startMarker, endMarker);
  const start = selectedSection.indexOf(recordMarker);
  ensure(start >= 0, `missing frozen record ${recordMarker}`);
  const tail = selectedSection.slice(start);
  const boundaries = ['\n    - id:', '\n    - capabilityRef:', '\n  recordAuthority:', '\n  joinRule:']
    .map(marker => tail.indexOf(marker, 1)).filter(index => index >= 0);
  const next = boundaries.length ? Math.min(...boundaries) : -1;
  const block = next < 0 ? tail : tail.slice(0, next);
  const dedented = block.split('\n').map(line => line.startsWith('    ') ? line.slice(2) : line).join('\n');
  const parsed = yaml.parse(`records:\n${dedented}`);
  ensure(Array.isArray(parsed.records) && parsed.records.length === 1, `frozen record parse failed: ${recordMarker}`);
  return parsed.records[0];
}
function schemaHash() { return {type: 'string', pattern: '^[a-f0-9]{64}$'}; }
function targetSchema(ref) {
  return {type: 'object', additionalProperties: false, required: ['targetRef', 'preimageSha256', 'postimageSha256'], properties: {
    targetRef: {const: ref}, preimageSha256: schemaHash(), postimageSha256: schemaHash(),
  }};
}

function makeDecisionSection(rootDecisionSha256) {
  return `\n### PXD-226 — Select the AUD-SPEC-002 schema-migration extension for the current PDP-0 version\n\n`+
`**Authority:** This bounded PDP-0 source-owner decision follows the user-delegated technical source-owner authority recorded in ${ROOT_DECISION_REF} (SHA-256 \`${rootDecisionSha256}\`). It is a source-definition disposition only; it is not independent acceptance or an external product-owner decision.\n\n`+
`**Decision:** Supersede PXD-220 only for \`${CAPABILITY_ID}\`. Retain its existing compilation meaning and add the explicitly bounded schema-migration candidate meaning in this source cycle. The other six PXD-220/PXD-221 extensions remain future-version proposals.\n\n`+
`**Current meaning:** Ordinary compilation continues to require its normalized semantic graph and reviewable project-plan candidate; it does not require or emit a migration candidate. For an explicitly selected schema-migration intent with exact versioned source specification/schema, exact requested target schema, exact declared supported transformation, and exact compiler-contract version, produce the reviewable version-bound migration candidate and semantic diff alongside the ordinary compile output. Preserve the original source. Bind source, target, transformation, compiler-contract identities and versions, method, provenance, and limits. This is a reviewable specification candidate, not an applied migration or media artifact.\n\n`+
`**Fail-closed cases:** Missing, stale, unsupported, lossy, ambiguous, or unknown inputs produce UNKNOWN/UNSUPPORTED or a typed rejection with no migration candidate. Do not infer or substitute schemas or transformations, apply a migration, mutate a project, submit a job, publish content, or cause an external effect.\n\n`+
`**Population and preservation:** Keep the 462 historical owner-adjudication and trust records unchanged and in order. Track the current version as a typed 462 historical base plus this one current extension (463 total); track the remaining six extension identities as future proposals (six); retain all seven extension identities and all 469 source capability definitions. The new extension receives separate owner-adjudication and trust rows; it is not inserted into either historical 462-row array. PXD-207 continues to own the exact channel/surface applicability decision.\n\n`+
`**Applicability and downstream limits:** The capability is definition-current for this proposed version only. Quality applicability is UNKNOWN pending a separate source-bound quality review; the historical 462-leaf quality review is not extended by this decision. The historical PDP-1 operation/handoff population remains 462; this decision does not create a PDP-1 operation contract, interface binding, implementation, runtime admission, or proof. No applicability, quality, P1, currentness, phase status, owner acceptance, independent acceptance, native closure, release, or runtime outcome may be inferred beyond the exact source rows proposed here.\n\n`+
`**Effect:** Source authoring and deterministic local validation only. Canonical source apply remains pending exact review and authorization. PDP-0 status is unchanged; independent acceptance and native proof are not claimed.\n`;
}

function makeSourceAmendmentSchema() {
  const hash = schemaHash();
  const target = ref => targetSchema(ref);
  const targetRefs = [CAP_PATH, REQ_PATH, CROSSWALK_PATH, REVIEW_PATH, CAMPAIGN_PATH, LOG_PATH];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'media.pdp0.aud-spec-002-source-amendment-postimage.v5',
    type: 'object', additionalProperties: false,
    required: ['schemaVersion','artifactKind','predecessorV4','sourceBindings','versionPopulation','meaning','applicability','postimageSha256','exactTargets','preservation','authorityBoundary'],
    properties: {
      schemaVersion: {const: 'media.pdp0.aud-spec-002-source-amendment-postimage.v5'},
      artifactKind: {const: 'NON_CANONICAL_SIX_SOURCE_POSTIMAGE_PROPOSAL'},
      predecessorV4: {type: 'object', additionalProperties: false, required: ['ref','sha256','immutable'], properties: {
        ref: {const: `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v4.json`}, sha256: hash, immutable: {const: true},
      }},
      sourceBindings: {type: 'object', additionalProperties: false,
        required: ['rootDecisionSha256','capabilitiesSha256','requirementsSha256','crosswalkSha256','capabilityLeafReviewSha256','campaignExtensionsSha256','applicationsChannelsSha256','auditSha256','decisionLogSha256'],
        properties: Object.fromEntries(['rootDecisionSha256','capabilitiesSha256','requirementsSha256','crosswalkSha256','capabilityLeafReviewSha256','campaignExtensionsSha256','applicationsChannelsSha256','auditSha256','decisionLogSha256'].map(key => [key, hash]))},
      versionPopulation: {type: 'object', additionalProperties: false, required: ['historicalBaseCount','currentExtensionCount','futureProposalCount','currentVersionCount','totalExtensionCount','totalSourceDefinitionCount','currentExtensionIds','futureProposalIds'], properties: {
        historicalBaseCount: {const: HISTORICAL_BASE_COUNT}, currentExtensionCount: {const: CURRENT_EXTENSION_COUNT}, futureProposalCount: {const: FUTURE_PROPOSAL_COUNT},
        currentVersionCount: {const: CURRENT_VERSION_COUNT}, totalExtensionCount: {const: DEFINITION_EXTENSION_COUNT}, totalSourceDefinitionCount: {const: TOTAL_SOURCE_DEFINITIONS},
        currentExtensionIds: {const: [CAPABILITY_ID]}, futureProposalIds: {type: 'array', minItems: FUTURE_PROPOSAL_COUNT, maxItems: FUTURE_PROPOSAL_COUNT, uniqueItems: true, items: {type: 'string', minLength: 1}},
      }},
      meaning: {type: 'object', additionalProperties: false, required: ['ordinaryCompileCase','supportedMigrationCase','unsupportedMigrationCase','p1Boundary'], properties: {
        ordinaryCompileCase: {const: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-15'}, supportedMigrationCase: {const: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-16'}, unsupportedMigrationCase: {const: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-17'}, p1Boundary: {const: 'HISTORICAL_462_HANDOFF_RETAINED; no new P1 operation or runtime binding'},
      }},
      applicability: {type: 'object', additionalProperties: false, required: ['channelSource','channel','surfaceIdentityCount','phaseCellCount','qualityDisposition','qualityReviewRef','futureProposalCount'], properties: {
        channelSource: {const: '.product-experience/pdp-0-product-truth/applications-channels.yaml#coordinatorDefinitionExtensionApplicability/records/@capabilityRef=media.recipe.specification.compile'},
        channel: {const: 'media.channel.cli'}, surfaceIdentityCount: {const: 54}, phaseCellCount: {const: 216},
        qualityDisposition: {const: 'UNKNOWN_PENDING_SEPARATE_SOURCE_BOUND_QUALITY_REVIEW'}, qualityReviewRef: {const: 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json'}, futureProposalCount: {const: FUTURE_PROPOSAL_COUNT},
      }},
      postimageSha256: {type: 'object', additionalProperties: false, required: ['capabilitiesYaml','requirementsYaml','crosswalkJson','capabilityLeafReviewYaml','campaignExtensionsYaml','decisionLogMarkdown'], properties: Object.fromEntries(['capabilitiesYaml','requirementsYaml','crosswalkJson','capabilityLeafReviewYaml','campaignExtensionsYaml','decisionLogMarkdown'].map(key => [key, hash]))},
      exactTargets: {type: 'array', minItems: 6, maxItems: 6, prefixItems: targetRefs.map(target), items: false},
      preservation: {type: 'object', additionalProperties: false, required: ['historicalOwnerRows','historicalTrustRows','currentExtensionRows','futureExtensionIds','surfaceIdentityCount','phaseCellCount'], properties: {
        historicalOwnerRows: {const: '462_BYTE_PRESERVED_IN_ORDER'}, historicalTrustRows: {const: '462_BYTE_PRESERVED_IN_ORDER'}, currentExtensionRows: {const: 'SEPARATE_TYPED_OWNER_AND_TRUST_RECORDS; ONE'},
        futureExtensionIds: {const: 6}, surfaceIdentityCount: {const: 54}, phaseCellCount: {const: 216},
      }},
      authorityBoundary: {type: 'object', additionalProperties: false, required: ['sourceOwnerDecision','technicalPeer','canonicalApply','phaseStatus','sourceCurrentness','qualityApplicability','runtimeAdmission','independentAcceptance','nativeClosure','release'], properties: {
        sourceOwnerDecision: {const: 'STRUCTURED_ROOT_DECISION_BOUND; CANONICAL_PXD_ENTRY_PROPOSED'}, technicalPeer: {const: 'PENDING'}, canonicalApply: {const: 'NOT_PERFORMED'}, phaseStatus: {const: 'UNCHANGED'}, sourceCurrentness: {const: 'NOT_CLAIMED'},
        qualityApplicability: {const: 'UNKNOWN_PENDING_REVIEW'}, runtimeAdmission: {const: 'NOT_ADMITTED'}, independentAcceptance: {const: 'NOT_CLAIMED'}, nativeClosure: {const: 'NOT_CLAIMED'}, release: {const: 'NOT_AUTHORIZED'},
      }},
    },
  };
}

function makeCandidateSchema() {
  const hash = schemaHash();
  const refs = [CAP_PATH, REQ_PATH, CROSSWALK_PATH, REVIEW_PATH, CAMPAIGN_PATH, LOG_PATH];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'media.pdp0.aud-spec-002-source-amendment-candidate.v5',
    type: 'object', additionalProperties: false,
    required: ['schemaVersion','artifactKind','auditId','predecessorCandidateRef','predecessorCandidateSha256','rootDecisionRef','sourceBindings','population','exactFileTargets','postimageSha256','candidatePostimageSha256','blockers','canonicalApply','effects'],
    properties: {
      schemaVersion: {const: 'media.pdp0.aud-spec-002-source-amendment-candidate.v5'}, artifactKind: {const: 'NON_CANONICAL_EXACT_SOURCE_AMENDMENT_CANDIDATE'}, auditId: {const: 'AUD-SPEC-002'},
      predecessorCandidateRef: {const: `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v4.json`}, predecessorCandidateSha256: hash,
      rootDecisionRef: {const: ROOT_DECISION_REF}, sourceBindings: {type: 'object', additionalProperties: false, required: ['rootDecisionSha256','capabilitiesSha256','requirementsSha256','crosswalkSha256','capabilityLeafReviewSha256','campaignExtensionsSha256','applicationsChannelsSha256','auditSha256','decisionLogSha256'], properties: Object.fromEntries(['rootDecisionSha256','capabilitiesSha256','requirementsSha256','crosswalkSha256','capabilityLeafReviewSha256','campaignExtensionsSha256','applicationsChannelsSha256','auditSha256','decisionLogSha256'].map(key => [key, hash]))},
      population: {type: 'object', additionalProperties: false, required: ['historicalBase','currentExtension','futureProposals','currentVersionTotal','allDefinitions','surfaceIdentityCount','phaseCellCount'], properties: {
        historicalBase: {const: HISTORICAL_BASE_COUNT}, currentExtension: {const: CURRENT_EXTENSION_COUNT}, futureProposals: {const: FUTURE_PROPOSAL_COUNT}, currentVersionTotal: {const: CURRENT_VERSION_COUNT}, allDefinitions: {const: TOTAL_SOURCE_DEFINITIONS}, surfaceIdentityCount: {const: 54}, phaseCellCount: {const: 216},
      }},
      exactFileTargets: {type: 'array', minItems: 6, maxItems: 6, prefixItems: refs.map(targetSchema), items: false},
      postimageSha256: {type: 'object', additionalProperties: false, required: ['capabilitiesYaml','requirementsYaml','crosswalkJson','capabilityLeafReviewYaml','campaignExtensionsYaml','decisionLogMarkdown'], properties: Object.fromEntries(['capabilitiesYaml','requirementsYaml','crosswalkJson','capabilityLeafReviewYaml','campaignExtensionsYaml','decisionLogMarkdown'].map(key => [key, hash]))},
      candidatePostimageSha256: hash, blockers: {type: 'array', minItems: 2, items: {type: 'string'}}, canonicalApply: {const: 'NOT_PERFORMED'},
      effects: {type: 'object', additionalProperties: false, required: ['sourceWrite','phaseStatus','sourceCurrentness','qualityApplicability','runtimeAdmission','independentAcceptance','nativeClosure','release'], properties: {
        sourceWrite: {const: 'NOT_PERFORMED'}, phaseStatus: {const: 'UNCHANGED'}, sourceCurrentness: {const: 'NOT_CLAIMED'}, qualityApplicability: {const: 'UNKNOWN_PENDING_REVIEW'}, runtimeAdmission: {const: 'NOT_ADMITTED'}, independentAcceptance: {const: 'NOT_CLAIMED'}, nativeClosure: {const: 'NOT_CLAIMED'}, release: {const: 'NOT_AUTHORIZED'},
      }},
    },
  };
}

function loadFrozenV4(inputs) {
  const candidate = JSON.parse(inputs.observedV4CandidateBytes.toString('utf8'));
  const manifest = JSON.parse(inputs.v4FreezeManifestBytes.toString('utf8'));
  ensure(candidate.schemaVersion === 'media.pdp0.aud-spec-002-source-amendment-candidate.v4'
      && candidate.auditId === 'AUD-SPEC-002' && candidate.canonicalApply === 'NOT_PERFORMED'
      && sha(inputs.observedV4CandidateBytes) === manifest.candidateSha256
      && candidate.candidatePostimageSha256 === manifest.candidatePostimageSha256,
  'the immutable v4 source proposal is absent or malformed');
  const expectedPins = new Map(candidate.exactFileTargets.map(row => [row.targetRef, row.postimageSha256]));
  const postimages = inputs.frozenV4PostimageBytes;
  const v4Paths = [CAP_PATH, REQ_PATH, CROSSWALK_PATH, REVIEW_PATH];
  for (const ref of v4Paths) {
    ensure(Buffer.isBuffer(postimages?.[ref]) && expectedPins.get(ref) === sha(postimages[ref]), `frozen v4 postimage is missing or does not match its pin: ${ref}`);
  }
  const amendmentBytes = inputs.frozenV4SourceAmendmentBytes;
  ensure(Buffer.isBuffer(amendmentBytes) && sha(amendmentBytes) === manifest.sourceAmendmentSha256,
    'frozen v4 source-amendment body is missing or does not match candidate pin');
  const amendment = JSON.parse(amendmentBytes.toString('utf8'));
  const reviewText = postimages[REVIEW_PATH].toString('utf8');
  const proposedAdjudication = parseFrozenRecord(reviewText, 'ownerCapabilityLeafAdjudication:\n', 'currentOwnerDefinitionCensus:\n', '    - capabilityRef: media.recipe.specification.compile');
  const proposedTrust = parseFrozenRecord(reviewText, 'ownerTrustReconstructionDispositions:\n', 'pdp0ToPdp1ConsumerHandoff:\n', '    - id: media.capability-trust-reconstruction.media-capability-adjudication-recipe-specification-compile.v1');
  return {candidate, sourceAmendment: amendment, postimages, proposedAdjudication, proposedTrust};
}

function makePopulationPostimage(v4, inputs) {
  const campaign = yaml.parse(inputs.campaignExtensionsBytes.toString('utf8'));
  const pop = campaign.currentDefinitionPopulation;
  const version = pop.versionDisposition;
  const currentFuture = version.futureVersionProposals.filter(row => row.capabilityId !== CAPABILITY_ID);
  ensure(currentFuture.length === FUTURE_PROPOSAL_COUNT, 'expected six future proposals after selecting compile into current version');
  ensure(version.currentVersionExtensionCapabilityIds.length === 0, 'source version partition already changed; v5 predecessor is stale');
  version.decisionRefs = [
    '.product-experience/decision-log.md#PXD-220',
    '.product-experience/decision-log.md#PXD-221',
    DECISION_REF,
  ];
  version.historicalCanonicalCapabilityLeaves = HISTORICAL_BASE_COUNT;
  version.currentVersionCapabilityLeaves = CURRENT_VERSION_COUNT;
  version.futureVersionProposalCapabilityLeaves = FUTURE_PROPOSAL_COUNT;
  version.totalSourceCapabilityDefinitions = TOTAL_SOURCE_DEFINITIONS;
  version.currentVersionExtensionCapabilityIds = [CAPABILITY_ID];
  version.futureVersionProposals = currentFuture;
  version.futureVersionProposals.forEach(row => { row.decisionRef = row.decisionRef; });
  pop.extensionDisposition = 'ONE_CURRENT_VERSION_EXTENSION_AND_SIX_FUTURE_VERSION_PROPOSALS; ALL_SEVEN_EXTENSION_IDENTITIES_RETAINED; INDEPENDENT_ACCEPTANCE_NOT_CLAIMED';
  pop.meaning = 'The 462 historical owner-adjudicated capability leaves remain the preserved base. One source extension, media.recipe.specification.compile, is selected for this current version by PXD-226; six existing extension identities remain future-version proposals. The seven extension definitions and all 469 capability definitions remain in the source catalog. This version classification is not implementation, runtime, independent acceptance, or phase status.';
  pop.currentVersionPopulation = {
    historicalBaseCapabilityLeaves: HISTORICAL_BASE_COUNT,
    currentVersionExtensionCapabilityLeaves: CURRENT_EXTENSION_COUNT,
    currentVersionCapabilityLeaves: CURRENT_VERSION_COUNT,
    currentVersionExtensionCapabilityIds: [CAPABILITY_ID],
    futureVersionProposalCapabilityLeaves: FUTURE_PROPOSAL_COUNT,
    totalDefinitionExtensionCapabilityLeaves: DEFINITION_EXTENSION_COUNT,
    totalSourceCapabilityDefinitions: TOTAL_SOURCE_DEFINITIONS,
    ownerRows: 'historical owner adjudications remain 462; current extension adjudication is separate and additive',
    trustRows: 'historical trust dispositions remain 462; current extension trust record is separate and additive',
    qualityApplicability: 'UNKNOWN_PENDING_SEPARATE_SOURCE_BOUND_QUALITY_REVIEW',
    downstreamPdp1: 'HISTORICAL_462_HANDOFF_RETAINED; current extension has no PDP-1 operation contract in this source cycle',
  };
  const futureIds = new Set(currentFuture.map(row => row.capabilityId));
  ensure(futureIds.size === FUTURE_PROPOSAL_COUNT && !futureIds.has(CAPABILITY_ID), 'current and future extension ID sets overlap');
  const postBytes = Buffer.from(`${yaml.stringify(campaign, {lineWidth: 0}).trimEnd()}\n`);
  return {campaign, bytes: postBytes, futureIds};
}

function makeReviewPostimage(v4, inputs, population) {
  const originalText = inputs.capabilityLeafReviewBytes.toString('utf8');
  const historicalOwnerBytes = Buffer.from(section(originalText, 'ownerCapabilityLeafAdjudication:\n', 'currentOwnerDefinitionCensus:\n'));
  const historicalTrustBytes = Buffer.from(section(originalText, 'ownerTrustReconstructionDispositions:\n', 'pdp0ToPdp1ConsumerHandoff:\n'));
  ensure((historicalOwnerBytes.toString('utf8').match(/^    - capabilityRef:/gmu) ?? []).length === HISTORICAL_BASE_COUNT, 'historical owner-adjudication population is not 462');
  ensure((historicalTrustBytes.toString('utf8').match(/^    - id:/gmu) ?? []).length === HISTORICAL_BASE_COUNT, 'historical trust population is not 462');
  const v4ReviewText = v4.postimages[REVIEW_PATH].toString('utf8');
  const v4OwnerSection = section(v4ReviewText, 'ownerCapabilityLeafAdjudication:\n', 'currentOwnerDefinitionCensus:\n');
  const v4TrustSection = section(v4ReviewText, 'ownerTrustReconstructionDispositions:\n', 'pdp0ToPdp1ConsumerHandoff:\n');
  const v4OwnerAppendAt = v4OwnerSection.indexOf('\n    - capabilityRef: media.recipe.specification.compile');
  const v4TrustAppendAt = v4TrustSection.indexOf('\n    - id: media.capability-trust-reconstruction.media-capability-adjudication-recipe-specification-compile.v1');
  ensure(v4OwnerAppendAt > 0 && v4TrustAppendAt > 0, 'v4 extension row markers are missing from frozen predecessor');

  const owner = structuredClone(v4.proposedAdjudication);
  owner.decisionRefs = [...new Set([...(owner.decisionRefs ?? []), DECISION_REF])];
  owner.sourceRefs = [...new Set([...(owner.sourceRefs ?? []), DECISION_REF])];
  owner.normativeMeaning = 'Current-version extension row selected by PXD-226 for the existing compile capability: ordinary compilation remains distinct; the exact supported schema-migration request yields a reviewable version-bound candidate and semantic diff, with fail-closed UNKNOWN/UNSUPPORTED behavior. This definition row does not establish quality applicability, a PDP-1 operation, implementation, runtime availability, independent acceptance, or phase completion.';
  owner.qualityApplicability = {status: 'UNKNOWN_PENDING_SEPARATE_SOURCE_BOUND_QUALITY_REVIEW', applicableQualityReviewRef: null, historicalReviewBoundary: 'PXD-225 quality review covers 462 historical leaves and explicitly excludes all seven extensions; no extension quality disposition is inferred.'};
  owner.downstreamPdp1Disposition = 'NO_CURRENT_PDP1_OPERATION_CONTRACT; HISTORICAL_HANDOFF_REMAINS_462';

  const trust = structuredClone(v4.proposedTrust);
  trust.sourceRefs = [...new Set([...(trust.sourceRefs ?? []), DECISION_REF])];
  trust.currentPopulationDisposition = 'CURRENT_VERSION_EXTENSION_SEPARATE_FROM_HISTORICAL_462';
  trust.qualityApplicability = 'UNKNOWN_PENDING_SEPARATE_SOURCE_BOUND_QUALITY_REVIEW';
  trust.downstreamPdp1Disposition = 'NO_CURRENT_PDP1_OPERATION_CONTRACT; HISTORICAL_HANDOFF_REMAINS_462';
  trust.population = {
    historicalBaseCount: HISTORICAL_BASE_COUNT,
    currentExtensionCount: CURRENT_EXTENSION_COUNT,
    futureExtensionCount: FUTURE_PROPOSAL_COUNT,
    currentVersionCount: CURRENT_VERSION_COUNT,
    trustRecordScope: 'one exact compile extension row; not part of historical trust population',
  };
  const extension = {
    schemaVersion: 'media.pdp0.current-version-extension-owner-and-trust.v1',
    sourceOwnerDecisionRef: DECISION_REF,
    sourceOwnerDecisionRootRef: ROOT_DECISION_REF,
    population: {
      historicalBaseCount: HISTORICAL_BASE_COUNT,
      currentVersionExtensionCount: CURRENT_EXTENSION_COUNT,
      futureVersionExtensionCount: FUTURE_PROPOSAL_COUNT,
      currentVersionTotal: CURRENT_VERSION_COUNT,
      allDefinitionExtensions: DEFINITION_EXTENSION_COUNT,
      totalCapabilityDefinitions: TOTAL_SOURCE_DEFINITIONS,
      surfaceIdentityCount: 54,
      phaseCellCount: 216,
    },
    ownerAdjudications: [owner],
    trustReconstructionDispositions: [trust],
    qualityApplicability: {
      status: 'UNKNOWN_PENDING_SEPARATE_SOURCE_BOUND_QUALITY_REVIEW',
      capabilityRef: CAPABILITY_ID,
      existingQualityReviewRef: 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json',
      existingQualityReviewCapabilityCount: HISTORICAL_BASE_COUNT,
      currentExtensionIncludedInExistingQualityReview: false,
      rationale: 'The existing quality review has 462 historical rows and expressly excludes all seven extensions. No applicability or exclusion is inferred for this now-current extension.',
      blocks: ['CURRENT_QUALITY_APPLICABILITY_AND_REVIEW_FOR_COMPILE_EXTENSION'],
    },
    downstreamPdp1: {
      status: 'NOT_DEFINED_IN_THIS_PDP0_SOURCE_CYCLE',
      historicalCapabilityOperationCount: HISTORICAL_BASE_COUNT,
      currentExtensionCapabilityRef: CAPABILITY_ID,
      operationContractRef: null,
      runtimeAdmission: 'NOT_ADMITTED',
      effect: 'NONE',
    },
    phaseStatusEffect: 'NONE',
    ownerAcceptance: 'NOT_CLAIMED',
    independentAcceptance: 'NOT_CLAIMED',
  };
  const appended = `\n\n# Current-version extension population is distinct from the immutable historical\n# 462-row adjudication and trust arrays above. The quality and PDP-1 boundaries\n# below intentionally remain unresolved where no current source decision exists.\n${yaml.stringify({currentVersionExtensionOwnerAndTrust: extension}, {lineWidth: 0}).trimEnd()}\n`;
  const bytes = Buffer.from(`${originalText.replace(/\n*$/u, '')}${appended}`);
  const postText = bytes.toString('utf8');
  ensure(Buffer.from(section(postText, 'ownerCapabilityLeafAdjudication:\n', 'currentOwnerDefinitionCensus:\n')).equals(historicalOwnerBytes), 'v5 changed historical owner array bytes');
  ensure(Buffer.from(section(postText, 'ownerTrustReconstructionDispositions:\n', 'pdp0ToPdp1ConsumerHandoff:\n')).equals(historicalTrustBytes), 'v5 changed historical trust array bytes');
  ensure(population.currentExtensionCount === CURRENT_EXTENSION_COUNT, 'bad extension population input');
  return {bytes, extension, owner, trust, historicalOwnerBytes, historicalTrustBytes};
}

function buildSourceAmendmentSchema(){ return makeSourceAmendmentSchema(); }

export function buildAudSpec002SourceAmendmentV5(inputs) {
  const v4 = loadFrozenV4(inputs);
  const rootDecision = JSON.parse(inputs.rootDecisionBytes.toString('utf8'));
  ensure(rootDecision.schemaVersion === 'gtool.critical.source-owner-material-decision.v1'
      && rootDecision.decisionId === 'MEDIA-PDP0-AUD-SPEC-002-VERSION-POPULATION-R01'
      && rootDecision.issuerIdentity === 'agent:/root'
      && rootDecision.issuerRole === 'USER_DELEGATED_PDP0_TECHNICAL_SOURCE_OWNER'
      && rootDecision.decision === 'SUPERSEDE_PXD220_FOR_THIS_EXACT_EXTENSION_THROUGH_AN_ADDITIVE_SOURCE_CYCLE'
      && rootDecision.permissionGranted === 'SOURCE_DEFINITION_AND_DETERMINISTIC_LOCAL_VALIDATION_ONLY'
      && rootDecision.canonicalApplyApproved === false && rootDecision.sourceDevCompleteClaimed === false,
  'root structured source decision is missing, stale, or grants effects outside its recorded scope');
  ensure(rootDecision.scope.currentVersionExtensionIds.length === CURRENT_EXTENSION_COUNT
      && rootDecision.scope.currentVersionExtensionIds[0] === CAPABILITY_ID
      && rootDecision.scope.remainingFutureExtensionCount === FUTURE_PROPOSAL_COUNT
      && rootDecision.scope.totalDeclaredExtensionCount === DEFINITION_EXTENSION_COUNT
      && rootDecision.scope.surfaceIdentities === 54 && rootDecision.scope.phaseCells === 216,
  'root structured source decision population scope does not match v5');
  const rootDecisionSha256 = sha(inputs.rootDecisionBytes);
  const decisionLogText = inputs.decisionLogBytes.toString('utf8');
  ensure(!decisionLogText.includes('### PXD-226 '), 'PXD-226 already exists; v5 source predecessor changed');
  const decisionLogPostimage = Buffer.from(`${decisionLogText.replace(/\n*$/u, '')}\n${makeDecisionSection(rootDecisionSha256)}`);
  const population = makePopulationPostimage(v4, inputs);
  const v4CapabilityText = v4.postimages[CAP_PATH].toString('utf8');
  const compileStart = v4CapabilityText.indexOf(`  - id: ${CAPABILITY_ID}\n`);
  const compileEnd = v4CapabilityText.indexOf('\n  - id:', compileStart + 1);
  ensure(compileStart >= 0 && compileEnd > compileStart, 'v4 compile capability block is missing or reordered');
  const compileBlock = v4CapabilityText.slice(compileStart, compileEnd);
  ensure((compileBlock.match(/^    scopeStatus: DEFERRED$/gmu) ?? []).length === 1, 'v4 compile extension scope changed unexpectedly');
  const capabilitiesPostimage = Buffer.from(`${v4CapabilityText.slice(0, compileStart)}${compileBlock.replace(/^    scopeStatus: DEFERRED$/mu, '    scopeStatus: TARGET')}${v4CapabilityText.slice(compileEnd)}`);

  const review = makeReviewPostimage(v4, inputs, {currentExtensionCount: CURRENT_EXTENSION_COUNT});
  const crosswalk = JSON.parse(v4.postimages[CROSSWALK_PATH].toString('utf8'));
  const crosswalkRow = one(crosswalk.rows, row => row.auditId === 'AUD-SPEC-002', 'AUD-SPEC-002 crosswalk row');
  crosswalkRow.pdp0EvidenceRefs = [...new Set([...(crosswalkRow.pdp0EvidenceRefs ?? []), DECISION_REF])];
  crosswalkRow.phaseLocalRationale += ' PXD-226 selects this one extension for the current PDP-0 version through an additive source cycle; the 462 historical base, one current extension, six future proposals, 54 surfaces, and 216 phase cells remain separately accounted. Quality applicability remains UNKNOWN, and the historical PDP-1 handoff remains 462.';
  const crosswalkPostimage = Buffer.from(`${JSON.stringify(crosswalk, null, 2)}\n`);

  const postimages = {
    [CAP_PATH]: capabilitiesPostimage,
    [REQ_PATH]: v4.postimages[REQ_PATH],
    [CROSSWALK_PATH]: crosswalkPostimage,
    [REVIEW_PATH]: review.bytes,
    [CAMPAIGN_PATH]: population.bytes,
    [LOG_PATH]: decisionLogPostimage,
  };
  const hashes = {
    capabilitiesYaml: sha(postimages[CAP_PATH]), requirementsYaml: sha(postimages[REQ_PATH]), crosswalkJson: sha(postimages[CROSSWALK_PATH]),
    capabilityLeafReviewYaml: sha(postimages[REVIEW_PATH]), campaignExtensionsYaml: sha(postimages[CAMPAIGN_PATH]), decisionLogMarkdown: sha(postimages[LOG_PATH]),
  };
  const targetRefs = [CAP_PATH, REQ_PATH, CROSSWALK_PATH, REVIEW_PATH, CAMPAIGN_PATH, LOG_PATH];
  const targetInput = new Map([
    [CAP_PATH, inputs.capabilitiesBytes], [REQ_PATH, inputs.requirementsBytes], [CROSSWALK_PATH, inputs.crosswalkBytes],
    [REVIEW_PATH, inputs.capabilityLeafReviewBytes], [CAMPAIGN_PATH, inputs.campaignExtensionsBytes], [LOG_PATH, inputs.decisionLogBytes],
  ]);
  const targetRows = targetRefs.map(targetRef => ({targetRef, preimageSha256: sha(targetInput.get(targetRef)), postimageSha256: sha(postimages[targetRef])}));
  const sourceBindings = {
    rootDecisionSha256,
    capabilitiesSha256: sha(inputs.capabilitiesBytes), requirementsSha256: sha(inputs.requirementsBytes), crosswalkSha256: sha(inputs.crosswalkBytes),
    capabilityLeafReviewSha256: sha(inputs.capabilityLeafReviewBytes), campaignExtensionsSha256: sha(inputs.campaignExtensionsBytes),
    applicationsChannelsSha256: sha(inputs.applicationsChannelsBytes), auditSha256: sha(inputs.auditBytes), decisionLogSha256: sha(inputs.decisionLogBytes),
  };
  const sourceAmendment = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-postimage.v5',
    artifactKind: 'NON_CANONICAL_SIX_SOURCE_POSTIMAGE_PROPOSAL',
    predecessorV4: {ref: `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v4.json`, sha256: sha(inputs.observedV4CandidateBytes), immutable: true},
    sourceBindings,
    versionPopulation: {
      historicalBaseCount: HISTORICAL_BASE_COUNT, currentExtensionCount: CURRENT_EXTENSION_COUNT, futureProposalCount: FUTURE_PROPOSAL_COUNT,
      currentVersionCount: CURRENT_VERSION_COUNT, totalExtensionCount: DEFINITION_EXTENSION_COUNT, totalSourceDefinitionCount: TOTAL_SOURCE_DEFINITIONS,
      currentExtensionIds: [CAPABILITY_ID], futureProposalIds: [...population.futureIds].sort(),
    },
    meaning: {ordinaryCompileCase: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-15', supportedMigrationCase: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-16', unsupportedMigrationCase: 'MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-17', p1Boundary: 'HISTORICAL_462_HANDOFF_RETAINED; no new P1 operation or runtime binding'},
    applicability: {channelSource: '.product-experience/pdp-0-product-truth/applications-channels.yaml#coordinatorDefinitionExtensionApplicability/records/@capabilityRef=media.recipe.specification.compile', channel: 'media.channel.cli', surfaceIdentityCount: 54, phaseCellCount: 216, qualityDisposition: 'UNKNOWN_PENDING_SEPARATE_SOURCE_BOUND_QUALITY_REVIEW', qualityReviewRef: 'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json', futureProposalCount: FUTURE_PROPOSAL_COUNT},
    postimageSha256: hashes,
    exactTargets: targetRows,
    preservation: {historicalOwnerRows: '462_BYTE_PRESERVED_IN_ORDER', historicalTrustRows: '462_BYTE_PRESERVED_IN_ORDER', currentExtensionRows: 'SEPARATE_TYPED_OWNER_AND_TRUST_RECORDS; ONE', futureExtensionIds: FUTURE_PROPOSAL_COUNT, surfaceIdentityCount: 54, phaseCellCount: 216},
    authorityBoundary: {sourceOwnerDecision: 'STRUCTURED_ROOT_DECISION_BOUND; CANONICAL_PXD_ENTRY_PROPOSED', technicalPeer: 'PENDING', canonicalApply: 'NOT_PERFORMED', phaseStatus: 'UNCHANGED', sourceCurrentness: 'NOT_CLAIMED', qualityApplicability: 'UNKNOWN_PENDING_REVIEW', runtimeAdmission: 'NOT_ADMITTED', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_CLAIMED', release: 'NOT_AUTHORIZED'},
  };
  const sourceAmendmentBytes = Buffer.from(`${JSON.stringify(sourceAmendment, null, 2)}\n`);
  const components = {...hashes, sourceAmendmentJson: sha(sourceAmendmentBytes)};
  const candidatePostimageSha256 = sha(Buffer.from(JSON.stringify(components)));
  const candidate = {
    schemaVersion: 'media.pdp0.aud-spec-002-source-amendment-candidate.v5', artifactKind: 'NON_CANONICAL_EXACT_SOURCE_AMENDMENT_CANDIDATE', auditId: 'AUD-SPEC-002',
    predecessorCandidateRef: `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v4.json`, predecessorCandidateSha256: sha(inputs.observedV4CandidateBytes), rootDecisionRef: ROOT_DECISION_REF,
    sourceBindings, population: {historicalBase: HISTORICAL_BASE_COUNT, currentExtension: CURRENT_EXTENSION_COUNT, futureProposals: FUTURE_PROPOSAL_COUNT, currentVersionTotal: CURRENT_VERSION_COUNT, allDefinitions: TOTAL_SOURCE_DEFINITIONS, surfaceIdentityCount: 54, phaseCellCount: 216},
    exactFileTargets: targetRows, postimageSha256: hashes, candidatePostimageSha256,
    blockers: ['DISTINCT_TECHNICAL_PEER_REVIEW_OF_THE_EXACT_V5_SIX_SOURCE_POSTIMAGE_REQUIRED', 'CURRENT_QUALITY_APPLICABILITY_REVIEW_REQUIRED_BEFORE_CURRENT_QUALITY_CLAIM', 'PDP1_OPERATION_CONTRACT_IS_NOT_DEFINED_BY_THIS_PDP0_SOURCE_CYCLE', 'CANONICAL_SOURCE_APPLY_REQUIRES_EXACT_ROOT_AUTHORIZATION'],
    canonicalApply: 'NOT_PERFORMED', effects: {sourceWrite: 'NOT_PERFORMED', phaseStatus: 'UNCHANGED', sourceCurrentness: 'NOT_CLAIMED', qualityApplicability: 'UNKNOWN_PENDING_REVIEW', runtimeAdmission: 'NOT_ADMITTED', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_CLAIMED', release: 'NOT_AUTHORIZED'},
  };
  return {candidate, sourceAmendment, sourceAmendmentBytes, postimages, hashes, components, candidateSchema: makeCandidateSchema(), sourceAmendmentSchema: buildSourceAmendmentSchema(), v4, review, population, rootDecisionSha256};
}

export const audSpec002V5Population = Object.freeze({historicalBase: HISTORICAL_BASE_COUNT, currentExtension: CURRENT_EXTENSION_COUNT, futureProposals: FUTURE_PROPOSAL_COUNT, currentVersionTotal: CURRENT_VERSION_COUNT, totalDefinitions: TOTAL_SOURCE_DEFINITIONS});
